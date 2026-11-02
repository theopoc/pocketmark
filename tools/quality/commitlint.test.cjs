const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { join, resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
// Run the actual title-validation shell block with untrusted metadata.
const script = workflow.split("      - name: Validate the squash commit title\n")[1]
  .split("        run: |\n")[1].split("      - run:")[0]
  .split("\n").map((line) => line.replace(/^          /, "")).join("\n");
function lint(title) {
  return spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
    cwd: root, env: { ...process.env, PR_TITLE: title }, encoding: "utf8",
  });
}

test("release, breaking and maintenance titles pass", () => {
  for (const title of ["feat: add collections", "fix(api): support SQLite", "feat!: change API",
    "refactor(store)!: change schema", "chore(main): release 1.3.2", "ci(deps): bump actions",
    "build(deps): bump Go", "revert: restore old behavior"]) {
    const result = lint(title);
    assert.equal(result.status, 0, `${title}: ${result.stdout}${result.stderr}`);
  }
});

test("invalid, default-ignored and multiline titles fail", () => {
  for (const title of ["", "Fix login", "Feature: add collections", "feat: ",
    "feat:no space", "fix: title\nci: hidden", "fix: title\rhidden", "fix: title\n",
    "Merge branch main", "v1.3.2"]) {
    assert.notEqual(lint(title).status, 0, title);
  }
});

test("shell metacharacters stay plain metadata", () => {
  const marker = `/tmp/pm-title-${process.pid}`;
  const title = `fix: handle $(touch ${marker}) and \`touch ${marker}\``;
  const result = lint(title);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(marker), false);
});
