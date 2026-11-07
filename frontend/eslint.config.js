import globals from "globals";

export default [
  {
    files: ["src/**/*.{js,jsx}", "test/*.mjs", "*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "no-undef": "error",
      "no-unreachable": "error",
      "no-duplicate-case": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "valid-typeof": "error",
    },
  },
];
