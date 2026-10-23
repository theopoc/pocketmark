"use strict";
// One job and at most four 20 MiB blobs. IndexedDB keeps binary data out of
// chrome.storage's JSON-only values and survives popup/worker/browser closure.
globalThis.jobStore = (() => {
  let database;
  function open() {
    if (!database) {
      const pending = new Promise((resolve, reject) => {
        const request = indexedDB.open("pocketmark-captures", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("state");
        request.onsuccess = () => {
          const db = request.result;
          const invalidate = () => { if (database === pending) database = undefined; };
          db.onclose = invalidate;
          db.onversionchange = () => { invalidate(); db.close(); };
          resolve(db);
        };
        request.onerror = () => reject(new Error("Local capture storage is unavailable. Free browser storage and retry."));
      });
      database = pending;
      // A failed opening must not poison every later manual retry in this worker.
      pending.catch(() => { if (database === pending) database = undefined; });
    }
    return database;
  }
  async function read(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state"), request = tx.objectStore("state").get(key);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(new Error("Could not read the capture locally. Free browser storage and retry."));
      tx.onerror = () => {}; // Let request failures abort the transaction.
    });
  }
  async function write(values, remove = []) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"), store = tx.objectStore("state");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error("Could not store the capture locally. Free browser storage and retry."));
      tx.onerror = () => {}; // onabort owns the transaction error.
      try {
        for (const key of remove) store.delete(key);
        for (const [key, value] of Object.entries(values)) store.put(value, key);
      } catch {
        // A synchronous clone/validation error must roll back earlier queued writes.
        tx.abort();
      }
    });
  }
  return { read, write };
})();
