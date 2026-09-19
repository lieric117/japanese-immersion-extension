// What a subtitle FILENAME says about which episode it is — written
// independently of background.js's own parsers on purpose, so the audit can
// catch the resolver's mistakes instead of sharing them.
//
// Returns every claim the name makes, in the forms real Jimaku listings use:
//   第N話                      absolute episode
//   SxxEyy / sxxeyy            season xx, episode yy
//   " - N" / " - N v2"         bare position
//   "[N]"                      bracketed position (1–3 digits only)
//   "S2 - 09"                  season + bare position
//   "E05" (no season)          bare episode code
// A batch archive naming a range identifies no single episode.
//
// The earlier audit's statedIdentity kept only the EPISODE half of SxxEyy,
// which made "S01E05" and "S02E05" read as the same episode — two different
// episodes of two different seasons, agreeing on nothing but a number. This
// keeps the season.

"use strict";

const ARCHIVE_RE = /\.(7z|zip|rar|gz|tar|bz2)$/i;

function fileClaims(name) {
  const n = String(name ?? "");
  const out = { episodes: new Set(), seasonEpisodes: [], absolute: null };
  if (ARCHIVE_RE.test(n) && /\d{1,4}\s*[-–—~]\s*\d{1,4}/.test(n)) return out;
  const abs = n.match(/第\s*(\d{1,4})\s*話/);
  if (abs) {
    out.absolute = Number(abs[1]);
    out.episodes.add(out.absolute);
  }
  for (const m of n.matchAll(/(?:^|[^A-Za-z0-9])[Ss](\d{1,2})[ ._-]?[Ee](\d{1,4})(?![0-9])/g)) {
    out.seasonEpisodes.push({ season: Number(m[1]), episode: Number(m[2]) });
    out.episodes.add(Number(m[2]));
  }
  const srel = n.match(/(?:^|[^A-Za-z0-9])[Ss](\d{1,2})\s*[-–—]\s*(\d{1,3})(?:v\d)?(?=[\s[(.]|$)/);
  if (srel) {
    out.seasonEpisodes.push({ season: Number(srel[1]), episode: Number(srel[2]) });
    out.episodes.add(Number(srel[2]));
  }
  if (!srel) {
    for (const m of n.matchAll(/\s[-–—]\s(\d{1,4})(?:v\d+)?(?=[\s[(「【.]|$)/g)) out.episodes.add(Number(m[1]));
  }
  for (const m of n.matchAll(/\[(\d{1,3})\]/g)) out.episodes.add(Number(m[1]));
  if (!out.seasonEpisodes.length) {
    const e = n.match(/(?:^|[^A-Za-z0-9])[Ee][Pp]?(\d{1,4})(?![0-9])(?=[\s._\-[\]()]|$)/);
    if (e) out.episodes.add(Number(e[1]));
  }
  return out;
}

// Two files in ONE episode's answer that name the same episode number under
// two different SEASON numbers are two different episodes. (Different episode
// numbers under different seasons can be one episode under two conventions —
// Frieren S2 ep 1 is both S02E01 and S01E29 — so those are not flagged here.)
function seasonMixes(names) {
  const byEpisode = new Map();
  for (const name of names) {
    for (const { season, episode } of fileClaims(name).seasonEpisodes) {
      if (!byEpisode.has(episode)) byEpisode.set(episode, new Map());
      const seasons = byEpisode.get(episode);
      if (!seasons.has(season)) seasons.set(season, []);
      seasons.get(season).push(name);
    }
  }
  const mixes = [];
  for (const [episode, seasons] of byEpisode) {
    if (seasons.size > 1) mixes.push({ episode, seasons: [...seasons.entries()].map(([s, files]) => ({ season: s, files })) });
  }
  return mixes;
}

module.exports = { fileClaims, seasonMixes, ARCHIVE_RE };
