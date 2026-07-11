// Cross-platform copy of the built web UI (../frontend/dist) into ./www.
// Capacitor's `webDir` points at www; cap sync then stages it into the
// native Android project. Uses Node's fs API only — no bash `cp`, so this
// runs identically on Windows, macOS and Linux.
import { existsSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, "..", "..", "frontend", "dist");
const www = resolve(here, "..", "www");

if (!existsSync(dist)) {
  console.error(
    `[copy-www] Missing build output: ${dist}\n` +
      `           Run the web build first: npm run build:web (or npm run build).`
  );
  process.exit(1);
}

// Start from a clean www so deleted assets don't linger between builds.
rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });
cpSync(dist, www, { recursive: true });

console.log(`[copy-www] ${dist}\n        -> ${www}`);
