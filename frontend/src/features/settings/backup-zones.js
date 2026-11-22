import places from "./backup-zones.tsv?raw";

function offsetMinutes(offset) {
  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(3) || 0);
  return (offset[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function formatOffset(offset) {
  return "GMT" + offset.slice(0, 3) + ":" + (offset.slice(3) || "00");
}

// The IANA identifier stays attached to the country/city the owner picks.
// Countries sharing clock rules today may adopt different rules in the future.
export function backupZoneGroups(locale) {
  const names = new Intl.DisplayNames(locale, { type: "region" });
  const collator = new Intl.Collator(locale);
  const groups = [];
  let group;
  for (const row of places.trim().split("\n")) {
    if (!row.includes("\t")) {
      const offsets = row
        .split(" ")
        .sort((a, b) => offsetMinutes(a) - offsetMinutes(b));
      group = { offsets, options: [] };
      groups.push(group);
      continue;
    }
    const [country, value] = row.split("\t");
    const city = value.split("/").at(-1).replaceAll("_", " ");
    group.options.push({ value, label: names.of(country) + " · " + city });
  }
  for (const group of groups) {
    group.options.sort((a, b) => collator.compare(a.label, b.label));
    const reference = group.options[0].label.split(" · ").at(-1);
    group.label =
      group.offsets.map(formatOffset).join(" / ") + " · " + reference;
  }
  return groups.sort(
    (a, b) =>
      offsetMinutes(a.offsets[0]) - offsetMinutes(b.offsets[0]) ||
      collator.compare(a.label, b.label),
  );
}

export function savedZoneLabel(zone) {
  try {
    if (
      ["UTC", "Etc/UTC", "Etc/GMT", "GMT"].includes(
        new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions()
          .timeZone,
      )
    )
      return "Fixed time (GMT+00:00)";
  } catch {
    /* Keep server-supported identifiers on browsers with older tzdata. */
  }
  return zone.replaceAll("_", " ");
}
