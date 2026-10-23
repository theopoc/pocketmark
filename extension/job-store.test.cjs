"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs");
const source = fs.readFileSync(`${__dirname}/job-store.js`, "utf8"), tick = () => new Promise(setImmediate);
// Event-controlled IndexedDB adapter: mutations remain staged until commit.
// These tests run the shipped storage module, not the background workflow's Map.
function database() {
  const env = { data: new Map(), connections: [], opens: 0, failOpen: 0, abortNext: false, holdNext: false, transactions: [] };
  env.indexedDB = { open() {
    env.opens++; const request = {};
    queueMicrotask(() => {
      if (env.failOpen) { env.failOpen--; request.onerror(); return; }
      const db = { closed: false, createObjectStore() {}, close() { this.closed = true; }, transaction(name, mode) {
        assert.equal(name, "state"); if (db.closed) throw Error("Closed connection");
        const staged = new Map(env.data), operations = [], held = env.holdNext, forcedAbort = env.abortNext;
        env.holdNext = false; env.abortNext = false;
        const tx = { aborted: false, done: false, objectStore() { return {
          get(key) { const req = {}; operations.push(() => { req.result = structuredClone(staged.get(key)); tx.readComplete = true; req.onsuccess?.(); }); return req; },
          delete(key) { staged.delete(key); }, put(value, key) { staged.set(key, structuredClone(value)); },
        }; }, abort() { if (tx.done) throw Error("Already finished"); if (tx.aborted) return; tx.aborted = true; queueMicrotask(() => tx.onabort?.()); },
        finish() { if (tx.aborted || tx.done) return; if (forcedAbort) { tx.abort(); return; } tx.done = true; if (mode === "readwrite") env.data = staged; tx.oncomplete?.(); } };
        env.transactions.push(tx);
        setImmediate(() => { if (tx.aborted) return; for (const operation of operations) operation(); if (!held) tx.finish(); });
        return tx;
      } };
      request.result = db; env.connections.push(db);
      if (env.connections.length === 1) request.onupgradeneeded(); request.onsuccess();
    }); return request;
  } };
  env.load = () => { const context = vm.createContext({ indexedDB: env.indexedDB }); vm.runInContext(source, context); return context.jobStore; };
  return env;
}
test("a failed opening is shared by concurrent callers and the next manual attempt reopens", async () => {
  const env = database(); env.failOpen = 1; const store = env.load();
  const attempts = await Promise.allSettled([store.read("job"), store.write({ job: {} })]);
  assert.ok(attempts.every(result => result.status === "rejected")); assert.equal(env.opens, 1);
  await store.write({ job: { status: "paused" } }); assert.equal(env.opens, 2);
  assert.equal((await store.read("job")).status, "paused");
});
test("job and captured bytes survive a fresh module instance and clear atomically", async () => {
  const env = database(), first = env.load();
  await first.write({ job: { status: "running", server: "https://library.example" }, pdf: new Blob(["retained bytes"]) });
  const second = env.load();
  assert.equal((await second.read("job")).status, "running"); assert.equal(await (await second.read("pdf")).text(), "retained bytes");
  await second.write({}, ["job", "pdf"]); assert.equal(await second.read("job"), undefined); assert.equal(await second.read("pdf"), undefined);
});
test("a write resolves only after transaction commit", async () => {
  const env = database(), store = env.load(); env.holdNext = true; let finished = false;
  const write = store.write({ job: { status: "ready" }, pdf: new Blob(["bytes"]) }).then(() => { finished = true; }); await tick();
  assert.equal(finished, false); assert.equal(env.data.size, 0);
  env.transactions[0].finish(); await write; assert.equal(env.data.size, 2);
});
test("an aborted transaction publishes neither new metadata nor blobs and preserves previous bytes", async () => {
  const env = database(), store = env.load(); await store.write({ job: { status: "paused" }, pdf: new Blob(["old"]) });
  env.abortNext = true; await assert.rejects(store.write({ job: { status: "done" }, pdf: new Blob(["new"]) }, ["job", "pdf"]), /store the capture/);
  assert.equal((await store.read("job")).status, "paused"); assert.equal(await (await store.read("pdf")).text(), "old");
  await store.write({ job: { status: "done" } }); assert.equal((await store.read("job")).status, "done");
});
test("synchronous cloning failures roll back earlier deletes and queued writes", async () => {
  const env = database(), store = env.load(); await store.write({ job: { status: "paused" }, pdf: new Blob(["keep"]) });
  await assert.rejects(store.write({ job: { status: "done" }, invalid: () => {} }, ["pdf"]), /store the capture/);
  assert.equal((await store.read("job")).status, "paused"); assert.equal(await (await store.read("pdf")).text(), "keep");
});
test("a read does not publish a result before its transaction commits", async () => {
  const env = database(), store = env.load(); await store.write({ job: { status: "paused" } }); env.holdNext = true;
  let completed = false; const reading = store.read("job").then(value => { completed = true; return value; }); await tick(); await tick();
  assert.equal(completed, false); assert.equal(env.transactions.at(-1).readComplete, true); env.transactions.at(-1).finish(); assert.equal((await reading).status, "paused");
});
test("a read aborted after request success is rejected rather than returned as valid", async () => {
  const env = database(), store = env.load(); await store.write({ job: { status: "paused" } }); env.holdNext = true;
  const reading = store.read("job"); const rejected = assert.rejects(reading, /read the capture/); await tick(); await tick(); assert.equal(env.transactions.at(-1).readComplete, true); env.transactions.at(-1).abort(); await rejected;
  assert.equal((await store.read("job")).status, "paused");
});
test("unexpected close and versionchange invalidate only their own cached connection", async () => {
  const env = database(), store = env.load(); await store.write({ job: { status: "paused" } });
  const original = env.connections[0]; original.closed = true; original.onclose();
  assert.equal((await store.read("job")).status, "paused"); assert.equal(env.opens, 2);
  original.onclose(); await store.read("job"); assert.equal(env.opens, 2);
  const current = env.connections[1]; current.onversionchange(); assert.equal(current.closed, true);
  await store.read("job"); assert.equal(env.opens, 3);
});
