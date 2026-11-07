import { build, createServer } from "vite";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

process.chdir(import.meta.dirname);
await build();
// Only the empty shell is rendered at build time. Private library data is fetched
// and rendered in the browser; production never needs Node or a renderer process.
const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
});
try {
  const { Shell } = await server.ssrLoadModule("/src/shell.jsx");
  const shell = renderToString(createElement(Shell));
  const { Sidebar } = await server.ssrLoadModule("/src/components/sidebar.jsx");
  const { Toast } = await server.ssrLoadModule("/src/components/toast.jsx");
  const output = resolve("../internal/webui/static");
  const manifest = JSON.parse(
    await readFile(resolve(output, "app/.vite/manifest.json")),
  );
  const entry = manifest["src/main.jsx"];
  const styles = (entry.css || [])
    .map((file) => `<link rel="stylesheet" href="/app/${file}">`)
    .join("\n");
  const html = await readFile("index.template.html", "utf8");
  await writeFile(
    resolve(output, "index.html"),
    html
      .replace("<!--styles-->", styles)
      .replace("<!--shell-->", shell)
      .replace("<!--navigation-->", renderToString(createElement(Sidebar)))
      .replace("<!--toast-->", renderToString(createElement(Toast)))
      .replace("<!--entry-->", `/app/${entry.file}`),
  );
  const assets = [
    "/theme.js",
    "/style.css",
    "/secondary.css",
    "/select.css",
    "/icon.svg",
    "/manifest.webmanifest",
    ...Object.values(manifest)
      .flatMap((item) => [item.file, ...(item.css || [])])
      .map((file) => `/app/${file}`),
  ];
  const hash = createHash("sha256");
  for (const path of assets)
    hash.update(await readFile(resolve(output, path.slice(1))));
  const worker =
    `const CACHE = "pocketmark-shell-${hash.digest("hex").slice(0, 16)}";\nconst ASSETS = ${JSON.stringify(assets)};\n` +
    (await readFile("service-worker.js", "utf8"));
  await writeFile(resolve(output, "sw.js"), worker);
} finally {
  await server.close();
}
