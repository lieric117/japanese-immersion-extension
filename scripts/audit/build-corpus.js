// Builds a structurally diverse subtitle corpus from real Jimaku files for the
// parsing sweep (2026-09-18). Downloads are cached on disk by jimaku-client.js,
// so a corpus is fetched once and every later sweep replays it.
//
// Usage:
//   node scripts/audit/build-corpus.js <capture.json>... [--extra] [--per-entry N] [--max-files N]
//        [--out .audit-cache/corpus.json]
//
// Diversity is structural, not topical: within each entry one file is taken per
// (release group, format) bucket, because parsing faults follow the PROVIDER
// (SubsPlease's .ass conventions, Netflix .srt rips, NanakoRaws' stacked cues,
// dual-language fansubs) far more than they follow the show. Series come from
// the live catalogue captures plus a hand-picked list chosen for register and
// dialect variety the captures (mostly long shounen franchises) lack.

"use strict";

const fs = require("fs");
const path = require("path");
const { createJimakuClient } = require("./jimaku-client.js");

const args = process.argv.slice(2);
const opt = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const captures = args.filter((a, i) => a.endsWith(".json") && args[i - 1] !== "--out");
const perEntry = Number(opt("--per-entry")) || 4;
const maxFiles = Number(opt("--max-files")) || 400;
const outPath = opt("--out") ?? path.join(__dirname, "..", "..", ".audit-cache", "corpus.json");

// Chosen for what the captures lack: slice-of-life register, heavy dialect,
// wordplay, films, and old/new release eras. Titles only — each goes through
// Jimaku's own search like any other.
const EXTRA_SERIES = [
  "Bocchi the Rock", "Frieren", "Witch Hat Atelier", "K-On", "Yuru Camp", "Kaguya-sama",
  "Oshi no Ko", "Non Non Biyori", "Barakamon", "Monogatari", "Nichijou", "Hibike! Euphonium",
  "Mushishi", "Azumanga Daioh", "Kimi no Na wa", "Hyouka", "Chihayafuru", "Silver Spoon",
  "Kin-iro Mosaic", "Aria the Animation", "Showa Genroku Rakugo Shinju", "Violet Evergarden",
  "Dungeon Meshi", "Kusuriya no Hitorigoto", "Spy x Family", "Chainsaw Man", "Mob Psycho 100",
  "Natsume Yuujinchou", "Gintama", "Lucky Star",
];

const client = createJimakuClient({ log: (m) => process.stdout.write(m + "\n") });
const API = "https://jimaku.cc/api";
const get = async (url) => {
  const r = await client.fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

const ARCHIVE_RE = /\.(7z|zip|rar|gz|tar|bz2)$/i;
const TEXT_RE = /\.(ass|ssa|srt)$/i;
function bucketOf(name) {
  const tag = name.match(/^\[([^\]]+)\]/)?.[1];
  const src = tag ?? (name.match(/\b(Netflix|NF|Amazon|AMZN|CR|Crunchyroll|HIDIVE|ABEMA|Hulu|DSNP|B-Global|U-NEXT|Baha|WEB[- ]?DL|BD|BDRip|TV|DVD)\b/i)?.[1] ?? "untagged");
  const ext = name.match(/\.(\w+)$/)?.[1]?.toLowerCase() ?? "?";
  return `${src.toLowerCase()}|${ext}`;
}

(async () => {
  const seriesTitles = new Set(EXTRA_SERIES);
  if (!args.includes("--extra-only")) {
    for (const c of captures) {
      const cap = JSON.parse(fs.readFileSync(c, "utf8"));
      for (const s of Object.values(cap.series ?? {})) if (s.seriesTitle) seriesTitles.add(s.seriesTitle);
    }
  }
  console.log(`${seriesTitles.size} series to sample`);
  const corpus = [];
  const seenEntries = new Set();
  for (const title of seriesTitles) {
    if (corpus.length >= maxFiles) break;
    let entries;
    try {
      entries = await get(`${API}/entries/search?anime=true&query=${encodeURIComponent(title.replace(/['’‘`]/g, ""))}`);
    } catch (e) {
      console.log(`  search failed for "${title}": ${e.message}`);
      continue;
    }
    // Up to two entries per series: the first TV entry and the first film, so
    // both release shapes are represented.
    const tv = entries.find((e) => !e.flags?.movie);
    const movie = entries.find((e) => e.flags?.movie);
    for (const entry of [tv, movie].filter(Boolean)) {
      if (seenEntries.has(entry.id)) continue;
      seenEntries.add(entry.id);
      let files;
      try {
        files = await get(`${API}/entries/${entry.id}/files`);
      } catch (e) {
        console.log(`  listing failed for entry ${entry.id}: ${e.message}`);
        continue;
      }
      const text = files.filter((f) => TEXT_RE.test(f.name) && !ARCHIVE_RE.test(f.name));
      const buckets = new Map();
      for (const f of text) {
        const b = bucketOf(f.name);
        if (!buckets.has(b)) buckets.set(b, []);
        buckets.get(b).push(f);
      }
      // Mid-listing file from each bucket: avoids always sampling episode 1,
      // whose OP/credit-heavy shape is untypical.
      const picks = [...buckets.values()].map((fs_) => fs_[Math.floor(fs_.length / 2)]).slice(0, perEntry);
      for (const f of picks) {
        corpus.push({ series: title, entryId: entry.id, entryName: entry.english_name ?? entry.name, movie: Boolean(entry.flags?.movie), bucket: bucketOf(f.name), name: f.name, url: f.url });
      }
      console.log(`  ${title} → entry ${entry.id} (${text.length} text files, ${buckets.size} buckets) +${picks.length}`);
    }
  }
  // Download everything now so the sweep itself can run offline.
  let ok = 0;
  for (const item of corpus.slice(0, maxFiles)) {
    try {
      const r = await client.fetch(item.url);
      if (r.ok) ok++;
      else item.downloadError = r.status;
    } catch (e) {
      item.downloadError = e.message;
    }
    if (ok % 25 === 0) process.stdout.write(`   … ${ok} downloaded\n`);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(corpus.slice(0, maxFiles), null, 1));
  console.log(`corpus: ${Math.min(corpus.length, maxFiles)} files (${ok} downloaded) → ${outPath}`);
  console.log(`Jimaku: ${client.stats.hits} cached, ${client.stats.fetched} fetched, ${client.stats.failures} failed`);
})();
