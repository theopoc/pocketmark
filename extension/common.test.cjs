"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict");
const vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
function client(fetch = () => { throw new Error("Unexpected network request"); }) {
  const context = vm.createContext({ URL, TextEncoder, AbortSignal, fetch });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "common.js"), "utf8"), context);
  return context.Pocketmark;
}
test("server connections require HTTPS except literal loopback and localhost", () => {
  const { origin } = client();
  for (const address of ["https://library.example", "http://localhost:8090", "http://127.0.0.1:8090", "http://127.4.5.6", "http://[::1]:8090"]) assert.equal(origin(address), new URL(address).origin);
  for (const address of ["http://library.example", "http://192.168.1.5", "http://10.0.0.1", "http://localhost.evil.example", "http://127.0.0.1.evil.example", "http://[::ffff:127.0.0.1]", "http://0.0.0.0"]) assert.throws(() => origin(address), /HTTPS/);
  for (const address of ["https://user:pass@library.example", "https://library.example/path", "https://library.example?redirect=http://evil.example"]) assert.throws(() => origin(address));
});
test("saved remote HTTP connections cannot send credentials", async () => {
  let calls = 0;
  await assert.rejects(client(() => { calls++; }).request({ server: "http://library.example", token: "synthetic" }, "/api/session"), /HTTPS/);
  assert.equal(calls, 0);
});
