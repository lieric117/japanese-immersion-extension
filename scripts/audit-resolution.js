// Comprehensive resolution audit: every episode of every season of every show
// in a capture, through the REAL resolver against LIVE Jimaku, scored on the
// three things that actually matter.
//
// Usage:
//   node scripts/audit-resolution.js <capture.json> [options]
//     --series "substring"     only shows whose title contains this
//     --exclude "a,b,c"        skip shows whose title contains any of these
//     --only "a,b,c"           run ONLY shows matching these (batching)
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
//      This is the Tokyo Ghoul / Slimes / Mushoku shape. The second half of
//      that sentence is now actually CHECKED (2026-08-11): a franchise Jimaku
//      keeps in a single entry reports SHARED-ENTRY instead.
//   4. EMPTY — nothing loaded, it was not a deliberate refusal, and the
//      season's entry either states this episode or carries a second numbering
//      population that could hold it. Where neither is true, Jimaku simply has
//      no such file and it reports MISSING instead (2026-08-11).
//
// FLAGGED for a human (a flag here MAY be correct behaviour):
//   5. NARROWED — on an entry whose files state NO episode identities at all
//      (so every file is plausibly the same work), the result dropped some of
//      them. Possible over-narrowing, the Mugen Train shape. Restricted to such
//      entries deliberately: where files DO state episodes, narrowing is doing
//      its job and the excluded files are other episodes and specials.
//   6. DECLINED — the resolver deliberately refused: no entry it could
//      identify, or an episode with no position that nothing names. The picker
//      or the manual-upload message is shown. Correct for content Jimaku has
//      nothing identifiable for (Tokyo Ghoul's "Root A" cannot be reached from
//      Jimaku's "√A" by any means), so it is listed rather than scored.
//   7. UNACCOUNTED — the season's own name is not reflected in the resolved
//      entry's name. Sometimes correct (Attack on Titan's OADs resolve to an
//      entry called "…OVA"; One Piece's 24 arcs all share one entry), so this
//      is a reading list, not a verdict.
//   8. MISSING — nothing loaded, and the season's entry states no such episode
//      and shows no sign of a second numbering that could hold it. Jimaku
//      appears genuinely not to have the file. Usually correct: KONOSUBA's
//      dubbed season 11s are OVAs under their own entries, Steins;Gate 0's
//      episode 24 is the unaired 23β. Worth a look only if the show should
//      obviously have it.
//   9. SHARED-ENTRY — several seasons resolve to one entry, but Jimaku holds
//      only one TV entry for the show, so there is nothing else for them to
//      resolve to. Correct by construction (Black Clover, One Piece).
//
// NOT CHECKED, because there is no automatic ground truth for it:
//   - Whether the resolved entry is the RIGHT entry. Nothing available offline
//     states which Jimaku entry a given Crunchyroll season corresponds to. The
//     COLLISION and UNACCOUNTED checks approximate it from different angles;
//     neither is authoritative, and a show whose every season resolves to one
//     wrong-but-consistent entry would pass both.
//   - Whether a differing episode number is the RIGHT one (2026-08-11). Where
//     one number falls inside the season's own range and one above it, they are
//     taken to be the same episode under two numbering conventions — the
//     Frieren / MHA / Fairy Tail shape, which used to be reported as a defect
//     on four popular shows. Nothing verifies the OFFSET, so episode 11 paired
//     with a wrong absolute 180 reads the same as the correct 170. Checking it
//     needs the season's absolute starting position, the same input the
//     resolver itself lacks (project-plan.md, RC3).
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
// Comma-separated substrings to skip. A handful of long-running shows dominate
// the runtime — five of them are 1,555 of the 2,526 episodes in the 2026-08-04
// capture — so excluding them turns the fix-and-recheck loop from an hour into
// minutes, with those shows run as their own pass.
const excludes = (opt("--exclude") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
// The inverse: run exactly these shows. Lets a large capture be walked in
// batches small enough to finish inside a single invocation, with the reports
// merged afterwards — a long single run is easily lost to an interruption.
const onlys = (opt("--only") ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
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
// Response cache keyed on URL. The resolver re-runs the same entry search for
// every episode of a season, which at 2,500 episodes is hours of identical
// requests; the catalogue does not change during a run, so one answer per URL
// is enough. Roughly a 3x reduction in wall time on a full capture.
const responseCache = new Map();
let cacheHits = 0;
let failedRequests = 0;
async function throttledFetch(url, init) {
  const key = String(url);
  if (responseCache.has(key)) {
    cacheHits++;
    const { status, body } = responseCache.get(key);
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body };
  }
  const res = await uncachedFetch(url, init);
  const body = await res.text();
  // ONLY successes are cached. Caching a failure turns one transient 429 or
  // dropped connection into a permanent one for that URL, which is what
  // inflated the 2026-08-04 run's EMPTY count to 84 (59 of them `fetch
  // failed`). A retried failure costs one request; a cached failure costs the
  // truth of the whole run.
  if (res.ok) responseCache.set(key, { status: res.status, body });
  else failedRequests++;
  return { ok: res.ok, status: res.status, json: async () => JSON.parse(body), text: async () => body };
}

async function uncachedFetch(url, init) {
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

// Is a set of disagreeing filenames just ONE episode written two ways?
//
// Measured false positive, on four shows (2026-08-11): Frieren S2 episode 9
// returns "- 37" and "S2 - 09", MHA's FINAL SEASON returns "S08E11", "第170話"
// and "S08E170", Fairy Tail Series 2 returns "176" and "1". Every one of those
// pairs is the same episode under two numbering conventions — one uploader
// counting within the season, another counting from the start of the show —
// and flagging them as PROVEN defects made the check untrustworthy where it
// mattered, because the real ones were buried among them.
//
// The boundary is the season's own highest episode number. A number at or
// below it can be this season's own numbering; a number above it can only be
// an absolute count continuing from earlier seasons. So the answer is "one
// episode two ways" when at most ONE distinct number falls on each side —
// nothing left to disagree about once the two conventions are separated.
//
// **This deliberately weakens the check**, and the trade is worth stating: a
// result mixing episode 11 with a genuinely wrong absolute number (say 180
// rather than 170) now passes, because nothing here verifies the offset is the
// RIGHT one. Verifying it needs the season's absolute starting position, which
// is exactly the input the resolver is missing (see project-plan.md, RC3). The
// alternative was leaving a check that cried wolf on four popular shows.
function oneEpisodeTwoWays(ids, seasonMaxEpisode) {
  const distinct = [...new Set(ids.flat())];
  if (!Number.isFinite(seasonMaxEpisode)) return false;
  const withinSeason = distinct.filter((n) => n <= seasonMaxEpisode);
  const absolute = distinct.filter((n) => n > seasonMaxEpisode);
  return withinSeason.length <= 1 && absolute.length <= 1;
}

// How many TV entries Jimaku holds that could plausibly serve this show's
// seasons. Movies are excluded via Jimaku's own `movie` flag — a film entry is
// never an alternative for a TV season — and the name has to share a word with
// the series title, since a fuzzy search returns unrelated shows. Returns null
// if the search fails, which makes the caller fall back to flagging.
const tvEntryCountCache = new Map();
async function countSeriesTvEntries(seriesTitle) {
  if (!tvEntryCountCache.has(seriesTitle)) {
    const found = await jimaku(`https://jimaku.cc/api/entries/search?query=${encodeURIComponent(seriesTitle)}`);
    if (!Array.isArray(found)) return null;
    const words = looseTitle(seriesTitle).split(" ").filter((w) => w.length > 2);
    const related = found.filter((e) => {
      if (e.flags?.movie) return false;
      const name = `${looseTitle(e.name ?? "")} ${looseTitle(e.english_name ?? "")}`;
      return words.some((w) => name.includes(w));
    });
    tvEntryCountCache.set(seriesTitle, related.length);
  }
  return tvEntryCountCache.get(seriesTitle);
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
    (s) => {
      const t = String(s.seriesTitle ?? "").toLowerCase();
      if (seriesFilter && !t.includes(seriesFilter)) return false;
      if (onlys.length && !onlys.some((x) => t.includes(x))) return false;
      return !excludes.some((x) => t.includes(x));
    }
  );
  let episodesTested = 0;

  for (const series of seriesList) {
    const seriesTitle = series.seriesTitle ?? series.seriesId;
    const seasonEntryIds = new Map();

    for (const season of series.seasons ?? []) {
      const eps = (season.episodes ?? []).slice(0, maxPerSeason);
      if (!eps.length) continue;
      const perEpisode = [];
      // Held back rather than scored inline: telling "the resolver missed a
      // file that exists" from "Jimaku has no such file" needs the season's
      // entry, which is only known once an episode has successfully resolved.
      // An all-empty season never learns it, and is scored EMPTY as before.
      const pendingEmpty = [];
      // The largest episode number Crunchyroll itself uses for this season —
      // NOT the episode count, because Crunchyroll numbers some seasons
      // absolutely (JUJUTSU KAISEN Season 2 is episodes 25–47, not 1–23).
      // Used as the boundary between "this season's own numbering" and "an
      // absolute number continuing from earlier seasons".
      const seasonMaxEpisode = Math.max(
        ...eps.map((e) => (/^\d+$/.test(String(e.episode)) ? Number(e.episode) : Number.isInteger(e.episode_number) ? e.episode_number : 1))
      );

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
        if (episodesTested % 50 === 0) {
          process.stdout.write(`   … ${episodesTested} episodes, ${findings.filter((f) => f.proven).length} proven defects so far\n`);
        }
        const label = { series: seriesTitle, season: season.title, episode, episodeTitle: ep.title };

        if (error || !result || result.unresolved || !result.textFiles?.length) {
          // DECLINED vs EMPTY. Declining is sometimes the correct answer — an
          // episode Jimaku has nothing identifiable for should show the picker
          // rather than a guess, and Tokyo Ghoul's "Root A" cannot be reached
          // from Jimaku's "√A" by any means. Scoring both as a defect would
          // report the intended behaviour as a bug on every run, which is the
          // kind of noise that made the earlier sweeps useless.
          const declined = Boolean(result?.unresolved) || /manual upload fallback|no numbered position/.test(error ?? "");
          const detail = error ?? (result?.unresolved ? "no entry identified — picker shown" : "no files");
          if (declined) add("DECLINED", false, { ...label, detail });
          else pendingEmpty.push({ label, detail, episode });
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
          if (!shared.length && !oneEpisodeTwoWays(ids, seasonMaxEpisode)) {
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
        // Only meaningful on an entry whose files DON'T distinguish episodes.
        // Where they do — Frieren's entry states episode numbers across 277
        // files — a narrowed result is narrowing correctly and the excluded
        // silent files are specials and TV spots, not lost alternatives. That
        // untightened check fired 661 times and buried the real shape. The
        // Mugen Train case is the opposite: nothing in its entry states any
        // episode, so every file is the same work and dropping one can only
        // lose a provider.
        const entryDistinguishesEpisodes = all.some((f) => statedIdentity(f.name).length);
        if (!entryDistinguishesEpisodes && all.length > names.length) {
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

      // 4. EMPTY vs MISSING — did the resolver miss a file, or does Jimaku not
      // hold one? Measured false positives (2026-08-11): KONOSUBA's dubbed
      // season 11s are OVAs kept under their own Jimaku entries, KONOSUBA 3's
      // last two episodes have blank Crunchyroll episode codes, and Steins;Gate
      // 0's episode 24 is the unaired 23β that entry 466 simply stops short of.
      // None is a resolver fault, and scoring them as proven defects would put
      // permanent false failures into every future run.
      //
      // The season's own entry answers it. If some file there states this
      // episode, the resolver failed to reach a file that exists — a real
      // defect. If nothing states it AND the entry's numbering stays within
      // this season's range, Jimaku genuinely has no such file.
      //
      // The second condition is what keeps RC3 visible: MHA: Vigilantes'
      // entry 11309 states numbers up to 26 for a 13-episode season, so a
      // second numbering population exists and the missing episode probably
      // IS in there under an absolute number. That stays a proven defect
      // rather than being excused as a gap in Jimaku.
      const seasonEntryId = seasonEntryIds.get(season.title) ?? null;
      const seasonEntryNumbers = seasonEntryId
        ? [...new Set((await entryFiles(seasonEntryId)).flatMap((f) => statedIdentity(f.name)))]
        : [];
      for (const p of pendingEmpty) {
        if (!seasonEntryId || !seasonEntryNumbers.length) {
          add("EMPTY", true, { ...p.label, detail: p.detail });
          continue;
        }
        const statedHere = seasonEntryNumbers.includes(p.episode);
        // Two ways an offset can hide the file, and they point OPPOSITE ways.
        // Both must be tested, which the first version of this got wrong: it
        // checked only the first, and the --background proof against the
        // 2026-08-02 resolver promptly excused three of the six bugs it is
        // supposed to catch (Shangri-La S2 43/50, My Dress-Up Darling S2 17).
        //   - The entry numbers ABOVE the season (Vigilantes: files up to 26
        //     for a 13-episode season).
        //   - Crunchyroll numbers above the entry, i.e. absolutely, while the
        //     entry counts from 1 (Shangri-La's season 2 is episodes 26–51 on
        //     Crunchyroll and 1–26 on Jimaku). Detectable without looking at
        //     the entry at all: Crunchyroll's own highest episode number
        //     exceeding the number of episodes it lists means the season is
        //     absolutely numbered, so an offset necessarily exists.
        const entryNumbersAbove = seasonEntryNumbers.some((n) => n > seasonMaxEpisode);
        const seasonNumberedAbsolutely = seasonMaxEpisode > eps.length;
        if (statedHere || entryNumbersAbove || seasonNumberedAbsolutely) {
          add("EMPTY", true, {
            ...p.label,
            detail: statedHere
              ? `${p.detail} — but entry ${seasonEntryId} has a file stating episode ${p.episode}`
              : entryNumbersAbove
                ? `${p.detail} — and entry ${seasonEntryId} states numbers above this season's ${seasonMaxEpisode}, so it may hold this episode absolutely numbered`
                : `${p.detail} — and Crunchyroll numbers this season absolutely (up to ${seasonMaxEpisode} across ${eps.length} episodes), so entry ${seasonEntryId} may hold it under a lower number`,
          });
        } else {
          add("MISSING", false, {
            ...p.label,
            detail: `${p.detail} — entry ${seasonEntryId} states no such episode, so Jimaku appears not to hold one`,
          });
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
    // The header has always said this check means "…while a distinct entry
    // plausibly exists for each", but nothing verified that half, so a show
    // Jimaku deliberately keeps in ONE entry was reported as a defect for
    // having no alternative to resolve to. Black Clover is the measured case
    // (2026-08-11): its four Crunchyroll "Season 1 Part N" all resolve to
    // entry 2102, which is the only Black Clover TV entry that exists — the
    // same arrangement as One Piece's 24 arcs, already known to be correct.
    // Now checked: count the franchise's non-movie entries, and stay silent
    // when there is only one for the seasons to share.
    const rivalEntries = await countSeriesTvEntries(seriesTitle);
    for (const [id, seasonsSharing] of byEntry) {
      if (seasonsSharing.length > 1) {
        if (rivalEntries !== null && rivalEntries < 2) {
          add("SHARED-ENTRY", false, {
            series: seriesTitle,
            detail: `${seasonsSharing.length} seasons share entry ${id}, but Jimaku has only ${rivalEntries} TV entry for this show — nothing else for them to resolve to`,
            seasons: seasonsSharing,
          });
          continue;
        }
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
  console.log(`(${responseCache.size} distinct Jimaku requests cached, ${cacheHits} served from cache, ${failedRequests} request failure(s))`);
  console.log(`\nPROVEN DEFECTS (${proven.length}):  MIXED ${count("MIXED")}   DUPLICATE ${count("DUPLICATE")}   COLLISION ${count("COLLISION")}   EMPTY ${count("EMPTY")}`);
  for (const f of proven.slice(0, 40)) {
    console.log(`  [${f.kind}] ${f.series}${f.season ? ` / ${f.season}` : ""}${f.episode != null ? ` ep${f.episode}` : ""}`);
    console.log(`      ${f.detail}`);
    if (f.seasons) console.log(`      ${JSON.stringify(f.seasons)}`);
    for (const n of f.files ?? []) console.log(`      · ${String(n).slice(0, 72)}`);
  }
  console.log(
    `\nFLAGGED FOR REVIEW (${flagged.length}):  DECLINED ${count("DECLINED")}   NARROWED ${count("NARROWED")}   ` +
      `UNACCOUNTED ${count("UNACCOUNTED")}   MISSING ${count("MISSING")}   SHARED-ENTRY ${count("SHARED-ENTRY")}`
  );
  console.log(`  (these MAY be correct — see the header for why neither can be decided automatically)`);
  for (const f of flagged.slice(0, 25)) {
    console.log(`  [${f.kind}] ${f.series}${f.season ? ` / ${f.season}` : ""}${f.episode != null ? ` ep${f.episode}` : ""}: ${f.detail}`);
    for (const n of f.files ?? []) console.log(`      · ${String(n).slice(0, 72)}`);
  }
  console.log("");

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ resolver: backgroundPath, episodesTested, findings }, null, 1));
    console.log(`full report -> ${outPath}\n`);
  }
  process.exit(proven.length ? 1 : 0);
})();
