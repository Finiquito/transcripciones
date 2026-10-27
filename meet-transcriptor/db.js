/**
 * db.js — Acceso a IndexedDB. Lo usan el service worker (importScripts) y el
 * side panel (<script>), ambos con el origen de la extensión, así que
 * comparten la misma base de datos.
 *
 * Modelo: un registro por reunión (y por día):
 *   { id: 'abc-defg-hij_2026-10-27', code, date, updatedAt,
 *     entries: [{ id, speaker, text, time }] }
 */
(() => {
  const NOMBRE_DB = 'meet-transcriptor';
  const VERSION = 1;
  const STORE = 'meetings';

  let promesaDb = null;

  /** Abre (o crea) la base de datos; reutiliza la conexión. */
  function abrir() {
    if (promesaDb) return promesaDb;
    promesaDb = new Promise((resolve, reject) => {
      const req = indexedDB.open(NOMBRE_DB, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        promesaDb = null;
        reject(req.error);
      };
    });
    return promesaDb;
  }

  /** Envuelve una IDBRequest en una promesa. */
  function promesa(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Inserta o actualiza una intervención dentro de su reunión.
   * Si ya existe una entrada con el mismo id (el hablante siguió hablando
   * y el bloque se extendió), se reemplaza su texto y se conserva la hora.
   * Todo ocurre en una sola transacción, así que las escrituras concurrentes
   * se serializan solas.
   */
  async function upsertEntry(meetingId, code, entry) {
    const db = await abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(meetingId);
      req.onsuccess = () => {
        const reunion = req.result || {
          id: meetingId,
          code,
          date: entry.time,
          entries: [],
        };
        const i = reunion.entries.findLastIndex((e) => e.id === entry.id);
        if (i >= 0) {
          reunion.entries[i] = { ...reunion.entries[i], speaker: entry.speaker, text: entry.text };
        } else {
          reunion.entries.push(entry);
        }
        reunion.updatedAt = Date.now();
        store.put(reunion);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** Todas las reuniones, la más reciente primero. */
  async function listMeetings() {
    const db = await abrir();
    const todas = await promesa(db.transaction(STORE).objectStore(STORE).getAll());
    return todas.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  async function getMeeting(id) {
    const db = await abrir();
    return promesa(db.transaction(STORE).objectStore(STORE).get(id));
  }

  async function deleteMeeting(id) {
    const db = await abrir();
    return promesa(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  }

  globalThis.MT_DB = { upsertEntry, listMeetings, getMeeting, deleteMeeting };
})();
