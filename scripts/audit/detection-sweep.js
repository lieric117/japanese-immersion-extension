// Detection sweep (2026-09-18): every episode of every season in one or more
// live Crunchyroll catalogue captures, through the REAL fetchSubtitles (not
// just resolveTextFiles), against live Jimaku responses cached on disk.
//
// Usage:
//   node scripts/audit/detection-sweep.js <capture.json> [<capture.json> ...]
//       [--only "a,b"] [--exclude "a,b"] [--max-per-season N] [--sample]
//       [--background <path>] [--out <report.json>] [--no-remembered]
//   JIMAKU_CACHE_MODE=offline  replays a previous run's responses exactly
//
// What it adds over audit-resolution.js — each one a class that tool was blind
// to, found while mapping the pipeline (docs/audit/pipeline-map.md):
//
//   PICKED-OFF-EPISODE  (proven) the file fetchSubtitles actually LOADS states an
//                       episode, not this one, while another file in the list
//                       does state this one. The default on screen is wrong.
//   SEASON-MIX          (flagged) one episode's list holds the same episode number
//                       under two different SxxEyy seasons — two different
//                       episodes — or one episode two providers label differently
//                       (Netflix files a sequel as its own show), hence flagged.
//   FRACTIONAL-IN-LIST  (proven) an integer episode's list holds a file naming a
//                       fractional position (第13.5話) — a special.
//   NONE-STATES-EPISODE (flagged) files state episodes, none of them this one (or
//                       the offset the resolver logged). Possibly an unparsed
//                       convention; possibly the wrong episode.
//   REMEMBERED-DIVERGES (proven when the remembered pick states another episode)
//                       the user picked the SAME entry the resolver chose, and
//                       the remembered-entry path then loads something different.
//                       Most favourable case for that path: if it goes wrong
//                       here, it goes wrong on every manual pick.
//
// Every Crunchyroll-derived string comes verbatim from the capture (live CMS
// data). The one reconstructed input is the JSON-LD compound `name`
// ("<season> | E<code> - <title>"), built in the shape measured on real pages —
// same caveat audit-resolution.js carries.

"use strict";

const fs = require("fs");
const path = require("path");
const { createJimakuClient } = require("./jimaku-client.js");
const { loadBackground } = require("./load-background.js");
const { fileClaims, seasonMixes, ARCHIVE_RE } = require("./file-identity.js");

const args = process.argv.slice(2);
const opt = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const VALUE_FLAGS = new Set(["--out", "--background", "--lists", "--only", "--exclude", "--max-per-season"]);
const captures = args.filter((a, i) => a.endsWith(".json") && !VALUE_FLAGS.has(args[i - 1]));
if (!captures.length) {
  console.error("usage: node scripts/audit/detection-sweep.js <capture.json>... [--only a,b] [--max-per-season N] [--out path]");
  process.exit(2);
}
const list = (s) => (s ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const onlys = list(opt("--only"));
const excludes = list(opt("--exclude"));
const maxPerSeason = Number(opt("--max-per-season")) || Infinity;
const sample = args.includes("--sample");
const outPath = opt("--out");
const withRemembered = !args.includes("--no-remembered");
// --lists <path>: every episode's outcome (entry, file list, auto-picked file),
// for diffing two resolvers on the same cached data.
const listsPath = opt("--lists");
const lists = [];
const FILE_HINT = "[JPN]"; // content.js's FILE_HINT, sent on every FETCH_SUBTITLES

const client = createJimakuClient({ log: (m) => process.stdout.write(m + "\n") });
// Subtitle downloads are stubbed: this sweep scores WHICH file is chosen, and a
// download per episode would double the request budget for nothing.
const DOWNLOAD_RE = /\/download\//;
const sandboxFetch = async (url, init) => {
  if (DOWNLOAD_RE.test(String(url)) || !/^https:\/\/jimaku\.cc\/api\//.test(String(url))) {
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  }
  return client.fetch(url, init);
};
const bg = loadBackground({
  fetch: sandboxFetch,
  backgroundPath: opt("--background") ?? undefined,
  exportNames: ["rankFiles", "applyFileHint"],
  storage: { jimakuApiKey: process.env.JIMAKU_API_KEY ?? "offline" },
});

const findings = [];
const add = (kind, proven, row) => findings.push({ kind, proven, ...row });
let episodes = 0;
let offlineMisses = 0;

function pickEpisodes(eps) {
  if (!sample || eps.length <= 6) return eps.slice(0, maxPerSeason);
  // First three, middle, last two: covers season openers, cour boundaries and
  // the absolute/relative tail where most numbering faults live.
  const idx = new Set([0, 1, 2, Math.floor(eps.length / 2), eps.length - 2, eps.length - 1]);
  return eps.filter((_, i) => idx.has(i));
}

function episodeFor(ep) {
  const code = ep.episode;
  const numericCode = /^\d+$/.test(String(code)) ? Number(code) : null;
  const hasNoPosition = numericCode === null && !Number.isInteger(ep.episode_number);
  return { code, hasNoPosition, episode: numericCode ?? (Number.isInteger(ep.episode_number) ? ep.episode_number : 1) };
}

// The local episode number the resolver actually looked up, when it logged an
// offset ("… episode 43 is its 18 …" / "… episode 6 is its 19 …").
function derivedEpisodes(logs, episode) {
  const out = new Set([episode]);
  for (const l of logs) {
    const m = l.match(/episode \d+ is its (\d+)/);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

async function run() {
  for (const capturePath of captures) {
    const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
    const tag = path.basename(capturePath);
    for (const series of Object.values(capture.series ?? {})) {
      const seriesTitle = series.seriesTitle ?? series.seriesId;
      const t = String(seriesTitle).toLowerCase();
      if (onlys.length && !onlys.some((x) => t.includes(x))) continue;
      if (excludes.some((x) => t.includes(x))) continue;
      for (const season of series.seasons ?? []) {
        // The season's own highest Crunchyroll number: a stated number above it
        // can be the same episode counted absolutely (Frieren S2 ep 1 is
        // Haruhana's "- 29"), so it is never scored as a different episode —
        // the convention audit-resolution.js settled on 2026-08-11.
        const seasonMax = Math.max(...(season.episodes ?? []).map((e) => episodeFor(e).episode));
        for (const ep of pickEpisodes(season.episodes ?? [])) {
          const { code, hasNoPosition, episode } = episodeFor(ep);
          if (hasNoPosition) continue;
          const detected = {
            query: seriesTitle,
            episode,
            seasonNumber: Number.isInteger(season.season_number) ? season.season_number : null,
            seasonName: season.title,
            episodeTitle: `${season.title} | E${code ?? episode} - ${ep.title ?? ""}`,
          };
          const label = { capture: tag, series: seriesTitle, season: season.title, episode, episodeTitle: ep.title };
          episodes++;
          if (episodes % 100 === 0) {
            const p = findings.filter((f) => f.proven).length;
            process.stdout.write(`   … ${episodes} episodes, ${p} proven, cache ${client.stats.hits} hit / ${client.stats.fetched} fetched\n`);
          }
          bg.logs.length = 0;
          let res = null;
          let error = null;
          try {
            res = await bg.fetchSubtitles({ ...detected, fileHint: FILE_HINT, siblingTitles: [] });
          } catch (e) {
            error = e;
          }
          if (error?.offlineMiss || /offline cache miss/.test(error?.message ?? "")) {
            offlineMisses++;
            continue;
          }
          lists.push({
            key: `${tag}|${seriesTitle}|${season.title}|${episode}`,
            outcome: error ? `ERROR ${error.message}` : res?.entryUnresolved ? "UNRESOLVED" : `entry ${res?.entryId}`,
            files: (res?.files ?? []).map((f) => f.name),
            picked: res?.files?.find((f) => f.url === res.selectedUrl)?.name ?? null,
          });
          if (error || !res || res.entryUnresolved || !res.files?.length) continue; // declines/empties are audit-resolution's job
          const logs = [...bg.logs];
          const names = res.files.map((f) => f.name);
          const picked = res.files.find((f) => f.url === res.selectedUrl)?.name ?? null;
          const wanted = derivedEpisodes(logs, episode);
          const nonEpisodic = logs.some((l) => /not asking Jimaku for episode/.test(l));

          if (!nonEpisodic) {
            const claims = names.map((n) => ({ n, c: fileClaims(n) }));
            const stating = claims.filter((x) => x.c.episodes.size);
            const statesWanted = stating.filter((x) => [...x.c.episodes].some((e) => wanted.has(e)));
            const pickedClaims = picked ? fileClaims(picked) : null;
            const inSeason = (e) => e <= seasonMax;
            if (
              pickedClaims?.episodes.size &&
              ![...pickedClaims.episodes].some((e) => wanted.has(e) || !inSeason(e)) &&
              statesWanted.length
            ) {
              add("PICKED-OFF-EPISODE", true, {
                ...label,
                detail: `auto-loaded "${picked}" states ${JSON.stringify([...pickedClaims.episodes])}; ${statesWanted.length} file(s) state ${[...wanted].join("/")}`,
                files: names.slice(0, 6),
              });
            }
            if (stating.length && !statesWanted.length) {
              add("NONE-STATES-EPISODE", false, {
                ...label,
                detail: `${stating.length}/${names.length} file(s) state episodes ${JSON.stringify([...new Set(stating.flatMap((x) => [...x.c.episodes]))].slice(0, 8))}, none ${[...wanted].join("/")}`,
                files: names.slice(0, 6),
              });
            }
            // Proven: a fractional position is a special between episodes, never
            // an integer episode (MHA S1 ep 1 carried "第13.5話").
            for (const n of names.filter((n) => /第\s*\d{1,4}\.\d\s*話|\s[-–—]\s\d{1,4}\.\d(?=[\s[(「【]|\.[^\d]|$)|[Ss]\d{1,2}[Ee]\d{1,4}\.\d(?![\d\p{L}]|\.\d)/u.test(n))) {
              add("FRACTIONAL-IN-LIST", true, { ...label, detail: `integer episode ${episode}'s list holds "${n}"` });
            }
            // FLAGGED, not proven: providers label the same episode under
            // different seasons (Netflix files Haikyu!! S2 as its own show,
            // S01E01), measured 2026-09-18.
            for (const mix of seasonMixes(names)) {
              add("SEASON-MIX", false, {
                ...label,
                detail: `episode ${mix.episode} under seasons ${mix.seasons.map((s) => `S${s.season} (${s.files.length})`).join(", ")}`,
                files: mix.seasons.flatMap((s) => s.files).slice(0, 6),
              });
            }
          }

          if (withRemembered && Number.isInteger(res.entryId)) {
            bg.logs.length = 0;
            let rem = null;
            try {
              rem = await bg.fetchSubtitles({ ...detected, fileHint: FILE_HINT, siblingTitles: [], preferredEntryId: res.entryId });
            } catch (e) {
              if (/offline cache miss/.test(e.message)) {
                offlineMisses++;
                continue;
              }
            }
            const remPicked = rem?.files?.find((f) => f.url === rem.selectedUrl)?.name ?? null;
            const same = rem && JSON.stringify(rem.files.map((f) => f.name).sort()) === JSON.stringify([...names].sort());
            if (rem && !same) {
              const pc = remPicked ? fileClaims(remPicked) : null;
              const wrong = pc?.episodes.size && ![...pc.episodes].some((e) => wanted.has(e));
              add("REMEMBERED-DIVERGES", Boolean(wrong) && !nonEpisodic, {
                ...label,
                detail:
                  `resolver: ${names.length} file(s), picked "${picked}"; remembered same entry: ${rem.files.length} file(s), picked "${remPicked}"` +
                  (wrong ? ` — which states ${JSON.stringify([...pc.episodes])}` : ""),
              });
            }
          }
        }
      }
    }
  }

  const count = (k) => findings.filter((f) => f.kind === k).length;
  const proven = findings.filter((f) => f.proven);
  console.log(`\n${"═".repeat(78)}`);
  console.log(`Swept ${episodes} episodes from ${captures.map((c) => path.basename(c)).join(", ")}`);
  console.log(`Jimaku: ${client.stats.hits} from cache, ${client.stats.fetched} fetched, ${client.stats.failures} failed, ${client.stats.rateLimited} rate-limited, ${offlineMisses} offline misses (mode ${client.mode})`);
  console.log(
    `PROVEN (${proven.length}): PICKED-OFF-EPISODE ${count("PICKED-OFF-EPISODE")}   SEASON-MIX ${count("SEASON-MIX")}   ` +
      `REMEMBERED-DIVERGES(wrong) ${proven.filter((f) => f.kind === "REMEMBERED-DIVERGES").length}   FRACTIONAL-IN-LIST ${count("FRACTIONAL-IN-LIST")}`
  );
  console.log(`FLAGGED: NONE-STATES-EPISODE ${count("NONE-STATES-EPISODE")}   SEASON-MIX ${count("SEASON-MIX")}   REMEMBERED-DIVERGES(all) ${count("REMEMBERED-DIVERGES")}`);
  const byKind = {};
  for (const f of findings) (byKind[f.kind] ??= []).push(f);
  for (const [kind, rows] of Object.entries(byKind)) {
    console.log(`\n[${kind}] ${rows.length}`);
    for (const f of rows.slice(0, 12)) {
      console.log(`  ${f.series} / ${f.season} ep${f.episode}: ${f.detail}`);
      for (const n of (f.files ?? []).slice(0, 4)) console.log(`      · ${String(n).slice(0, 90)}`);
    }
  }
  if (listsPath) fs.writeFileSync(listsPath, JSON.stringify(lists));
  if (outPath) fs.writeFileSync(outPath, JSON.stringify({ episodes, stats: client.stats, offlineMisses, findings }, null, 1));
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
