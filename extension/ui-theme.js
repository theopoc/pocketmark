"use strict";
(() => {
  let theme = "dark";
  try { if (localStorage.getItem("pocketmark-extension-theme") === "light") theme = "light"; } catch { /* Optional storage. */ }
  document.documentElement.dataset.theme = theme;
  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("theme-toggle");
    function apply() {
      document.documentElement.dataset.theme = theme;
      button.textContent = theme === "dark" ? "Dark" : "Light";
      button.setAttribute("aria-pressed", String(theme === "dark"));
      button.setAttribute("aria-label", `${theme === "dark" ? "Dark" : "Light"} mode`);
      button.title = `Switch to ${theme === "dark" ? "light" : "dark"} mode`;
    }
    const themeSwitch = PocketmarkThemeSwitch.create({ initial: theme, apply: value => { theme = value; apply(); } });
    button.addEventListener("click", () => {
      const value = themeSwitch.requested === "dark" ? "light" : "dark";
      themeSwitch.set(value);
      try { localStorage.setItem("pocketmark-extension-theme", value); } catch { /* Keep session choice. */ }
    });
    apply();
  });
})();
