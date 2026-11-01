"use strict";
((root) => {
  function describe(value, limit = 120) {
    const name = value.trim(), used = new TextEncoder().encode(name).length;
    const valid = used <= limit;
    return { used, valid, text: valid ? "" : "This name is too long. Shorten it, especially if it contains accents or emoji." };
  }
  function create(input, hint) {
    function update() {
      const result = describe(input.value);
      hint.textContent = result.text;
      input.setCustomValidity(result.text);
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
