// Diffs two detection-sweep --lists dumps (2026-09-18): every episode whose
// outcome, file list or auto-picked file changed between two resolvers run on
// the same cached data. Files REMOVED are listed explicitly — the check that a
// fix only ever drops wrong files, never a legitimate alternate.
// Usage: node scripts/audit/diff-lists.js <before.json> <after.json>
"use strict";
const fs = require("fs");
const [a, b] = process.argv.slice(2).map((p) => new Map(JSON.parse(fs.readFileSync(p, "utf8")).map((r) => [r.key, r])));
let changed = 0;
const kinds = {};
for (const [key, before] of a) {
  const after = b.get(key);
  if (!after) continue;
  const removed = before.files.filter((f) => !after.files.includes(f));
  const added = after.files.filter((f) => !before.files.includes(f));
  if (before.outcome === after.outcome && !removed.length && !added.length && before.picked === after.picked) continue;
  changed++;
  const kind = before.outcome !== after.outcome ? `${before.outcome.split(" ")[0]} → ${after.outcome.split(" ")[0]}` : "files";
  kinds[kind] = (kinds[kind] ?? 0) + 1;
  console.log(`\n${key}\n  ${before.outcome} → ${after.outcome}`);
  for (const f of removed.slice(0, 6)) console.log(`  - ${f}`);
  for (const f of added.slice(0, 6)) console.log(`  + ${f}`);
  if (before.picked !== after.picked) console.log(`  picked: ${before.picked} → ${after.picked}`);
}
console.log(`\n${changed} of ${a.size} episodes changed: ${JSON.stringify(kinds)}`);
