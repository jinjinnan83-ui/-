import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = resolve(root, "dist", "js");
const outFile = resolve(outDir, "supabase-config.js");
const srcConfig = resolve(root, "js", "supabase-config.js");

const url = process.env.SUPABASE_URL || "";
const anonKey = process.env.SUPABASE_ANON_KEY || "";

await mkdir(outDir, { recursive: true });

if (url && anonKey) {
  const body = `window.__SUPABASE_CONFIG__=${JSON.stringify({ url, anonKey })};\n`;
  await writeFile(outFile, body, "utf-8");
} else {
  await cp(srcConfig, outFile);
}
