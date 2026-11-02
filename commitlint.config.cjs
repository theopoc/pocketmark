module.exports = {
  defaultIgnores: false,
  extends: ["./tools/quality/node_modules/@commitlint/config-conventional"],
  // PR titles may contain identifiers and proper names such as Go or SQLite.
  rules: { "subject-case": [0] },
};
