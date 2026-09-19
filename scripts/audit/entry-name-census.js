// Offline census over every cached Jimaku search response (2026-09-18).
// Measures three entry-name classes from the failure taxonomy:
//   DUP-NAME      two entries in ONE result set share a name/english_name — the
//                 resolver's tiers take `.find()`'s first, silently (taxonomy D6)
//   WORD-MARKER   a season marker parseSeasonMarker can't read (taxonomy B2)
//   UNICODE-VARIANT  two names equal only after NFKC / look-alike folding (B7)
// Usage: node scripts/audit/entry-name-census.js
"use strict";
const fs = require("fs");
const path = require("path");
const { DEFAULT_CACHE_DIR } = require("./jimaku-client.js");
const { loadBackground } = require("./load-background.js");
const bg = loadBackground({ fetch: async () => { throw new Error("offline"); }, exportNames: ["parseSeasonMarker", "normalizeTitle"] });

const sets = [];
const names = new Map();
for (const f of fs.readdirSync(DEFAULT_CACHE_DIR)) {
  const rec = JSON.parse(fs.readFileSync(path.join(DEFAULT_CACHE_DIR, f), "utf8"));
  if (!/\/entries\/search/.test(rec.url)) continue;
  const entries = JSON.parse(rec.body);
  sets.push({ url: rec.url, entries });
  for (const e of entries) names.set(e.id, e);
}
const out = { DUP: [], WORD: [], UNI: [] };
for (const { url, entries } of sets) {
  const by = new Map();
  for (const e of entries)
    for (const n of new Set([e.name, e.english_name].filter(Boolean).map((x) => bg.looseTitle(x)))) {
      if (!by.has(n)) by.set(n, new Set());
      by.get(n).add(e.id);
    }
  for (const [n, ids] of by) if (ids.size > 1) out.DUP.push(`${decodeURIComponent(url.split("query=")[1])}: "${n}" → ids ${[...ids].join(",")}`);
}
const WORD_RE = /\b(first|second|third|fourth|fifth|sixth|final)\s+(season|cour|part)\b|\bseason\s+(one|two|three|four|five|six)\b|\b\d+(st|nd|rd|th)\s+(cour|part)\b|\bpart\s+(ii|iii|iv)\b|\bs\d{1,2}\b/i;
const fold = (s) => String(s ?? "").normalize("NFKC").replace(/[×✕]/g, "x").replace(/[～〜]/g, "~").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const byLoose = new Map();
for (const e of names.values()) {
  for (const n of [e.name, e.english_name].filter(Boolean)) {
    if (WORD_RE.test(n) && bg.parseSeasonMarker(n).season === 1) out.WORD.push(`${e.id}: "${n}" → parsed as season 1`);
    const k = fold(n);
    if (!byLoose.has(k)) byLoose.set(k, new Set());
    byLoose.get(k).add(bg.looseTitle(n));
  }
}
for (const [k, v] of byLoose) if (v.size > 1) out.UNI.push(`${[...v].map((x) => `"${x}"`).join(" vs ")}`);
console.log(`${sets.length} cached search responses, ${names.size} distinct entries`);
for (const [k, rows] of Object.entries(out)) {
  console.log(`\n${k}: ${rows.length}`);
  for (const r of [...new Set(rows)].slice(0, 25)) console.log("  " + r);
}
