// Disk-cached, rate-limited Jimaku client for the audit harness (2026-09-18).
//
// Every live Jimaku response a harness run receives is written to disk, keyed
// by URL, so nothing is ever fetched twice across runs and a before/after
// comparison can replay IDENTICAL data. That matters for the "does this fix
// make the whole cluster disappear" question: comparing two live runs mixes the
// effect of the fix with whatever Jimaku's uploaders changed in between.
//
// Modes (env JIMAKU_CACHE_MODE):
//   "live"    (default) serve from cache, fetch + cache on a miss
//   "offline" serve from cache only; a miss is an error, never a request —
//             use this to re-run a sweep against a snapshot captured earlier
//   "refresh" always fetch, overwrite the cache
//
// Pacing follows Jimaku's own headers (x-ratelimit-remaining / -reset-after)
// rather than a guessed interval, with a floor between requests so a burst
// never happens even when headers are missing. The documented limit is 25
// requests per window (measured 2026-09-18: `x-ratelimit-limit: 25`).
//
// Only 2xx responses are cached. A cached failure would turn one transient 429
// into a permanent one for that URL — the exact defect that inflated the
// 2026-08-04 audit's EMPTY count (Decisions Log 2026-08-04).

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_CACHE_DIR = path.join(__dirname, "..", "..", ".audit-cache", "jimaku");

function createJimakuClient({
  key = process.env.JIMAKU_API_KEY,
  cacheDir = process.env.JIMAKU_CACHE_DIR || DEFAULT_CACHE_DIR,
  mode = process.env.JIMAKU_CACHE_MODE || "live",
  minSpacingMs = 2400, // 25 req/min, the documented limit
  log = () => {},
} = {}) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const stats = { hits: 0, misses: 0, fetched: 0, failures: 0, rateLimited: 0 };
  let lastRequestAt = 0;
  let blockedUntil = 0;
  // Serialises live requests: the harness fans out from several places and a
  // shared clock is the only way the spacing actually holds.
  let chain = Promise.resolve();

  const fileFor = (url) => path.join(cacheDir, crypto.createHash("sha1").update(String(url)).digest("hex") + ".json");

  function readCache(url) {
    try {
      const rec = JSON.parse(fs.readFileSync(fileFor(url), "utf8"));
      if (rec.url !== String(url)) return null; // hash collision guard
      return rec;
    } catch {
      return null;
    }
  }

  function writeCache(url, status, body) {
    const rec = { url: String(url), status, body, fetchedAt: new Date().toISOString() };
    fs.writeFileSync(fileFor(url), JSON.stringify(rec));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function liveFetch(url, init) {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const wait = Math.max(0, lastRequestAt + minSpacingMs - now, blockedUntil - now);
      if (wait) await sleep(wait);
      lastRequestAt = Date.now();
      let res;
      try {
        res = await globalThis.fetch(url, init);
      } catch (e) {
        // A dropped connection throws rather than returning a status.
        if (attempt >= 5) throw e;
        await sleep(3000 * 2 ** attempt);
        continue;
      }
      const remaining = Number(res.headers.get("x-ratelimit-remaining"));
      const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
      if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetAfter)) {
        blockedUntil = Date.now() + Math.ceil(resetAfter * 1000) + 250;
      }
      if (res.status === 429) {
        stats.rateLimited++;
        if (attempt >= 6) return res;
        const after = Number.isFinite(resetAfter) ? resetAfter * 1000 + 500 : 5000 * 2 ** attempt;
        log(`   (429 — waiting ${(after / 1000).toFixed(1)}s)`);
        blockedUntil = Date.now() + after;
        continue;
      }
      return res;
    }
  }

  // fetch-compatible: returns {ok, status, json(), text()} — the only surface
  // background.js's resolver touches.
  async function cachedFetch(url, init = {}) {
    const u = String(url);
    if (mode !== "refresh") {
      const rec = readCache(u);
      if (rec) {
        stats.hits++;
        return wrap(rec.status, rec.body);
      }
    }
    if (mode === "offline") {
      stats.misses++;
      const err = new Error(`offline cache miss: ${u}`);
      err.offlineMiss = true;
      throw err;
    }
    const headers = { ...(init.headers ?? {}) };
    if (/^https:\/\/jimaku\.cc\//.test(u) && key && !headers.Authorization) headers.Authorization = key;
    const run = chain.then(async () => {
      const res = await liveFetch(u, { ...init, headers });
      const body = await res.text();
      stats.fetched++;
      if (res.ok) writeCache(u, res.status, body);
      else stats.failures++;
      return wrap(res.status, body);
    });
    chain = run.catch(() => {});
    return run;
  }

  function wrap(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body),
      text: async () => body,
      headers: { get: () => null },
    };
  }

  return { fetch: cachedFetch, stats, cacheDir, mode };
}

module.exports = { createJimakuClient, DEFAULT_CACHE_DIR };
