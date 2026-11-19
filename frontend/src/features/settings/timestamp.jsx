const localDate = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
});

export function SettingsTimestamp({ date, fallback = "Unavailable" }) {
  if (!date || Number.isNaN(date.getTime())) return fallback;
  const iso = date.toISOString();
  return (
    <time dateTime={iso} title={iso}>
      {localDate.format(date)}
    </time>
  );
}
