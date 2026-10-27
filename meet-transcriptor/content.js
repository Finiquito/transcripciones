/**
 * content.js — Content script de https://meet.google.com/*
 *
 * Flujo:
 *  1. Un MutationObserver sobre el documento detecta cuándo aparece (o
 *     desaparece) el contenedor de subtítulos (selectors.js → captionsRegion).
 *  2. Un segundo MutationObserver, solo sobre ese contenedor, avisa cada vez
 *     que los subtítulos cambian.
 *  3. Cada bloque de hablante tiene un "estado". Como Meet reescribe el texto
 *     mientras la persona habla, NO se guarda en cada cambio: se guarda cuando
 *     el texto lleva `stabilizeMs` sin cambiar, cuando cambia el hablante del
 *     bloque o cuando Meet quita el bloque.
 *  4. Las intervenciones confirmadas se envían al service worker, que las
 *     guarda en IndexedDB.
 */
(() => {
  'use strict';

  // Evita doble inicialización si el script se inyecta dos veces.
  if (globalThis.__meetTranscriptorCargado) return;
  globalThis.__meetTranscriptorCargado = true;

  const SEL = globalThis.MT_SELECTORS;
  const DBG = globalThis.MT_DEBUG;

  // ── Configuración (se edita desde el side panel, vive en chrome.storage) ──
  const CONFIG_DEFECTO = { debug: false, hideCaptions: false, stabilizeMs: 1500 };
  let config = { ...CONFIG_DEFECTO };

  const RETARDO_PROCESO_MS = 120;   // agrupa ráfagas de mutaciones en una sola lectura
  const RETARDO_BUSQUEDA_MS = 400;  // idem para la búsqueda de la región
  const RED_SEGURIDAD_MS = 2000;    // búsqueda periódica por si el observer se pierde algo
  const ESTADO_CADA_MS = 5000;      // latido hacia el side panel

  const IGNORAR = SEL.ignore.join(',');

  let region = null;              // contenedor de subtítulos actual
  let observadorRegion = null;
  let tProceso = null;
  let tBusqueda = null;
  let contador = 0;
  let ultimaFirma = '';
  /** elemento-bloque → { clave, hablante, texto, confirmado, entradaId, hora, timer } */
  const estados = new Map();

  // ── Utilidades ────────────────────────────────────────────────────────

  /** Devuelve el primer elemento que matchee alguno de los selectores. */
  function primero(raiz, selectores) {
    for (const sel of selectores) {
      try {
        const el = raiz.querySelector(sel);
        if (el) return el;
      } catch (_) { /* selector inválido: se ignora */ }
    }
    return null;
  }

  /** Todos los elementos del primer selector de la lista que encuentre algo. */
  function todos(raiz, selectores) {
    for (const sel of selectores) {
      try {
        const lista = raiz.querySelectorAll(sel);
        if (lista.length) return [...lista];
      } catch (_) { /* selector inválido: se ignora */ }
    }
    return [];
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** Minúsculas, sin tildes ni puntuación: para comparar textos entre sí. */
  function normalizar(s) {
    return s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** ¿El nodo está dentro de un elemento a ignorar (botón, ícono...) sin salir de `raiz`? */
  function estaIgnorado(el, raiz) {
    for (let n = el; n; n = n.parentElement) {
      if (n.matches(IGNORAR)) return true;
      if (n === raiz) return false;
    }
    return false;
  }

  /**
   * Fragmentos de texto de un bloque, en orden de aparición, agrupados por
   * su elemento padre. Se leen los nodos de texto directamente (no innerText)
   * para que funcione igual aunque los subtítulos estén ocultos con CSS.
   */
  function fragmentos(raiz) {
    const walker = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
    const lista = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const padre = n.parentElement;
      if (!padre || !n.nodeValue.trim() || estaIgnorado(padre, raiz)) continue;
      const ultimo = lista[lista.length - 1];
      if (ultimo && ultimo.el === padre) ultimo.crudo += n.nodeValue;
      else lista.push({ el: padre, crudo: n.nodeValue, nodo: n });
    }
    return lista
      .map((f) => ({ ...f, texto: f.crudo.replace(/\s+/g, ' ').trim() }))
      .filter((f) => f.texto);
  }

  // ── Lectura del DOM de Meet ────────────────────────────────────────────

  /**
   * Localiza los bloques de hablante dentro de la región:
   *  1. selectors.block, si está definido;
   *  2. heurística por avatar: el ancestro más cercano a cada <img> que tenga texto;
   *  3. heurística por estructura: bajar por contenedores con un único hijo con
   *     texto y tomar los hijos con texto del primer nivel que se ramifique.
   */
  function encontrarBloques(raiz) {
    const explicitos = todos(raiz, SEL.block);
    if (explicitos.length) return explicitos;

    const porAvatar = new Set();
    for (const sel of SEL.avatar) {
      let imgs = [];
      try { imgs = raiz.querySelectorAll(sel); } catch (_) { /* inválido */ }
      for (const img of imgs) {
        for (let n = img.parentElement; n && n !== raiz; n = n.parentElement) {
          if (fragmentos(n).length) {
            porAvatar.add(n);
            break;
          }
        }
      }
    }
    if (porAvatar.size) return [...porAvatar];

    let nodo = raiz;
    for (;;) {
      const conTexto = [...nodo.children].filter((h) => fragmentos(h).length);
      if (conTexto.length !== 1) return conTexto;
      nodo = conTexto[0];
    }
  }

  /** Extrae { hablante, texto } de un bloque, o null si aún no hay texto. */
  function leerBloque(bloque) {
    const frags = fragmentos(bloque);
    if (!frags.length) return null;

    const elHablante = primero(bloque, SEL.speaker);
    const elTexto = primero(bloque, SEL.text);

    let hablante;
    let texto;
    if (elHablante) {
      hablante = elHablante.textContent.replace(/\s+/g, ' ').trim();
      texto = frags.filter((f) => !elHablante.contains(f.nodo)).map((f) => f.texto).join(' ');
    } else {
      // Heurística: el primer fragmento es el nombre y el resto es lo que dijo.
      hablante = frags[0].texto;
      texto = frags.slice(1).map((f) => f.texto).join(' ');
    }
    if (elTexto) texto = elTexto.textContent.replace(/\s+/g, ' ').trim();

    texto = texto.trim();
    if (!hablante || !texto) return null;
    return { hablante, texto };
  }

  // ── Estabilización y fusión ────────────────────────────────────────────

  /**
   * Decide cómo combinar el texto ya guardado de un bloque (`previo`) con el
   * que se ve ahora (`nuevo`):
   *  - 'reemplazar': el bloque creció o se corrigió → misma entrada, texto nuevo.
   *  - 'ignorar': Meet recortó el inicio y lo visible ya estaba guardado.
   *  - 'nueva': texto sin relación (el hablante siguió con otra frase).
   */
  function fusionar(previo, nuevo) {
    if (!previo) return { modo: 'nueva', texto: nuevo };

    const a = normalizar(previo);
    const b = normalizar(nuevo);
    if (b.startsWith(a)) return { modo: 'reemplazar', texto: nuevo };
    if (a.includes(b)) return { modo: 'ignorar' };

    // Meet recorta el inicio del bloque cuando es muy largo: si el final de lo
    // guardado coincide con el comienzo de lo nuevo, se concatena sin repetir.
    const pa = previo.split(/\s+/);
    const pn = nuevo.split(/\s+/);
    const na = pa.map(normalizar);
    const nn = pn.map(normalizar);
    for (let k = Math.min(na.length, nn.length); k >= 2; k--) {
      if (na.slice(-k).join(' ') === nn.slice(0, k).join(' ')) {
        return { modo: 'reemplazar', texto: [...pa, ...pn.slice(k)].join(' ') };
      }
    }
    return { modo: 'nueva', texto: nuevo };
  }

  function nuevoId() {
    return `${Date.now().toString(36)}-${(contador++).toString(36)}`;
  }

  /** Reunión según la URL actual: una por código y día. */
  function reunionActual() {
    // Si la URL no tiene el formato abc-defg-hij (apodos de reunión, etc.),
    // se usa el primer segmento de la ruta como código.
    const m = SEL.meetingCode.exec(location.pathname);
    const seg = location.pathname.split('/')[1] || '';
    const code = (m ? m[1] : seg.replace(/[^\w-]/g, '')).toLowerCase() || 'sin-codigo';
    const d = new Date();
    const dia = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return { id: `${code}_${dia}`, code };
  }

  /** Envía un mensaje a la extensión; tolera que el contexto haya sido invalidado. */
  function enviar(msg) {
    if (!chrome.runtime?.id) {
      detener(); // la extensión se recargó: este script quedó huérfano
      return;
    }
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (_) { /* contexto invalidado */ }
  }

  /** Texto "en vivo" (aún sin estabilizar) para mostrarlo en el side panel. */
  function enviarParcial(st, texto) {
    enviar({
      type: 'mt:partial',
      key: st.clave,
      meetingId: reunionActual().id,
      speaker: st.hablante,
      text: texto,
    });
  }

  /** Guarda la intervención de un bloque si su texto cambió desde la última vez. */
  function confirmar(st) {
    clearTimeout(st.timer);
    st.timer = null;

    const texto = st.texto.trim();
    if (!texto || texto === st.confirmado) return;

    const r = fusionar(st.confirmado, texto);
    if (r.modo === 'ignorar') return;

    if (r.modo === 'nueva') {
      // Primera entrada del bloque conserva su hora; las siguientes toman la actual.
      if (st.entradaId) st.hora = new Date().toISOString();
      st.entradaId = nuevoId();
    }
    st.confirmado = r.texto;

    const reunion = reunionActual();
    const entrada = { id: st.entradaId, speaker: st.hablante, text: r.texto, time: st.hora };
    DBG.log('intervención guardada', entrada);
    enviar({ type: 'mt:entry', meetingId: reunion.id, code: reunion.code, entry: entrada });
    enviarParcial(st, ''); // ya no es parcial: quita la fila "en vivo" del panel
  }

  /** Actualiza el estado de un bloque con lo último que se leyó. */
  function actualizarEstado(bloque, datos) {
    let st = estados.get(bloque);

    // Cambió el hablante dentro del mismo bloque: se cierra su intervención.
    if (st && st.hablante !== datos.hablante) {
      confirmar(st);
      enviarParcial(st, '');
      estados.delete(bloque);
      st = null;
    }
    if (!st) {
      st = {
        clave: nuevoId(),
        hablante: datos.hablante,
        texto: '',
        confirmado: '',
        entradaId: null,
        hora: new Date().toISOString(),
        timer: null,
      };
      estados.set(bloque, st);
    }

    if (datos.texto === st.texto) return;
    st.texto = datos.texto;
    DBG.log('bloque', datos.hablante, '→', datos.texto);
    enviarParcial(st, datos.texto);

    // Cada cambio reinicia la cuenta: solo se confirma cuando se estabiliza.
    clearTimeout(st.timer);
    st.timer = setTimeout(() => confirmar(st), config.stabilizeMs);
  }

  /** Lee todos los bloques de la región y reconcilia con los estados. */
  function procesarRegion() {
    tProceso = null;
    if (!region || !region.isConnected) return;

    const bloques = encontrarBloques(region);
    const vistos = new Set(bloques);
    for (const bloque of bloques) {
      const datos = leerBloque(bloque);
      if (datos) actualizarEstado(bloque, datos);
    }

    // Debug: avisa cuando cambia la cantidad de bloques/lecturas válidas.
    const firma = `${bloques.length}/${bloques.filter((b) => leerBloque(b)).length}`;
    if (firma !== ultimaFirma) {
      ultimaFirma = firma;
      DBG.log(`bloques encontrados: ${bloques.length}, con hablante y texto: ${firma.split('/')[1]}`, bloques);
      if (!bloques.length || firma.endsWith('/0')) DBG.volcar('Estructura de la región (no se pudo leer ningún bloque):', region);
    }

    // Bloques que Meet ya quitó: se confirma lo pendiente de inmediato.
    for (const [bloque, st] of estados) {
      if (!vistos.has(bloque) || !bloque.isConnected) {
        confirmar(st);
        enviarParcial(st, '');
        estados.delete(bloque);
      }
    }
  }

  function programarProceso() {
    if (!tProceso) tProceso = setTimeout(procesarRegion, RETARDO_PROCESO_MS);
  }

  /** Confirma todo lo pendiente (región perdida, cierre de pestaña...). */
  function vaciarTodo() {
    for (const st of estados.values()) {
      confirmar(st);
      enviarParcial(st, '');
    }
    estados.clear();
  }

  // ── Detección de la región de subtítulos ───────────────────────────────

  function buscarRegion() {
    tBusqueda = null;
    const nueva = primero(document, SEL.captionsRegion);
    if (nueva === region) return;

    if (region) {
      vaciarTodo();
      observadorRegion?.disconnect();
      observadorRegion = null;
    }
    region = nueva;

    if (region) {
      DBG.log('región de subtítulos detectada', region);
      observadorRegion = new MutationObserver(programarProceso);
      observadorRegion.observe(region, { childList: true, subtree: true, characterData: true });
      procesarRegion();
    } else {
      DBG.log('región de subtítulos perdida (¿CC desactivado?)');
    }
    enviarEstado();
  }

  function programarBusqueda() {
    if (!tBusqueda) tBusqueda = setTimeout(buscarRegion, RETARDO_BUSQUEDA_MS);
  }

  /** Latido: le dice al side panel si hay subtítulos detectados. */
  function enviarEstado() {
    enviar({ type: 'mt:status', regionFound: !!region, code: reunionActual().code });
  }

  // ── Configuración: ocultar subtítulos y modo debug ─────────────────────

  /**
   * Oculta los subtítulos SIN desactivarlos. Se usa opacity (no display ni
   * visibility) para que Meet siga actualizando el DOM y nosotros leyéndolo.
   * Las reglas se generan desde los mismos selectores de selectors.js: una
   * por selector, así uno inválido no invalida a los demás.
   */
  function inyectarEstiloOcultar() {
    const estilo = document.createElement('style');
    estilo.id = 'mt-estilo-ocultar';
    estilo.textContent = SEL.captionsRegion
      .map((sel) => `html[data-mt-ocultar] ${sel} { opacity: 0 !important; pointer-events: none !important; }`)
      .join('\n');
    document.documentElement.appendChild(estilo);
  }

  function aplicarConfig(nueva) {
    config = { ...CONFIG_DEFECTO, ...nueva };
    document.documentElement.toggleAttribute('data-mt-ocultar', !!config.hideCaptions);
    DBG.setEnabled(!!config.debug);
    if (config.debug && region) {
      ultimaFirma = '';
      DBG.volcar('Estructura de la región de subtítulos:', region);
      procesarRegion();
    }
  }

  // ── Ciclo de vida ──────────────────────────────────────────────────────

  let intervalos = [];
  let observadorDoc = null;

  function detener() {
    observadorDoc?.disconnect();
    observadorRegion?.disconnect();
    intervalos.forEach(clearInterval);
    intervalos = [];
  }

  function iniciar() {
    inyectarEstiloOcultar();

    chrome.storage.local.get('mtConfig').then((r) => aplicarConfig(r.mtConfig));
    chrome.storage.onChanged.addListener((cambios, area) => {
      if (area === 'local' && cambios.mtConfig) aplicarConfig(cambios.mtConfig.newValue);
    });

    // Vigila altas/bajas de nodos en toda la página para detectar la región.
    observadorDoc = new MutationObserver(programarBusqueda);
    observadorDoc.observe(document.documentElement, { childList: true, subtree: true });
    intervalos.push(setInterval(buscarRegion, RED_SEGURIDAD_MS));
    intervalos.push(setInterval(enviarEstado, ESTADO_CADA_MS));

    // Al cerrar o recargar la pestaña, guarda lo que quedara pendiente.
    addEventListener('pagehide', vaciarTodo);

    buscarRegion();
  }

  iniciar();
})();
