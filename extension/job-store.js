"use strict";
// One job and at most four 20 MiB blobs. IndexedDB keeps binary data out of
// chrome.storage's JSON-only values and survives popup/worker/browser closure.
globalThis.jobStore = (() => {
  let database;
  function open() {
    if (!database) database = new Promise((resolve, reject) => {
      const request = indexedDB.open("pocketmark-captures", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Local capture storage is unavailable. Free browser storage and retry."));
    });
    return database;
  }
  async function read(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction("state").objectStore("state").get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function write(values, remove = []) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite"), store = tx.objectStore("state");
      for (const key of remove) store.delete(key);
      for (const [key, value] of Object.entries(values)) store.put(value, key);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error("Could not store the capture locally. Free browser storage and retry."));
      tx.onerror = () => {}; // onabort owns the transaction error.
    });
  }
  return { read, write };
})();
