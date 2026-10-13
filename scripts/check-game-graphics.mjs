import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const manifest = (await readFile("tests/fixtures/game-graphics.sha256", "utf8")).trim();
const entries = manifest.split(/\r?\n/).map((line) => {
  const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
  if (!match) throw new Error("Invalid graphics baseline manifest");
  return { expected: match[1], path: match[2] };
});
const mismatches = [];
for (const { expected, path } of entries) {
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== expected) mismatches.push(path);
}
if (mismatches.length) {
  console.error(`Game graphics differ from the migration baseline: ${mismatches.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${entries.length} game graphics and animation source files against the migration baseline.`);
}
