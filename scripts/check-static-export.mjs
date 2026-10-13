import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(process.argv[2] || "out");
const requiredFiles = ["index.html", "admin/index.html"];
for (const path of requiredFiles) {
  try {
    if (!(await stat(join(root, path))).isFile()) throw new Error();
  } catch {
    console.error(`Static export is missing ${path}`);
    process.exitCode = 1;
    process.exit();
  }
}

const forbidden = [
  /postgres(?:ql)?:\/\//i,
  /SUPABASE_SERVICE_ROLE_KEY/i,
  /service_role/i,
  /\bDATABASE_URL\b/i,
  /\bADMIN_SECRET\b/i,
  /SUPABASE_CA_CERT_PATH/i,
];
const files = [];
const fontFiles = [];
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) await walk(path);
    else {
      if (extname(path) === ".woff2") fontFiles.push(path);
      if ([".html", ".js", ".css", ".json", ".map"].includes(extname(path))) files.push(path);
    }
  }
}
await walk(root);
if (!fontFiles.length) {
  console.error("Static export contains no bundled WOFF2 fonts.");
  process.exitCode = 1;
}
let privateMarkerFound = false;
for (const path of files) {
  const contents = await readFile(path, "utf8");
  if (forbidden.some((pattern) => pattern.test(contents))) privateMarkerFound = true;
}
if (privateMarkerFound) {
  console.error("Static export contains a server-only credential/config marker; file contents are withheld.");
  process.exitCode = 1;
} else {
  if (!process.exitCode) console.log(`Static export contains both entry pages and ${fontFiles.length} WOFF2 font files; scanned ${files.length} text assets with no server-only markers.`);
}
