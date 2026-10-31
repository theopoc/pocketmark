"use strict";
((root) => {
  function describe(value, limit = 120) {
    const name = value.trim(), used = new TextEncoder().encode(name).length;
    const count = Array.from(name).length;
    return { used, valid: used <= limit, text: `${count} character${count === 1 ? "" : "s"} · ${Math.ceil(used * 100 / limit)}% of name limit used` };
  }
  function create(input, hint) {
    function update() {
      const result = describe(input.value);
      hint.textContent = result.text;
      hint.classList.toggle("name-limit-warning", result.used > 108);
      input.setCustomValidity(result.valid ? "" : "This name is too long. Shorten it, especially if it contains accents or emoji.");
      return result;
    }
    input.addEventListener("input", update);
    update();
    return { update };
  }
  const api = { describe, create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PocketmarkNameLimit = api;
})(globalThis);
