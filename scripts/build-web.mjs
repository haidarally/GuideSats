// Bundles the Preact PWA into web/dist (one small JS file, no source maps, no external fonts).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";

rmSync("web/dist", { recursive: true, force: true });
mkdirSync("web/dist", { recursive: true });
cpSync("web/public", "web/dist", { recursive: true });
await build({
  entryPoints: ["web/src/main.tsx"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  outfile: "web/dist/app.js",
  logLevel: "warning",
});
const kb = (f) => (statSync(f).size / 1024).toFixed(1);
console.log(`web/dist built: app.js ${kb("web/dist/app.js")} KB, style.css ${kb("web/dist/style.css")} KB`);
