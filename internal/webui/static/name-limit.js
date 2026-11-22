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
    return { update, dispose() { input.removeEventListener?.("input", update); } };
  }
  // Match the server's Unicode simple lowercase mapping, including dotted I
  // and Greek sigma, without changing accents or interior whitespace.
  function tagName(value) {
    return Array.from(value.trim(), letter => letter === "İ" ? "i" : letter.toLowerCase()).join("");
  }
  function tagBytes(value) {
    // These lowercase forms take one extra UTF-8 byte. Keep labels that fit
    // before migration editable using the same budget as the server.
    return new TextEncoder().encode(value.replaceAll("ⱥ", "Ⱥ").replaceAll("ⱦ", "Ⱦ")).length;
  }
  const api = { describe, create, tagName, tagBytes };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PocketmarkNameLimit = api;
})(globalThis);
