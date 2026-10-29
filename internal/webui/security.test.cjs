"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");

test("session settings replace stale feedback when saving succeeds or fails", async () => {
  const nodes = new Map();
  for (const match of fs.readFileSync(`${__dirname}/static/index.html`, "utf8").matchAll(/\bid="([^"]+)"/g)) {
    nodes.set(match[1], { value: "", textContent: "", disabled: false, events: {}, addEventListener(type, fn) { this.events[type] = fn; } });
  }
  const document = { getElementById: id => nodes.get(id), querySelectorAll: () => [] };
  const context = { document }; vm.runInNewContext(fs.readFileSync(`${__dirname}/static/security.js`, "utf8"), context);
  let fail = false;
  context.PocketmarkSecurity.create({ api: async () => { if (fail) throw Error("Save failed"); }, toast() {}, onSessionExpired() {} });
  const form = nodes.get("session-idle-form"), submitter = { disabled: false };
  const submit = () => form.events.submit({ preventDefault() {}, submitter });
  await submit(); assert.match(nodes.get("sessions-feedback").textContent, /saved/);
  fail = true; await submit();
  assert.equal(nodes.get("sessions-feedback").textContent, ""); assert.equal(nodes.get("sessions-error").textContent, "Save failed");
  fail = false; await submit();
  assert.equal(nodes.get("sessions-error").textContent, ""); assert.match(nodes.get("sessions-feedback").textContent, /saved/);
});
