// subtitle-parser.js against the file shapes the 2026-09-18 corpus sweep
// (386 real Jimaku files, scripts/audit/parse-sweep.js) found it mishandling.
// Each case says whether its input is VERBATIM (copied from a real file, named)
// or SYNTHETIC (built to exercise the rule).
//
// Usage:  node scripts/test-subtitle-parser.js

"use strict";
const path = require("path");
const parser = require(path.join(__dirname, "..", "subtitle-parser.js"));
let failed = 0;
const check = (label, cond, detail = "") => {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : `\n        ${detail}`}`);
};
const quiet = (fn) => {
  const w = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = w;
  }
};

// ── timestamps ──────────────────────────────────────────────────────────────
// VERBATIM: 劇場版 マクロスF ~サヨナラノツバサ~.Bandai.ja.srt, cues 825–826 — the
// file writes every time past one hour with FOUR fields. Before the fix, 731 of
// its 1,556 cues parsed as NaN and never displayed.
{
  const raw = "825\r\n00:59:53,567 --> 00:59:56,534\r\n銀河の 果てまでー！\r\n\r\n826\r\n00:01:00:15,367 --> 00:01:00:18,634\r\n水面が揺らぐ\r\n\r\n";
  const cues = quiet(() => parser.parseSrt(raw));
  check("Bandai four-field time past the hour: 00:01:00:15,367 → 3615.367", cues[1] && Math.abs(cues[1].start - 3615.367) < 1e-6, JSON.stringify(cues[1]));
  check("…and the cue before it still reads normally", cues[0] && Math.abs(cues[0].start - 3593.567) < 1e-6, JSON.stringify(cues[0]));
}
// SYNTHETIC: separator and field-count variants.
for (const [s, want] of [["00:00:04.000", 4], ["00:15,367", 15.367], ["0:00:01.00", 1], ["1:02:03.5", 3723.5]]) {
  check(`time ${s} → ${want}`, Math.abs(parser.subtitleTimeToSeconds(s) - want) < 1e-9, String(parser.subtitleTimeToSeconds(s)));
}
check("an unreadable time is NaN (and reported), never a guessed number", Number.isNaN(parser.subtitleTimeToSeconds("garbage")));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
