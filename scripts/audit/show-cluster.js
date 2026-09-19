// Prints examples of parse-sweep clusters. Usage: node scripts/audit/show-cluster.js <report.json> <type> [signature-substring] [n]
"use strict";
const [report, type, sig = "", n = "15"] = process.argv.slice(2);
const d = JSON.parse(require("fs").readFileSync(report, "utf8"));
for (const c of d.clusters.filter((c) => c.type === type && c.signature.includes(sig))) {
  console.log(`\n■ ${c.type} :: ${c.signature}  (${c.count} occurrences, ${c.lines} lines, ${c.files.length} files)`);
  for (const ex of c.examples.slice(0, Number(n))) console.log(`   ${ex.word != null ? `«${String(ex.word).slice(0, 30)}» ` : ""}${String(ex.line).replace(/\n/g, "⏎").slice(0, 100)}   [${String(ex.file).slice(0, 40)}]`);
}
