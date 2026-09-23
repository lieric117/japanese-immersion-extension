// Crunchyroll caption-track probe (2026-09-22).
//
// NOT a node script — paste this whole file into the browser console on a
// crunchyroll.com watch page while logged in. Like caption-url-sniffer.js it
// only reads responses the page itself fetched; the one request it makes of its
// own is downloading the English caption files those responses point to — the
// same files the player downloads.
//
// WHY THIS EXISTS: switching KonoSuba 3 from the Japanese to the English audio
// track logged "English subtitles loaded: 336 cues" and then "... 5 cues". The
// sniffer reads only `data.subtitles ?? data.captions` and keeps the first
// English locale in whichever of the two exists, so it can't show what else the
// `play` response offered. This lists every track in BOTH groups, and for each
// English one counts what the raw file actually contains, so "5 cues" can be
// checked against the file itself rather than against the extension's reading
// of it.
//
// USAGE
//   1. Open the episode, open the console, paste this file.
//   2. Switch the audio track (Japanese → English, then back). Each switch
//      loads a new watch page, which fetches a new `play` response; one table
//      is printed per response.
//   3. `__jpCaptionProbe.save()` downloads everything seen. Signed URLs are
//      reduced to their host before saving. Save it into `fixtures/captions/`.

(() => {
  "use strict";
  const seen = [];

  function assSummary(raw) {
    const lines = raw.replace(/\r/g, "").split("\n");
    const events = lines.filter((l) => /^Dialogue:/i.test(l));
    const styles = {};
    for (const l of events) {
      const style = (l.slice(l.indexOf(":") + 1).split(",")[3] ?? "").trim();
      styles[style] = (styles[style] ?? 0) + 1;
    }
    return {
      dialogueLines: events.length,
      commentLines: lines.filter((l) => /^Comment:/i.test(l)).length,
      styles,
      // Every event when the file is small (the case under question), a sample otherwise.
      events: (events.length <= 60 ? events : events.slice(0, 10)).map((l) => l.slice(0, 200)),
    };
  }

  function vttSummary(raw) {
    const timeLines = raw.split(/\r?\n/).filter((l) => l.includes("-->"));
    return {
      cueTimeLines: timeLines.length,
      // Anything after the end time (e.g. "align:start line:10%"). The extension
      // parses non-ASS tracks with parseSrt, which reads that as part of the time.
      timeLinesWithCueSettings: timeLines.filter((l) => /-->\s*\S+\s+\S/.test(l)).length,
      sample: timeLines.slice(0, 5),
    };
  }

  async function inspect(text) {
    if (typeof text !== "string") return;
    if (text.indexOf('"subtitles"') === -1 && text.indexOf('"captions"') === -1) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const groups = { subtitles: data?.subtitles, captions: data?.captions };
    if (!groups.subtitles && !groups.captions) return;
    const entry = {
      at: new Date().toISOString(),
      page: location.pathname,
      audioLocale: data.audioLocale ?? data.audio_locale ?? null,
      // Which group the extension's sniffer reads: it never looks at `captions`
      // when `subtitles` is present.
      snifferReads: groups.subtitles && typeof groups.subtitles === "object" ? "subtitles" : "captions",
      topLevelKeys: Object.keys(data),
      tracks: [],
    };
    for (const [group, obj] of Object.entries(groups)) {
      if (!obj || typeof obj !== "object") continue;
      for (const [locale, t] of Object.entries(obj)) {
        const track = { group, locale, format: t?.format ?? null, host: null };
        try {
          track.host = new URL(t.url).hostname;
        } catch {}
        if (t?.url && /^en/i.test(locale)) {
          try {
            const raw = await (await fetch(t.url)).text();
            track.bytes = raw.length;
            Object.assign(track, /^\s*\[Script Info\]/i.test(raw) || /^Dialogue:/im.test(raw) ? assSummary(raw) : vttSummary(raw));
          } catch (e) {
            track.fetchError = String(e);
            console.log(`[caption-probe] couldn't fetch ${group}.${locale} — open it in a new tab instead:`, t.url);
          }
        }
        entry.tracks.push(track);
      }
    }
    seen.push(entry);
    console.log(`[caption-probe] play response on ${entry.page} — audio ${entry.audioLocale}, sniffer reads "${entry.snifferReads}"`);
    console.table(entry.tracks.map(({ events, sample, styles, ...row }) => ({ ...row, styles: styles ? JSON.stringify(styles) : "" })));
    for (const t of entry.tracks) if (t.events && t.dialogueLines <= 60) console.log(`[caption-probe] ${t.group}.${t.locale} events:\n` + t.events.join("\n"));
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    return originalFetch.apply(this, args).then((response) => {
      response.clone().text().then(inspect).catch(() => {});
      return response;
    });
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        inspect(this.responseText);
      } catch {}
    });
    return originalSend.apply(this, args);
  };

  window.__jpCaptionProbe = {
    seen,
    save() {
      const blob = new Blob([JSON.stringify({ capturedAt: new Date().toISOString(), live: true, responses: seen }, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `caption-probe-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    },
  };
  console.log("[caption-probe] installed — now switch the audio track. __jpCaptionProbe.save() to download.");
})();
