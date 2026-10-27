/**
 * background.js — Service worker (MV3).
 *
 * Responsabilidades:
 *  1. Que al hacer clic en el ícono de la extensión se abra el side panel.
 *  2. Recibir las intervenciones del content script y guardarlas en
 *     IndexedDB (la base vive en el origen de la extensión, no en el de Meet).
 *  3. Avisar al side panel de que hay datos nuevos.
 */
importScripts('db.js');

function configurarPanel() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error('[Meet Transcriptor] sidePanel:', err));
}

chrome.runtime.onInstalled.addListener(configurarPanel);
configurarPanel();

chrome.runtime.onMessage.addListener((msg) => {
  // Solo nos interesan las entradas confirmadas; el resto (parciales,
  // estado) va directo al side panel y aquí se ignora.
  if (msg?.type !== 'mt:entry') return;

  MT_DB.upsertEntry(msg.meetingId, msg.code, msg.entry)
    .then(() =>
      // Si el side panel está cerrado nadie escucha y sendMessage falla: es normal.
      chrome.runtime.sendMessage({ type: 'mt:updated', meetingId: msg.meetingId }).catch(() => {})
    )
    .catch((err) => console.error('[Meet Transcriptor] no se pudo guardar:', err));
});
