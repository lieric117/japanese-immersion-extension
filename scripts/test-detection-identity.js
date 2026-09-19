// Identity invariants for show detection (2026-09-18 audit, root cause RC-D1/RC-D2).
//
// Usage:  node scripts/test-detection-identity.js
//
// Two keys decide which subtitles a page gets, and both must be INJECTIVE —
// no two different things may share one — or the extension confuses them
// silently:
//
//   - the EPISODE identity (content.js `episodeIdentity`): what the staleness
//     check and the watchdog compare, and what a subtitle response is bound to.
//     Two episodes sharing it means a response for one can be installed on the
//     other, and a stale page can't be told from a fresh one.
//   - the SEASON memory key (`seasonMemoryKey`): what the remembered entry pick,
//     the uploader preference and the sibling-title cache are stored under. Two
//     works sharing it means a pick made for one is USED for the other.
//
// Checked against every episode and season in the three live catalogue
// captures (fixtures/crunchyroll-catalogue-*.json — verbatim CMS data, which
// the Decisions Log 2026-08-01 confirmed agrees with the JSON-LD fields the
// extension reads). The one reconstructed field is the JSON-LD `name`
// compound ("<season> | E<code> - <title>"), built in the shape measured on
// real pages; it is flagged here as a reconstruction.
//
// Measured before the fix (commit c1c95b2): the episode identity collided on
// 37 episodes and the season key on 6 season slots, three of them a TV season
// sharing its slot with a FILM (Gundam / Char's Counterattack, KonoSuba 3 dub
// / Legend of Crimson dub, FGO Babylonia dub / Solomon).

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
function grab(re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} from content.js — renamed?`);
  return m[0];
}

const fns = new Function(
  [
    grab(/^function episodeIdentity\([\s\S]*?\n\}/m, "episodeIdentity"),
    grab(/^function seasonMemoryKey\([\s\S]*?\n\}/m, "seasonMemoryKey"),
    grab(/^function entryPrefKey\([\s\S]*?\n\}/m, "entryPrefKey"),
    grab(/^function uploaderPrefKey\([\s\S]*?\n\}/m, "uploaderPrefKey"),
    grab(/^function siblingCacheKey\([\s\S]*?\n\}/m, "siblingCacheKey"),
    "return { episodeIdentity, seasonMemoryKey, entryPrefKey, uploaderPrefKey, siblingCacheKey };",
  ].join("\n")
)();

let failed = 0;
function check(label, cond, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
}

// detectShowEpisode()'s output shape, from a capture's episode record.
function detectedFrom(series, season, ep) {
  const code = ep.episode;
  const numeric = /^\d+$/.test(String(code ?? "")) ? Number(code) : null;
  return {
    seriesTitle: series.seriesTitle,
    episodeNumber: numeric ?? (Number.isInteger(ep.episode_number) ? ep.episode_number : null),
    seasonNumber: Number.isInteger(season.season_number) ? season.season_number : null,
    seasonName: season.title ?? null,
    // RECONSTRUCTED in the measured shape — see the header.
    episodeTitle: `${season.title} | E${code ?? ""} - ${ep.title ?? ""}`,
  };
}

const captures = ["2026-08-04", "2026-08-01", "2026-08-01b"].map((d) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", `crunchyroll-catalogue-${d}.json`), "utf8"))
);

// ── episode identity ─────────────────────────────────────────────────────────
{
  const byKey = new Map();
  const seenIds = new Set();
  let n = 0;
  for (const cap of captures) {
    for (const series of Object.values(cap.series ?? {})) {
      for (const season of series.seasons ?? []) {
        for (const ep of season.episodes ?? []) {
          if (seenIds.has(ep.id)) continue; // the same episode in two captures
          seenIds.add(ep.id);
          const d = detectedFrom(series, season, ep);
          if (!Number.isInteger(d.episodeNumber)) continue; // detection returns null for these
          n++;
          const k = fns.episodeIdentity(d);
          if (!byKey.has(k)) byKey.set(k, []);
          byKey.get(k).push(`${season.title} / ${ep.episode} "${ep.title}"`);
        }
      }
    }
  }
  const shared = [...byKey.entries()].filter(([, v]) => v.length > 1);
  check(
    `episodeIdentity is unique across all ${n} captured episodes`,
    shared.length === 0,
    `${shared.reduce((a, [, v]) => a + v.length, 0)} episodes share a key, e.g. ${JSON.stringify(shared.slice(0, 3))}`
  );
}

// ── season memory key ────────────────────────────────────────────────────────
{
  const byKey = new Map();
  let n = 0;
  for (const cap of captures) {
    for (const series of Object.values(cap.series ?? {})) {
      for (const season of series.seasons ?? []) {
        const ep = (season.episodes ?? [])[0];
        if (!ep) continue;
        const d = detectedFrom(series, season, ep);
        const k = fns.seasonMemoryKey(d);
        if (!byKey.has(k)) byKey.set(k, new Set());
        const before = byKey.get(k).size;
        byKey.get(k).add(season.title);
        if (byKey.get(k).size > before) n++;
      }
    }
  }
  const shared = [...byKey.entries()].filter(([, v]) => v.size > 1);
  check(
    `seasonMemoryKey is unique across all ${n} captured seasons`,
    shared.length === 0,
    `${shared.length} keys shared by different seasons, e.g. ${JSON.stringify(shared.slice(0, 3).map(([k, v]) => [k, [...v]]))}`
  );
}

// Every per-season store goes through the one key — otherwise fixing the key
// in one place leaves the collision alive in another.
{
  const d = { seriesTitle: "S", seasonNumber: 1, seasonName: "N", episodeNumber: 1, episodeTitle: "N | E1 - T" };
  const k = fns.seasonMemoryKey(d);
  check("entryPrefKey is built from seasonMemoryKey", fns.entryPrefKey(d) === `entryPref:${k}`, fns.entryPrefKey(d));
  check("uploaderPrefKey is built from seasonMemoryKey", fns.uploaderPrefKey(d) === `uploaderPref:${k}`, fns.uploaderPrefKey(d));
  check("siblingCacheKey is built from seasonMemoryKey", fns.siblingCacheKey(d) === `siblings:${k}`, fns.siblingCacheKey(d));
}

// A season-less page (a film folded into its parent series) must not share a
// key with every other season-less page of that series.
{
  const film = (t) => ({ seriesTitle: "Attack on Titan", seasonNumber: null, seasonName: null, episodeNumber: 1, episodeTitle: `${t} | ${t}` });
  check(
    "two season-less works of one series get different season keys",
    fns.seasonMemoryKey(film("Attack on Titan: THE LAST ATTACK")) !== fns.seasonMemoryKey(film("Attack on Titan: Chronicle")),
    fns.seasonMemoryKey(film("x"))
  );
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
