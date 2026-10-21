"use strict";
const { test } = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
function setup({ dpr = 2, width = 1200, height = 4044, oversized = false, changed = false } = {}) {
  const calls = []; let reads = 0;
  const context = vm.createContext({ Blob, atob, Uint8Array, TextEncoder,
    chrome: {
      tabs: { get: async () => ({ url: changed ? "https://changed.example" : "https://example.org" }) },
      debugger: { sendCommand: async (target, command, parameters) => {
        calls.push({ command, parameters });
        if (command === "Page.getLayoutMetrics") return { cssContentSize: { width, height } };
        if (command === "Runtime.evaluate") return { result: { value: dpr } };
        if (command === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };
        if (command === "Page.printToPDF") return { stream: "pdf-stream" };
        if (command === "IO.read") { reads++; return { data: oversized ? "A".repeat(256 * 1024) : Buffer.from("%PDF-example").toString("base64"), base64Encoded: !oversized, eof: !oversized }; }
        return {};
      } },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "capture.js"), "utf8"), context);
  return { calls, context, readCount: () => reads };
}
test("Retina full-page raster stays within the 16 Mpx and axis limits", async () => {
  const env = setup(); await env.context.captureFormat("fullpage", { id: 3, url: "https://example.org" });
  const clip = env.calls.find((call) => call.command === "Page.captureScreenshot").parameters.clip;
  const width = Math.ceil(clip.width * clip.scale * 2), height = Math.ceil(clip.height * clip.scale * 2);
  assert.ok(width * height <= 16_000_000); assert.ok(width <= 16384 && height <= 16384);
});
test("PDF bytes are read in bounded blocks and its stream always closes", async () => {
  const env = setup(); const blob = await env.context.captureFormat("pdf", { id: 3, url: "https://example.org" });
  assert.equal(await blob.text(), "%PDF-example"); assert.equal(env.calls.at(-1).command, "IO.close");
  assert.equal(env.calls.find((call) => call.command === "IO.read").parameters.size, 256 * 1024);
});
test("oversized PDF stops at 20 MiB and closes the stream", async () => {
  const env = setup({ oversized: true });
  await assert.rejects(env.context.captureFormat("pdf", { id: 3, url: "https://example.org" }), /20 MiB/);
  assert.equal(env.readCount(), 81); assert.equal(env.calls.at(-1).command, "IO.close");
});
test("invalid pixel density and source navigation reject captures", async () => {
  const density = setup({ dpr: 0 }); await assert.rejects(density.context.captureFormat("fullpage", { id: 3, url: "https://example.org" }), /pixel density/);
  assert.equal(density.calls.some((call) => call.command === "Page.captureScreenshot"), false);
  const changed = setup({ changed: true }); await assert.rejects(changed.context.captureFormat("pdf", { id: 3, url: "https://example.org" }), /source page changed/); assert.equal(changed.calls.length, 0);
});
test("visible screenshot is captured from the original target without capturing beyond viewport", async () => {
  const env = setup(); await env.context.captureFormat("screenshot", { id: 3, url: "https://example.org" });
  assert.equal(env.calls[0].command, "Page.captureScreenshot"); assert.equal(env.calls[0].parameters.captureBeyondViewport, false);
});
