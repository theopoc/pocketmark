import { test } from "node:test";
import assert from "node:assert/strict";
import { createLifecycle } from "../src/lib/lifecycle.js";

test("disposing a browser integration removes listeners, timers and observers", async () => {
  const scope = createLifecycle();
  const target = new EventTarget();
  let events = 0,
    timeouts = 0,
    disconnected = 0;
  scope.listen(target, "change", () => events++, { capture: true });
  scope.timeout(() => timeouts++, 10);
  scope.observe({
    disconnect() {
      disconnected++;
    },
  });
  target.dispatchEvent(new Event("change"));
  scope.dispose();
  scope.dispose();
  target.dispatchEvent(new Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(events, 1);
  assert.equal(timeouts, 0);
  assert.equal(disconnected, 1);
});

test("explicit debounce cancellation releases the owned timer before disposal", () => {
  const canceled = [];
  let sequence = 0;
  const scope = createLifecycle({
    setTimeout() {
      return ++sequence;
    },
    clearTimeout(id) {
      canceled.push(id);
    },
  });
  const first = scope.timeout(() => {}, 100);
  const second = scope.timeout(() => {}, 100);
  scope.cancelTimeout(first);
  scope.dispose();
  assert.deepEqual(canceled, [first, second]);
});
