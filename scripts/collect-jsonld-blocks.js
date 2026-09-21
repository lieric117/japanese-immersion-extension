// JSON-LD block collector for Crunchyroll watch pages (2026-09-20).
//
// NOT a node script — paste this whole file into the browser console on a
// crunchyroll.com watch page while logged in, then watch episodes normally. It
// only reads the page's own `<script type="application/ld+json">` tags; it
// makes no network request at all.
//
// WHY THIS EXISTS: the 2026-09-20 staleness fix rests on the `TVEpisode` block
// carrying the episode's own watch URL, and on that block being replaced in
// place on in-app navigation. Both were established by one manual DevTools
// look, which could not observe the sub-second window right after a navigation
// — exactly the window the fix is there to cover — and none of the project's
// three catalogue captures contains a single JSON-LD block (the collector that
// would have taken them was blocked by Cloudflare, `jsonLd: []` on all 299
// sampled seasons). This turns both premises into measured data, and produces
// a fixture the offline tests can replay.
//
// USAGE
//   1. Open a watch page, log in, open the console, paste this file.
//      It starts sampling immediately and prints a line per navigation.
//   2. Watch normally: click to the next episode, click back, switch the audio
//      language (dubs live at their OWN /watch/ id — measured: 210 of 299
//      sampled episodes have per-audio-version ids), open a film, a special, a
//      season with no season name.
//   3. `__jpJsonLd.report()`  — per navigation, how long the block took to
//      name the page it is on. This is the number the 5s wait was guessing at.
//   4. `__jpJsonLd.save()`    — downloads the capture. Save it into
//      `fixtures/jsonld/` with the date in the name; it is live-captured data
//      and the test that replays it says so.
//
// WHAT IT RECORDS, per navigation: the pathname and its /watch/ id, then a
// snapshot of every ld+json block on the page at 0, 100, 250, 500, 1000, 2000
// and 5000ms after the URL changed. Each snapshot keeps only the fields
// detection reads — @type, url, @id, name, episodeNumber, partOfSeries.name,
// partOfSeason.{name,seasonNumber} — so nothing personal is captured. Check the
// file before sharing it anyway.

(() => {
  "use strict";

  const SAMPLE_OFFSETS_MS = [0, 100, 250, 500, 1000, 2000, 5000];
  const WATCH_ID_RE = /\/watch\/([^/?#]+)/;
  const watchIdFrom = (u) => (typeof u === "string" ? (u.match(WATCH_ID_RE) || [])[1] ?? null : null);

  const navigations = [];

  function snapshotBlocks() {
    const out = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch {
        out.push({ unparseable: true, length: (script.textContent || "").length });
        continue;
      }
      for (const node of Array.isArray(data) ? data : [data]) {
        out.push({
          "@type": node?.["@type"] ?? null,
          url: node?.url ?? null,
          "@id": node?.["@id"] ?? null,
          name: node?.name ?? null,
          episodeNumber: node?.episodeNumber ?? null,
          seriesName: node?.partOfSeries?.name ?? null,
          seasonName: node?.partOfSeason?.name ?? null,
          seasonNumber: node?.partOfSeason?.seasonNumber ?? null,
        });
      }
    }
    return out;
  }

  function record(reason) {
    const nav = {
      reason,
      at: new Date().toISOString(),
      pathname: location.pathname,
      watchId: watchIdFrom(location.pathname),
      samples: [],
    };
    navigations.push(nav);
    for (const ms of SAMPLE_OFFSETS_MS) {
      setTimeout(() => {
        // The pathname is re-read per sample: if the user navigates again
        // before 5s, later samples belong to the NEXT page and are marked, not
        // silently attributed to this one.
        const blocks = snapshotBlocks();
        const episodeBlocks = blocks.filter((b) => b["@type"] === "TVEpisode");
        nav.samples.push({
          ms,
          pathnameNow: location.pathname,
          movedOn: location.pathname !== nav.pathname,
          blockCount: blocks.length,
          episodeBlockCount: episodeBlocks.length,
          matchesPage: episodeBlocks.some(
            (b) => (watchIdFrom(b.url) ?? watchIdFrom(b["@id"])) === nav.watchId
          ),
          anyUrl: episodeBlocks.some((b) => watchIdFrom(b.url) ?? watchIdFrom(b["@id"])),
          blocks: episodeBlocks,
        });
        if (ms === SAMPLE_OFFSETS_MS[SAMPLE_OFFSETS_MS.length - 1]) {
          const settled = nav.samples.find((s) => s.matchesPage && !s.movedOn);
          console.log(
            `[jsonld] ${nav.pathname} — ${
              settled ? `block named this page by ${settled.ms}ms` : "block NEVER named this page within 5s"
            }, ${episodeBlocks.length} TVEpisode block(s)`
          );
        }
      }, ms);
    }
  }

  // Crunchyroll navigates without reloading, so the URL changes under us. Same
  // mechanism content.js uses (a poll), rather than patching history — this
  // must not change how the page behaves while it is being measured.
  let lastPathname = location.pathname;
  setInterval(() => {
    if (location.pathname === lastPathname) return;
    lastPathname = location.pathname;
    record("navigation");
  }, 50);

  window.__jpJsonLd = {
    navigations,
    report() {
      console.table(
        navigations.map((nav) => {
          const settled = nav.samples.find((s) => s.matchesPage && !s.movedOn);
          const first = nav.samples[0];
          return {
            pathname: nav.pathname,
            watchId: nav.watchId,
            blocksAt0ms: first?.episodeBlockCount ?? "—",
            urlPresentAt0ms: first?.anyUrl ?? "—",
            matchedAt0ms: first?.matchesPage ?? "—",
            settledAfterMs: settled ? settled.ms : "never within 5s",
          };
        })
      );
      const noBlock = navigations.filter((n) => n.samples.at(-1)?.episodeBlockCount === 0).length;
      const noUrl = navigations.filter((n) => {
        const last = n.samples.at(-1);
        return last && last.episodeBlockCount > 0 && !last.anyUrl;
      }).length;
      console.log(
        `[jsonld] ${navigations.length} page(s): ${noBlock} with no TVEpisode block after 5s, ` +
          `${noUrl} with a block but no url/@id carrying a /watch/ id.`
      );
    },
    save(filename = `jsonld-blocks-${new Date().toISOString().slice(0, 10)}.json`) {
      const blob = new Blob(
        [JSON.stringify({ capturedAt: new Date().toISOString(), live: true, navigations }, null, 2)],
        { type: "application/json" }
      );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      console.log(`[jsonld] saved ${navigations.length} navigation(s) to ${filename}`);
    },
  };

  record("initial");
  console.log(
    "[jsonld] collecting. Watch episodes normally, switch audio language once, then run " +
      "__jpJsonLd.report() and __jpJsonLd.save()."
  );
})();
