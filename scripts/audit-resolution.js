// Comprehensive resolution audit: every episode of every season of every show
// in a capture, through the REAL resolver against LIVE Jimaku, scored on the
// three things that actually matter.
//
// Usage:
//   node scripts/audit-resolution.js <capture.json> [options]
//     --series "substring"     only shows whose title contains this
//     --background <path>      resolve using a DIFFERENT background.js (used to
//                              prove the audit catches bugs it is supposed to)
//     --max-per-season N       cap episodes per season (default: all)
//     --out <path>             write the full JSON report
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS CHECKS, AND WHAT IT CANNOT
//
// Stated plainly, because the previous two sweeps were described as validating
// resolution when they only checked season-title classification, and five real
// bugs survived them as a result.
//
// PROVEN automatically (a flag here is a defect, not an opinion):
//   1. MIXED — one episode's result contains files that state DIFFERENT episode
//      identities. At least one of them is the wrong episode. This is the
//      Ilse's-Notebook and Naruto-episode-1 shape.
//   2. DUPLICATE — two different episodes of the same season resolve to the
//      identical file list. At least one is wrong. This is the "every episode
//      shows season 1 episode 1" shape.
//   3. COLLISION — two different Crunchyroll seasons of one show resolve to the
//      same Jimaku entry, while a distinct entry plausibly exists for each.
//      This is the Tokyo Ghoul / Slimes / Mushoku shape.
//   4. EMPTY — nothing loaded, or it threw.
//
// FLAGGED for a human (a flag here MAY be correct behaviour):
//   5. NARROWED — the result is a strict subset of the entry's usable files,
//      and at least one excluded file states no identity that would place it in
//      another episode. Possible over-narrowing (the Mugen Train shape) — but a
//      legitimately narrowed OVA collection looks the same from here.
//   6. UNACCOUNTED — the season's own name is not reflected in the resolved
//      entry's name. Sometimes correct (Attack on Titan's OADs resolve to an
//      entry called "…OVA"; One Piece's 24 arcs all share one entry), so this
//      is a reading list, not a verdict.
//
// NOT CHECKED, because there is no automatic ground truth for it:
//   - Whether the resolved entry is the RIGHT entry. Nothing available offline
//     states which Jimaku entry a given Crunchyroll season corresponds to. The
//     COLLISION and UNACCOUNTED checks approximate it from different angles;
//     neither is authoritative, and a show whose every season resolves to one
//     wrong-but-consistent entry would pass both.
//   - Whether a file with no stated episode identity belongs to this episode.
//     Batch archives and bare release names often say nothing, and bare numbers
//     can carry OPPOSITE meanings inside one entry (My Dress-Up Darling has one
//     uploader numbering absolutely and another per season). Such files are
//     counted as UNSCOREABLE and are neither credited nor penalised.
//   - Whether the subtitles are correct Japanese for the scene on screen. Only
//     a human watching can establish that.
//
// The capture supplies Crunchyroll's CMS metadata, not the JSON-LD the
// extension actually reads. The episode number is reconstructed the way
// content.js derives it (title code first, `episode_number` as fallback); those
// two sources agreed on 2,356 of 2,385 episodes when measured, but they are not
// the same field and a divergence here would not be visible.
// ─────────────────────────────────────────────────────────────────────────────

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const args = process.argv.slice(2);
const capturePath = args[0];
if (!capturePath) {
  console.error("usage: node scripts/audit-resolution.js <capture.json> [--series x] [--background path] [--max-per-season N] [--out path]");
  process.exit(2);
}
const opt = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const seriesFilter = opt("--series") ? opt("--series").toLowerCase() : null;
const backgroundPath = opt("--background", path.join(__dirname, "..", "background.js"));
const maxPerSeason = Number(opt("--max-per-season")) || Infinity;
const outPath = opt("--out");

const KEY = process.env.JIMAKU_API_KEY;
if (!KEY) {
  console.error("JIMAKU_API_KEY is not set (it lives in ~/.zshenv).");
  process.exit(2);
}

// ── throttle ────────────────────────────────────────────────────────────────
const SPACING_MS = 700;
let lastRequest = 0;
async function throttledFetch(url, init) {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, lastRequest + SPACING_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const res = await globalThis.fetch(url, init);
    if (res.status !== 429 || attempt >= 4) return res;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

// ── the resolver under test ─────────────────────────────────────────────────
const logs = [];
const sandbox = {
  console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push("WARN " + a.join(" ")), error() {} },
  fetch: (...a) => throttledFetch(...a),
  importScripts: () => {},
  chrome: { runtime: { onMessage: { addListener: () => {} }, getURL: (s) => s }, storage: { local: { get: async () => ({}), set: async () => {} } } },
  setTimeout,
  clearTimeout,
  URL,
};
vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(backgroundPath, "utf8") +
    ";this.__x = { resolveTextFiles, looseTitle, ARCHIVE_RE };",
  sandbox,
  { filename: backgroundPath }
);
const { resolveTextFiles, looseTitle, ARCHIVE_RE } = sandbox.__x;

// ── episode identity stated by a filename ───────────────────────────────────
// Every form seen in real listings. A file stating nothing is UNSCOREABLE, not
// a failure — that distinction is the whole reason this is trustworthy.
// The episode NUMBERS a filename could be stating. Returned as a set rather
// than a label, because the same episode is written many ways and comparing
// labels manufactures disagreements: "[Cleo]Tokyo_Ghoul_-_01" and
// "…S01E01" both mean episode 1 and must not read as two different episodes.
// Two files disagree only when the numbers they state share nothing.
function statedIdentity(name) {
  const n = String(name ?? "");
  // A batch archive spanning a range identifies no single episode.
  if (/\b\d{1,4}\s*[-–—]\s*\d{1,4}\b/.test(n) && ARCHIVE_RE.test(n)) return [];
  const nums = new Set();
  const abs = n.match(/第\s*(\d{1,4})\s*話/);
  if (abs) nums.add(Number(abs[1]));
  const sxe = n.match(/(?:^|[^A-Za-z0-9])[Ss](\d{1,2})[Ee](\d{1,3})(?![0-9])/);
  if (sxe) nums.add(Number(sxe[2]));
  const srel = n.match(/[Ss](\d)\s*-\s*(\d{1,3})(?:v\d)?(?=[\s[(]|$)/);
  if (srel) nums.add(Number(srel[2]));
  if (!srel) {
    const bare = n.match(/\s[-–—]\s(\d{1,4})(?:v\d+)?(?=[\s[(「【]|$)/);
    if (bare) nums.add(Number(bare[1]));
  }
  return [...nums];
}

const jimaku = async (url) => {
  const r = await throttledFetch(url, { headers: { Authorization: KEY } });
  return r.ok ? r.json() : null;
};
const entryFilesCache = new Map();
async function entryFiles(id) {
  if (!entryFilesCache.has(id)) entryFilesCache.set(id, (await jimaku(`https://jimaku.cc/api/entries/${id}/files`)) ?? []);
  return entryFilesCache.get(id);
}

// ── run ─────────────────────────────────────────────────────────────────────
const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
const findings = [];
const add = (kind, proven, row) => findings.push({ kind, proven, ...row });

(async () => {
  const seriesList = Object.values(capture.series ?? {}).filter(
    (s) => !seriesFilter || String(s.seriesTitle ?? "").toLowerCase().includes(seriesFilter)
  );
  let episodesTested = 0;

  for (const series of seriesList) {
    const seriesTitle = series.seriesTitle ?? series.seriesId;
    const seasonEntryIds = new Map();

    for (const season of series.seasons ?? []) {
      const eps = (season.episodes ?? []).slice(0, maxPerSeason);
      if (!eps.length) continue;
      const perEpisode = [];

      for (const ep of eps) {
        // Reconstructed the way content.js derives it: the title code first,
        // `episode_number` only as a fallback.
        const code = ep.episode;
        const numericCode = /^\d+$/.test(String(code)) ? Number(code) : null;
        const episode = numericCode ?? (Number.isInteger(ep.episode_number) ? ep.episode_number : 1);
        const compound = `${season.title} | E${code ?? episode} - ${ep.title ?? ""}`;

        logs.length = 0;
        let result = null;
        let error = null;
        try {
          result = await resolveTextFiles(
            seriesTitle,
            episode,
            { Authorization: KEY },
            Number.isInteger(season.season_number) ? season.season_number : null,
            season.title,
            compound,
            []
          );
        } catch (e) {
          error = e.message;
        }
        episodesTested++;
        const label = { series: seriesTitle, season: season.title, episode, episodeTitle: ep.title };

        if (error || !result || result.unresolved || !result.textFiles?.length) {
          add("EMPTY", true, { ...label, detail: error ?? (result?.unresolved ? "no entry identified" : "no files") });
          perEpisode.push({ episode, files: [], entryId: result?.entryId ?? null });
          continue;
        }

        const names = result.textFiles.map((f) => f.name);
        perEpisode.push({ episode, files: names, entryId: result.entryId });
        seasonEntryIds.set(season.title, result.entryId);

        // 1. MIXED — the result states more than one episode identity.
        // Disagreement means NO episode number is stated by all of them.
        const ids = names.map(statedIdentity).filter((a) => a.length);
        if (ids.length > 1) {
          const shared = ids.reduce((acc, cur) => acc.filter((n) => cur.includes(n)));
          if (!shared.length) {
            add("MIXED", true, {
              ...label,
              detail: `${ids.length} files state episode numbers with nothing in common: ${JSON.stringify(ids.slice(0, 6))}`,
              files: names.slice(0, 6),
            });
          }
        }

        // 5. NARROWED — a strict subset, with an excluded file that states
        //    nothing placing it elsewhere.
        const all = (await entryFiles(result.entryId)).filter((f) => !ARCHIVE_RE.test(f.name));
        if (all.length > names.length) {
          const kept = new Set(names);
          const excludedSilent = all.filter((f) => !kept.has(f.name) && !statedIdentity(f.name).length);
          if (excludedSilent.length) {
            add("NARROWED", false, {
              ...label,
              detail: `kept ${names.length} of ${all.length}; ${excludedSilent.length} excluded file(s) state no episode of their own`,
              files: excludedSilent.slice(0, 4).map((f) => f.name),
            });
          }
        }

        // 6. UNACCOUNTED — the season's own name is absent from the entry's.
        const entryLoose = looseTitle(result.entryName);
        const seasonExtra = looseTitle(season.title)
          .split(" ")
          .filter((w) => w && !looseTitle(seriesTitle).split(" ").includes(w) && !/^\d+$/.test(w) &&
            !["season", "part", "cour", "english", "dub", "sub", "subtitled", "hd", "edition", "the", "of", "and"].includes(w));
        if (seasonExtra.length && !seasonExtra.some((w) => entryLoose.includes(w))) {
          add("UNACCOUNTED", false, { ...label, detail: `season "${season.title}" -> entry "${result.entryName}"` });
        }
      }

      // 2. DUPLICATE — two episodes of this season with an identical file list.
      const seen = new Map();
      for (const r of perEpisode) {
        if (!r.files.length) continue;
        const key = r.files.slice().sort().join(" ");
        if (seen.has(key)) {
          add("DUPLICATE", true, {
            series: seriesTitle,
            season: season.title,
            episode: r.episode,
            detail: `identical file list to episode ${seen.get(key)}`,
            files: r.files.slice(0, 3),
          });
        } else seen.set(key, r.episode);
      }
    }

    // 3. COLLISION — two seasons of this show sharing one entry.
    const byEntry = new Map();
    for (const [seasonTitle, id] of seasonEntryIds) {
      if (id == null) continue;
      if (!byEntry.has(id)) byEntry.set(id, []);
      byEntry.get(id).push(seasonTitle);
    }
    for (const [id, seasonsSharing] of byEntry) {
      if (seasonsSharing.length > 1) {
        add("COLLISION", true, {
          series: seriesTitle,
          detail: `${seasonsSharing.length} seasons all resolve to entry ${id}`,
          seasons: seasonsSharing,
        });
      }
    }
  }

  // ── report ────────────────────────────────────────────────────────────────
  const proven = findings.filter((f) => f.proven);
  const flagged = findings.filter((f) => !f.proven);
  const count = (k) => findings.filter((f) => f.kind === k).length;

  console.log(`\n${"═".repeat(78)}`);
  console.log(`Audited ${episodesTested} episodes across ${seriesList.length} show(s), resolver: ${path.basename(backgroundPath)}`);
  console.log(`\nPROVEN DEFECTS (${proven.length}):  MIXED ${count("MIXED")}   DUPLICATE ${count("DUPLICATE")}   COLLISION ${count("COLLISION")}   EMPTY ${count("EMPTY")}`);
  for (const f of proven.slice(0, 40)) {
    console.log(`  [${f.kind}] ${f.series}${f.season ? ` / ${f.season}` : ""}${f.episode != null ? ` ep${f.episode}` : ""}`);
    console.log(`      ${f.detail}`);
    if (f.seasons) console.log(`      ${JSON.stringify(f.seasons)}`);
    for (const n of f.files ?? []) console.log(`      · ${String(n).slice(0, 72)}`);
  }
  console.log(`\nFLAGGED FOR REVIEW (${flagged.length}):  NARROWED ${count("NARROWED")}   UNACCOUNTED ${count("UNACCOUNTED")}`);
  console.log(`  (these MAY be correct — see the header for why neither can be decided automatically)`);
  for (const f of flagged.slice(0, 25)) {
    console.log(`  [${f.kind}] ${f.series} / ${f.season} ep${f.episode}: ${f.detail}`);
    for (const n of f.files ?? []) console.log(`      · ${String(n).slice(0, 72)}`);
  }
  console.log("");

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ resolver: backgroundPath, episodesTested, findings }, null, 1));
    console.log(`full report -> ${outPath}\n`);
  }
  process.exit(proven.length ? 1 : 0);
})();
