import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve, relative } from "node:path";
import { readFile, readdir } from "node:fs/promises";

const backend = process.env.POCKETMARK_DEV_SERVER || "http://127.0.0.1:8090";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(backend).hostname)) {
  throw new Error("Frontend development requires a loopback Pocketmark server");
}
const proxy = {
  target: backend,
  changeOrigin: true,
  configure(server) {
    server.on("proxyReq", (request) =>
      request.setHeader("origin", new URL(backend).origin),
    );
  },
};

export default defineConfig({
  server: {
    // Native browser integrations have an application lifetime. A full reload
    // also verifies initialization and restores tab drafts after an edit.
    hmr: false,
    proxy: Object.fromEntries(
      [
        "^/(api|dav)(/|$)",
        "/api-docs",
        "/style.css",
        "/secondary.css",
        "/select.css",
        "/select.js",
        "/name-limit.js",
        "/theme.js",
        "/theme-switch.js",
        "/icon.svg",
        "/manifest.webmanifest",
        "/asset-preview.html",
        "/asset-preview.js",
      ].map((path) => [path, proxy]),
    ),
  },
  plugins: [
    {
      name: "pocketmark-shared-classic-modules",
      enforce: "pre",
      transform(code, id) {
        // The extension/docs keep their canonical classic scripts. Import those
        // exact sources as modules in both Vite development and production.
        if (
          /\/internal\/webui\/static\/(select|theme-switch|name-limit)\.js$/.test(
            id,
          )
        ) {
          return {
            code: `const module = { exports: {} };\n${code}\nexport default module.exports;`,
            map: null,
          };
        }
      },
    },
    react(),
    tailwindcss(),
    {
      name: "pocketmark-module-inventory",
      async generateBundle(_options, bundle) {
        const ids = Object.values(bundle)
          .filter((item) => item.type === "chunk")
          .flatMap((chunk) => Object.keys(chunk.modules));
        const packages = new Set();
        packages.add(resolve(import.meta.dirname, "node_modules/tailwindcss"));
        for (const id of ids) {
          const marker = "/node_modules/",
            start = id.lastIndexOf(marker);
          if (start < 0) continue;
          const parts = id.slice(start + marker.length).split("/");
          const name = parts
            .slice(0, parts[0].startsWith("@") ? 2 : 1)
            .join("/");
          packages.add(id.slice(0, start + marker.length) + name);
        }
        const licenses = [
          await readFile(
            resolve(import.meta.dirname, "SHADCN-LICENSE"),
            "utf8",
          ),
        ];
        for (const directory of [...packages].sort()) {
          const metadata = JSON.parse(
            await readFile(resolve(directory, "package.json"), "utf8"),
          );
          const file = (await readdir(directory)).find((name) =>
            /^licen[cs]e(?:\..*)?$/i.test(name),
          );
          if (!file)
            throw new Error(
              `Bundled dependency ${metadata.name} has no license notice`,
            );
          licenses.push(
            `${metadata.name}@${metadata.version}\n${await readFile(resolve(directory, file), "utf8")}`,
          );
        }
        this.emitFile({
          type: "asset",
          fileName: "licenses.txt",
          source: licenses.join("\n\n---\n\n"),
        });
        const modules = Object.values(bundle)
          .filter((item) => item.type === "chunk")
          .flatMap((chunk) => Object.keys(chunk.modules))
          .map((id) => relative(import.meta.dirname, id).replaceAll("\\", "/"))
          .filter((id) => id.startsWith("src/"));
        this.emitFile({
          type: "asset",
          fileName: "modules.json",
          source: JSON.stringify([...new Set(modules)].sort()),
        });
      },
    },
  ],
  resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
  build: {
    outDir: "../internal/webui/static/app",
    emptyOutDir: true,
    manifest: true,
    rollupOptions: { input: resolve(import.meta.dirname, "src/main.jsx") },
  },
});
