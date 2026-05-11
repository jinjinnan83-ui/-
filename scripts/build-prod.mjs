import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");

const ensureDir = async (dirPath) => {
  await mkdir(dirPath, { recursive: true });
};

const main = async () => {
  await rm(dist, { recursive: true, force: true });
  await ensureDir(resolve(dist, "assets"));
  await ensureDir(resolve(dist, "js"));
  await ensureDir(resolve(dist, "vendor/vue"));
  await ensureDir(resolve(dist, "vendor/supabase"));
  await ensureDir(resolve(dist, "vendor/fontawesome/css"));

  const indexPath = resolve(root, "index.html");
  const rawHtml = await readFile(indexPath, "utf-8");
  const prodHtml = rawHtml
    .replace(
      "./node_modules/@fortawesome/fontawesome-free/css/all.min.css",
      "./vendor/fontawesome/css/all.min.css"
    )
    .replace(
      "./node_modules/@supabase/supabase-js/dist/umd/supabase.js",
      "./vendor/supabase/supabase.js"
    )
    .replace(
      "./node_modules/vue/dist/vue.global.prod.js",
      "./vendor/vue/vue.global.prod.js"
    );

  await writeFile(resolve(dist, "index.html"), prodHtml, "utf-8");

  /* assets */
  await cp(resolve(root, "assets/styles.css"), resolve(dist, "assets/styles.css"));

  /* js */
  await cp(resolve(root, "js/app.js"), resolve(dist, "js/app.js"));

  /* vendor */
  await cp(
    resolve(root, "node_modules/vue/dist/vue.global.prod.js"),
    resolve(dist, "vendor/vue/vue.global.prod.js")
  );
  await cp(
    resolve(root, "node_modules/@fortawesome/fontawesome-free/css/all.min.css"),
    resolve(dist, "vendor/fontawesome/css/all.min.css")
  );
  await cp(
    resolve(root, "node_modules/@fortawesome/fontawesome-free/webfonts"),
    resolve(dist, "vendor/fontawesome/webfonts"),
    { recursive: true }
  );
  await cp(
    resolve(root, "node_modules/@supabase/supabase-js/dist/umd/supabase.js"),
    resolve(dist, "vendor/supabase/supabase.js")
  );

  /* inject env config */
  await import(new URL("./write-supabase-config.mjs", import.meta.url));

  console.log("Production build ready at ./dist");
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
