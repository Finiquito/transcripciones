/**
 * debug.js — Modo debug (content script, se carga antes de content.js).
 *
 * Cuando está activo, en la consola de la pestaña de Meet (F12 → Console):
 *  - Lista los nodos "candidatos" a ser el contenedor de subtítulos
 *    (regiones, aria-live, aria-label con pinta de "subtítulos", y lo que
 *    matchee captionsRegion). Cada nodo se imprime como referencia: haz clic
 *    derecho → "Reveal in Elements panel" para ir a él.
 *  - Cada 3 s muestra los nodos cuyo texto más cambió (los subtítulos en vivo
 *    son los que más se reescriben: casi siempre aparecen arriba).
 *  - Dibuja un contorno en la página: magenta discontinuo = candidato,
 *    naranja sólido = nodo "caliente".
 *  - content.js reporta aquí cada bloque leído y cada intervención guardada.
 *
 * Se activa desde el side panel (casilla "Modo debug").
 */
(() => {
  const PREFIJO = '%c Meet Transcriptor ';
  const ESTILO = 'background:#1a73e8;color:#fff;border-radius:3px';
  const INTERVALO_MS = 3000;
  const MAX_CALIENTES = 8;
  // Pistas de que un aria-label habla de subtítulos (varios idiomas).
  const RE_PISTA = /subt[ií]tul|caption|legenda|sous-titre|untertitel|sottotitol|transcri/i;

  let activo = false;
  let observador = null;
  let temporizador = null;
  let estilo = null;
  let firmaCandidatos = '';
  let cambios = new Map(); // elemento → nº de mutaciones desde el último informe

  /** Ruta CSS corta y legible hacia un elemento (solo para mostrar). */
  function ruta(el) {
    const partes = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && partes.length < 6; n = n.parentElement) {
      let p = n.tagName.toLowerCase();
      if (n.id) {
        partes.unshift(`${p}#${n.id}`);
        break;
      }
      const role = n.getAttribute('role');
      const label = n.getAttribute('aria-label');
      if (role) p += `[role="${role}"]`;
      if (label) p += `[aria-label="${label.slice(0, 30)}"]`;
      partes.unshift(p);
    }
    return partes.join(' > ');
  }

  function describir(el) {
    const texto = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
      ariaLive: el.getAttribute('aria-live') || '',
      caracteres: texto.length,
      texto: texto.slice(0, 80),
      ruta: ruta(el),
    };
  }

  /** Nodos que podrían ser el contenedor de subtítulos. */
  function candidatos() {
    const set = new Set();
    const consulta = '[role="region"],[role="log"],[aria-live],[aria-label]';
    for (const el of document.querySelectorAll(consulta)) {
      const etiqueta = el.getAttribute('aria-label') || '';
      if (RE_PISTA.test(etiqueta) || el.hasAttribute('aria-live') || el.getAttribute('role') === 'log') {
        set.add(el);
      }
    }
    for (const sel of globalThis.MT_SELECTORS.captionsRegion) {
      try {
        document.querySelectorAll(sel).forEach((el) => set.add(el));
      } catch (_) {
        console.warn(PREFIJO, ESTILO, 'selector inválido en captionsRegion:', sel);
      }
    }
    return [...set];
  }

  function marcar(elementos, valor) {
    document.querySelectorAll('[data-mt-debug]').forEach((el) => el.removeAttribute('data-mt-debug'));
    elementos.forEach((el) => el.setAttribute('data-mt-debug', valor));
  }

  function informarCandidatos() {
    const lista = candidatos();
    // Firma estable (sin contar texto) para no repetir el mismo informe.
    const firma = lista.map(ruta).join('|');
    if (firma === firmaCandidatos) return;
    firmaCandidatos = firma;
    marcar(lista, 'candidate');

    console.groupCollapsed(PREFIJO, ESTILO, `${lista.length} nodo(s) candidato(s) a contenedor de subtítulos`);
    console.table(lista.map(describir));
    lista.forEach((el, i) => console.log(`#${i}`, el));
    console.groupEnd();
  }

  function informarCalientes() {
    const top = [...cambios.entries()]
      .filter(([el]) => el.isConnected && (el.textContent || '').trim())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_CALIENTES);
    cambios = new Map();
    if (!top.length) return;

    // Los "calientes" se resaltan en naranja encima de los candidatos.
    top.slice(0, 3).forEach(([el]) => el.setAttribute('data-mt-debug', 'hot'));

    console.groupCollapsed(PREFIJO, ESTILO, `Nodos con más cambios de texto (últimos ${INTERVALO_MS / 1000} s)`);
    console.table(top.map(([el, n]) => ({ cambios: n, ...describir(el) })));
    top.forEach(([el, n], i) => console.log(`#${i} (${n} cambios)`, el));
    console.groupEnd();
  }

  function activar() {
    if (activo) return;
    activo = true;

    estilo = document.createElement('style');
    estilo.textContent = `
      [data-mt-debug="candidate"] { outline: 2px dashed #e91e63 !important; outline-offset: -2px; }
      [data-mt-debug="hot"] { outline: 3px solid #ff9800 !important; outline-offset: -3px; }
    `;
    document.documentElement.appendChild(estilo);

    observador = new MutationObserver((mutaciones) => {
      for (const m of mutaciones) {
        // En mutaciones de texto, el target es el nodo de texto: subimos a su elemento.
        const el = m.target.nodeType === 3 ? m.target.parentElement : m.target;
        if (el) cambios.set(el, (cambios.get(el) || 0) + 1);
      }
    });
    observador.observe(document.body, { childList: true, characterData: true, subtree: true });

    console.log(PREFIJO, ESTILO, 'modo debug ACTIVADO');
    informarCandidatos();
    temporizador = setInterval(() => {
      informarCandidatos();
      informarCalientes();
    }, INTERVALO_MS);
  }

  function desactivar() {
    if (!activo) return;
    activo = false;
    observador?.disconnect();
    observador = null;
    clearInterval(temporizador);
    temporizador = null;
    estilo?.remove();
    estilo = null;
    firmaCandidatos = '';
    cambios = new Map();
    document.querySelectorAll('[data-mt-debug]').forEach((el) => el.removeAttribute('data-mt-debug'));
    console.log(PREFIJO, ESTILO, 'modo debug desactivado');
  }

  globalThis.MT_DEBUG = {
    setEnabled(valor) {
      valor ? activar() : desactivar();
    },
    /** Log condicional: solo imprime con el debug activo. */
    log(...args) {
      if (activo) console.log(PREFIJO, ESTILO, ...args);
    },
  };
})();
