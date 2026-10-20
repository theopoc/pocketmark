"use strict";
// Run before styles load so a saved light preference never flashes dark.
(() => {
  let theme = "dark";
  try { if (localStorage.getItem("pocketmark-theme") === "light") theme = "light"; } catch { /* Storage is optional. */ }
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#15161b" : "#ffffff";
})();
