/**
 * sidepanel.js — Interfaz del side panel.
 *
 * Muestra la transcripción guardada en IndexedDB (se refresca cuando el
 * service worker avisa con 'mt:updated') más el texto "en vivo" que llega
 * directo desde el content script ('mt:partial'). También guarda los ajustes
 * en chrome.storage.local, que el content script escucha.
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = {
    estado: $('estado'),
    reunion: $('reunion'),
    lista: $('lista'),
    copiar: $('copiar'),
    exportar: $('exportar'),
    eliminar: $('eliminar'),
    ocultar: $('ocultar'),
    debug: $('debug'),
    estabilizar: $('estabilizar'),
  };

  const CONFIG_DEFECTO = { debug: false, hideCaptions: false, stabilizeMs: 1500 };
  const PARCIAL_CADUCA_MS = 20000; // un parcial sin novedades se descarta
  const ESTADO_CADUCA_MS = 12000;  // sin latido de Meet → "sin Meet activo"

  let reuniones = [];     // todas, la más reciente primero
  let actual = null;      // reunión que se está mostrando
  let seleccion = '';     // '' = automática (la más reciente)
  const parciales = new Map(); // clave → { meetingId, speaker, text, t }
  let ultimoEstado = null;     // { t, regionFound, code }

  // ── Formato ────────────────────────────────────────────────────────────

  const pad = (n) => String(n).padStart(2, '0');

  function hora(iso) {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function fechaLarga(iso) {
    const d = new Date(iso);
    return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Matiz 0-359 estable para un nombre (da a cada hablante su color). */
  function matiz(nombre) {
    let h = 0;
    for (const c of nombre) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % 360;
  }

  /** Entradas ordenadas por hora de inicio (el orden de guardado puede variar). */
  function ordenadas(reunion) {
    return [...reunion.entries].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  }

  function aTexto(reunion) {
    return ordenadas(reunion)
      .map((e) => `[${hora(e.time)}] ${e.speaker}: ${e.text}`)
      .join('\n');
  }

  function aMarkdown(reunion) {
    const cuerpo = ordenadas(reunion)
      .map((e) => `**[${hora(e.time)}] ${e.speaker}:** ${e.text}`)
      .join('\n\n');
    return [
      `# Transcripción de reunión ${reunion.code}`,
      '',
      `- **Fecha:** ${fechaLarga(reunion.date)}`,
      `- **Código:** ${reunion.code}`,
      `- **Intervenciones:** ${reunion.entries.length}`,
      '',
      '---',
      '',
      cuerpo,
      '',
    ].join('\n');
  }

  // ── Renderizado ────────────────────────────────────────────────────────

  function crearEntrada(speaker, texto, horaTxt, parcial) {
    const div = document.createElement('div');
    div.className = parcial ? 'entrada parcial' : 'entrada';

    const cab = document.createElement('div');
    cab.className = 'cabecera';
    const quien = document.createElement('span');
    quien.className = 'hablante';
    quien.style.setProperty('--h', matiz(speaker));
    quien.textContent = speaker;
    const h = document.createElement('span');
    h.className = 'hora';
    h.textContent = horaTxt;
    cab.append(quien, h);

    const t = document.createElement('div');
    t.className = 'texto';
    t.textContent = texto; // textContent: los nombres/textos vienen de la página, nunca como HTML

    div.append(cab, t);
    return div;
  }

  /** Parciales vigentes que corresponden a la reunión mostrada. */
  function parcialesVisibles() {
    const ahora = Date.now();
    const ids = new Set(reuniones.map((r) => r.id));
    const res = [];
    for (const [clave, p] of parciales) {
      if (ahora - p.t > PARCIAL_CADUCA_MS) {
        parciales.delete(clave);
      } else if (actual ? p.meetingId === actual.id : !ids.has(p.meetingId)) {
        res.push(p);
      }
    }
    return res;
  }

  function renderLista() {
    // Si el usuario ya estaba abajo, seguimos el final; si subió a leer, no lo movemos.
    const lista = el.lista;
    const pegado = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 48;

    const frag = document.createDocumentFragment();
    const entradas = actual ? ordenadas(actual) : [];
    for (const e of entradas) frag.append(crearEntrada(e.speaker, e.text, hora(e.time), false));
    for (const p of parcialesVisibles()) frag.append(crearEntrada(p.speaker, p.text, 'en vivo', true));

    if (!frag.childNodes.length) {
      const vacio = document.createElement('p');
      vacio.className = 'vacio';
      vacio.textContent = 'Aún no hay transcripción. Entra a una reunión de Meet y activa los subtítulos (CC).';
      frag.append(vacio);
    }
    lista.replaceChildren(frag);
    if (pegado) lista.scrollTop = lista.scrollHeight;

    const hay = !!actual && actual.entries.length > 0;
    el.copiar.disabled = !hay;
    el.exportar.disabled = !hay;
    el.eliminar.disabled = !actual;
  }

  function renderSelector() {
    const opciones = [new Option('Última reunión (automático)', '')];
    for (const r of reuniones) {
      opciones.push(new Option(`${r.code} · ${fechaLarga(r.date)} (${r.entries.length})`, r.id));
    }
    el.reunion.replaceChildren(...opciones);
    el.reunion.value = reuniones.some((r) => r.id === seleccion) ? seleccion : '';
  }

  function renderEstado() {
    const vivo = ultimoEstado && Date.now() - ultimoEstado.t < ESTADO_CADUCA_MS;
    el.estado.classList.toggle('activo', !!(vivo && ultimoEstado.regionFound));
    if (!vivo) el.estado.textContent = 'No hay una reunión de Meet abierta.';
    else if (ultimoEstado.regionFound) el.estado.textContent = `Capturando subtítulos · ${ultimoEstado.code}`;
    else el.estado.textContent = `Reunión ${ultimoEstado.code}: esperando subtítulos… activa CC en Meet.`;
  }

  // ── Datos ──────────────────────────────────────────────────────────────

  async function refrescar() {
    reuniones = await MT_DB.listMeetings();
    if (seleccion && !reuniones.some((r) => r.id === seleccion)) seleccion = '';
    actual = seleccion ? reuniones.find((r) => r.id === seleccion) : reuniones[0] || null;
    renderSelector();
    renderLista();
  }

  // ── Acciones ───────────────────────────────────────────────────────────

  async function copiar() {
    if (!actual) return;
    await navigator.clipboard.writeText(aTexto(actual));
    const original = el.copiar.textContent;
    el.copiar.textContent = '¡Copiado!';
    setTimeout(() => (el.copiar.textContent = original), 1500);
  }

  function exportar() {
    if (!actual) return;
    const blob = new Blob([aMarkdown(actual)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meet-${actual.code}-${actual.id.split('_')[1] || 'sin-fecha'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function eliminar() {
    if (!actual) return;
    if (!confirm(`¿Eliminar la transcripción de ${actual.code} (${actual.entries.length} intervenciones)?`)) return;
    await MT_DB.deleteMeeting(actual.id);
    seleccion = '';
    await refrescar();
  }

  // ── Ajustes ────────────────────────────────────────────────────────────

  async function cargarAjustes() {
    const { mtConfig } = await chrome.storage.local.get('mtConfig');
    const c = { ...CONFIG_DEFECTO, ...mtConfig };
    el.ocultar.checked = c.hideCaptions;
    el.debug.checked = c.debug;
    el.estabilizar.value = c.stabilizeMs;
  }

  async function guardarAjustes() {
    const ms = Math.min(10000, Math.max(500, Number(el.estabilizar.value) || CONFIG_DEFECTO.stabilizeMs));
    await chrome.storage.local.set({
      mtConfig: { hideCaptions: el.ocultar.checked, debug: el.debug.checked, stabilizeMs: ms },
    });
  }

  // ── Mensajes ───────────────────────────────────────────────────────────

  let tRefresco = null;

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'mt:updated':
        // Agrupa avisos seguidos en un solo refresco.
        clearTimeout(tRefresco);
        tRefresco = setTimeout(refrescar, 100);
        break;
      case 'mt:partial':
        if (msg.text) parciales.set(msg.key, { meetingId: msg.meetingId, speaker: msg.speaker, text: msg.text, t: Date.now() });
        else parciales.delete(msg.key);
        renderLista();
        break;
      case 'mt:status':
        ultimoEstado = { t: Date.now(), regionFound: msg.regionFound, code: msg.code };
        renderEstado();
        break;
    }
  });

  // ── Arranque ───────────────────────────────────────────────────────────

  el.reunion.addEventListener('change', () => {
    seleccion = el.reunion.value;
    refrescar();
  });
  el.copiar.addEventListener('click', copiar);
  el.exportar.addEventListener('click', exportar);
  el.eliminar.addEventListener('click', eliminar);
  [el.ocultar, el.debug].forEach((i) => i.addEventListener('change', guardarAjustes));
  el.estabilizar.addEventListener('change', guardarAjustes);

  setInterval(renderEstado, 2000);
  cargarAjustes();
  refrescar();
  renderEstado();
})();
