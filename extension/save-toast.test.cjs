"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("the popup holds the confirmed result and the source page keeps feedback after closure", () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "save-toast.js"), "utf8"), context);
  const { outcome } = context.PocketmarkSaveToast;
  for (const [job, expected, popupMs, pageMs] of [
    [{ status: "done" }, /^Saved to Pocketmark\./, 3500, 9000],
    [{ status: "paused", linkId: 17 }, /^Bookmark saved\. Some captures need attention\./, 8000, 12000],
    [{ status: "paused" }, /^Pocketmark couldn’t confirm the save\./, 8000, 12000],
  ]) {
    const popup = outcome(job, "popup"), page = outcome(job);
    assert.equal(popup.duration, popupMs);
    assert.equal(page.duration, pageMs);
    assert.match(popup.message, expected);
    assert.match(page.message, expected);
    assert.doesNotMatch(popup.message, /reopen/i);
    if (job.status === "paused") assert.match(page.message, /reopen/i);
  }
});

test("an unresponsive renderer times out and cannot display a late page toast", async () => {
  const url = "https://page.example/article";
  let time = 1000, expire, injection;
  const context = vm.createContext({
    Date: { now: () => time },
    setTimeout(fn, delay) { expire = () => { time += delay; fn(); }; return 1; },
    clearTimeout() {},
    chrome: {
      tabs: { get: async () => ({ active: true, url }) },
      scripting: { executeScript: request => { injection = request; return new Promise(() => {}); } },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "save-toast.js"), "utf8"), context);
  const feedback = context.PocketmarkSaveToast.outcome({ status: "done" });
  const shown = context.PocketmarkSaveToast.showInTab(3, url, feedback, "light");
  await new Promise(setImmediate);
  assert.ok(injection);
  expire();
  assert.equal(await shown, false);
  assert.equal(injection.func(...injection.args), false);
});
