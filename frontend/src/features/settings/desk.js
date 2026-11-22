import { settingsEntries } from "./catalog.js";

// The shell renders every destination at build time. Only selection, search,
// focus and account-specific status need to change when the workspace opens.
export function createSettingsDesk({
  document,
  history,
  lifecycle,
  icon,
  navigateSettings,
}) {
  const get = (id) => document.getElementById(id);
  const field = get("settings-search");
  const matches = get("settings-matches");
  const destinations = new Map(
    settingsEntries.map((entry) => [entry.id, entry]),
  );
  const searchRows = [...matches.querySelectorAll("[data-settings-go]")].map(
    (button) => {
      const { id, group, name, description, keywords } = destinations.get(
        button.dataset.settingsGo,
      );
      return {
        button,
        terms: [id, group, name, description, keywords].join(" ").toLowerCase(),
      };
    },
  );
  function filter(value) {
    field.value = value;
    const query = value.trim().toLowerCase();
    get("settings-overview-cards").hidden = Boolean(query);
    get("settings-search-results").hidden = !query;
    get("settings-clear-search").hidden = !value;
    let count = 0;
    for (const { button, terms } of searchRows) {
      button.hidden = !terms.includes(query);
      if (!button.hidden) count++;
    }
    matches.hidden = !count;
    get("settings-no-match").hidden = Boolean(count);
    get("settings-match-count").textContent =
      count === 1 ? "1 matching setting" : `${count} matching settings`;
  }
  function updateSearch(value) {
    filter(value);
    history.replaceState(
      { ...history.state, pocketmarkSettingsSearch: value },
      "",
    );
  }
  function clearSearch() {
    updateSearch("");
    field.focus();
  }
  lifecycle.listen(field, "input", () => updateSearch(field.value));
  lifecycle.listen(get("settings-clear-search"), "click", clearSearch);
  lifecycle.listen(field, "keydown", (event) => {
    if (event.key === "Escape" && field.value) {
      event.preventDefault();
      clearSearch();
      return;
    }
    if (!field.value.trim() || !["Enter", "ArrowDown"].includes(event.key))
      return;
    const first = matches.querySelector("button:not([hidden])");
    if (!first) return;
    event.preventDefault();
    if (event.key === "Enter") navigateSettings(first.dataset.settingsGo);
    else first.focus();
  });
  return function showSection(section) {
    const entry = destinations.get(section);
    get("settings-detail-intro").hidden = !entry;
    if (entry) {
      get("settings-detail-title").textContent = entry.name;
      get("settings-detail-group").textContent = entry.group;
      get("settings-detail-icon").replaceChildren(icon(entry.icon));
      get("settings-detail-description").textContent = entry.description + ".";
    } else if (section === "overview") {
      const remembered = history.state?.pocketmarkSettingsSearch;
      filter(typeof remembered === "string" ? remembered.slice(0, 160) : "");
    }
  };
}
