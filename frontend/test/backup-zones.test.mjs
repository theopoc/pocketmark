import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

let vite, groups, savedZoneLabel;
before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  const zones = await vite.ssrLoadModule(
    "/src/features/settings/backup-zones.js",
  );
  groups = zones.backupZoneGroups("en");
  savedZoneLabel = zones.savedZoneLabel;
});
after(async () => vite?.close());

function groupOf(zone) {
  const group = groups.find((g) => g.options.some((o) => o.value === zone));
  assert.ok(group, zone);
  return group;
}

test("geographic choices share transitions, retain their own IDs and distinguish regional schedules", () => {
  const europe = groupOf("Europe/Paris");
  assert.equal(groupOf("Europe/Berlin"), europe);
  assert.equal(groupOf("Europe/Brussels"), europe);
  assert.notEqual(groupOf("Africa/Algiers"), europe);
  assert.notEqual(groupOf("America/Phoenix"), groupOf("America/Denver"));
  assert.match(
    europe.options.find((o) => o.value === "Europe/Paris").label,
    /France.*Paris/,
  );
  assert.match(groupOf("Asia/Kathmandu").label, /GMT\+05:45/);
  const values = groups.flatMap((g) => g.options.map((o) => o.value));
  assert.equal(new Set(values).size, values.length);
  assert.ok(
    groups.every((g) =>
      g.options.every((o) => !o.label.includes("UTC") && o.value !== "UTC"),
    ),
  );
  assert.equal(savedZoneLabel("UTC"), "Fixed time (GMT+00:00)");
  assert.equal(savedZoneLabel("Etc/UTC"), savedZoneLabel("UTC"));
});
