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

// ── markup ──────────────────────────────────────────────────────────────────
// VERBATIM excerpts: [Moozzi2] Kusuriya no Hitorigoto - 13 (<font>),
// [Amazon] Mobile Suit Gundam - The Witch from Mercury 07 (<rb>), Fairy Tail
// 100-nen Quest - E13 [TV].srt (gaiji).
{
  const raw =
    '1\n00:00:17,000 --> 00:00:18,059\n<font color="japanese">（壬氏(ジンシ)）本気ですか？</font>\n\n' +
    "2\n00:00:17,017 --> 00:00:21,605\n<rb>今日</rb>こんにちの あらゆるシステム管理や\n\n" +
    "3\n00:11:40,000 --> 00:11:41,750\nﾓｰﾄﾞ[外:46123D2913F84CFAB6F8F782E9F5B2F8]雷竜!!\n\n" +
    "4\n00:00:30,000 --> 00:00:31,000\n<i>（どうしよう…）</i>\n\n";
  const cues = parser.parseSrt(raw);
  check("<font color=…> is stripped, the dialogue kept", cues[0].text === "（壬氏(ジンシ)）本気ですか？", cues[0].text);
  check("<rb> ruby tags are stripped and every character kept", cues[1].text === "今日こんにちの あらゆるシステム管理や", cues[1].text);
  check("an ARIB gaiji placeholder becomes 〓", cues[2].text === "ﾓｰﾄﾞ〓雷竜!!", cues[2].text);
  check("<i> is stripped (SYNTHETIC)", cues[3].text === "（どうしよう…）", cues[3].text);
  const braces = parser.parseSrt("1\n00:00:01,000 --> 00:00:02,000\n{笑} 3<5 は正しい\n\n");
  check("non-tag angle brackets and plain braces in .srt dialogue survive (SYNTHETIC)", braces[0].text === "{笑} 3<5 は正しい", braces[0].text);
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
