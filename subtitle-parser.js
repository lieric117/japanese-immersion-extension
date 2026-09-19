// Minimal parsers for the two subtitle formats community fansubs commonly use.
// Both return an array of { start, end, text } with times in seconds.

// ASS override tags in a .srt file (2026-08-15). They have no business being
// there — .srt has no styling model at all — but Jimaku is full of files that
// were converted from .ass with the tags left in, and the live pass reported
// seeing "{\\an8}" on screen "from different providers". parseAss has stripped
// these since it was written; this is the same strip on the other parser, plus
// the \N line break, which converters leave behind for exactly the same reason.
//
// Restricted to tags that START with a backslash, unlike parseAss's blanket
// `{...}`: in .ass, braces are unambiguously markup, but in .srt they are
// ordinary characters that a line of dialogue could legitimately contain.
const SRT_OVERRIDE_RE = /\{\\[^}]*\}/g;

// Tag-shaped markup in an .srt file (2026-09-18) — <i>, <font color=…>, <b>,
// and the <rb> that Amazon rips use for ruby. Measured on the audit corpus: 7 of
// 248 .srt files, 984 displayed lines, rendered the tags literally and sent them
// to Anki. Stripped as a CLASS, not a list of tag names: .srt dialogue has no
// other use for ASCII angle brackets (Japanese quotes with 〈〉), so anything
// shaped like a tag is markup.
const SRT_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?>/g;
// ARIB gaiji placeholders from TV rips — "[外:<32 hex>]" stands for a character
// the source encoding could not represent. Replaced with 〓, the conventional
// mark for exactly that, rather than left as 38 characters of hex.
const GAIJI_PLACEHOLDER_RE = /\[外:[0-9A-Fa-f]{32}\]/g;

function parseSrt(raw) {
  const cues = [];
  const blocks = raw.replace(/\r/g, "").trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timeLine = lines.find((line) => line.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    const text = lines
      .slice(lines.indexOf(timeLine) + 1)
      .join("\n")
      .replace(SRT_OVERRIDE_RE, "")
      .replace(SRT_TAG_RE, "")
      .replace(GAIJI_PLACEHOLDER_RE, "〓")
      .replace(/\\N/gi, "\n");
    cues.push({
      start: srtTimeToSeconds(startStr),
      end: srtTimeToSeconds(endStr),
      text,
    });
  }
  return warnUnreadableTimes(cues, "srt");
}

// Positional base-60 from the right, any number of fields, `,` or `.` before
// the fraction (2026-09-18). Bandai's film releases write every time past one
// hour as FOUR fields — "00:01:00:15,367" is 1:00:15.367 — and the old
// three-field split turned every such cue into NaN: the second half of each
// film silently had no subtitles (574–728 cues per file, measured on the audit
// corpus). "00:15.367" (no hours) and "0:00:15,3" read correctly too.
function subtitleTimeToSeconds(timeStr) {
  const m = String(timeStr ?? "").trim().match(/^(\d+(?::\d+)*)(?:[,.](\d+))?$/);
  if (!m) return NaN;
  const whole = m[1].split(":").reduce((acc, f) => acc * 60 + Number(f), 0);
  return whole + (m[2] ? Number(`0.${m[2]}`) : 0);
}
const srtTimeToSeconds = subtitleTimeToSeconds;

// Cues whose time could not be read never display — say so, once per file,
// rather than letting them vanish (2026-09-18).
function warnUnreadableTimes(cues, format) {
  const bad = cues.filter((c) => !Number.isFinite(c.start) || !Number.isFinite(c.end)).length;
  if (bad && typeof console !== "undefined") {
    console.warn(`[jp-immersion] ${bad} of ${cues.length} ${format} cues have an unreadable timestamp and will never show.`);
  }
  return cues;
}

// ASS stores subtitles as "Dialogue:" lines under an [Events] section, with
// field order defined by a preceding "Format:" line. Override tags like
// {\an8} and the \N line-break code need stripping out of the text field.
function parseAss(raw) {
  const cues = [];
  const lines = raw.replace(/\r/g, "").split("\n");
  let inEvents = false;
  let textFieldIndex = -1;
  // ASS declares its own field order in a "Format:" line, so the Style
  // column's position varies between files and has to be read, not assumed.
  // Retained (2026-07-26) purely so stripDualLanguageCues below can group
  // lines by style — nothing else uses it, and it stays out of the cue shape
  // every other consumer already expects beyond this one extra property.
  let styleFieldIndex = -1;

  for (const line of lines) {
    if (/^\[Events\]/i.test(line)) {
      inEvents = true;
      continue;
    }
    if (!inEvents) continue;

    if (/^Format:/i.test(line)) {
      const fields = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((f) => f.trim());
      textFieldIndex = fields.indexOf("Text");
      styleFieldIndex = fields.indexOf("Style");
      continue;
    }

    if (!/^Dialogue:/i.test(line) || textFieldIndex === -1) continue;

    const fields = line.slice(line.indexOf(":") + 1).split(",");
    const start = assTimeToSeconds(fields[1].trim());
    const end = assTimeToSeconds(fields[2].trim());
    const rawText = fields.slice(textFieldIndex).join(",");
    const text = rawText.replace(/\{[^}]*\}/g, "").replace(/\\N/gi, "\n");
    const style = styleFieldIndex === -1 ? "" : (fields[styleFieldIndex] ?? "").trim();

    cues.push({ start, end, text, style, align: assAlignment(rawText) });
  }
  return warnUnreadableTimes(cues, "ass");
}

// Kana is the decisive signal: hiragana/katakana appear in Japanese and in no
// other language a subtitle file is realistically going to be written in.
// Kanji alone is NOT decisive — it's shared with Chinese, and dual-language
// CHS+JPN releases are common on Jimaku.
const KANA_RE = /[぀-ゟ゠-ヿ]/;
const LATIN_LETTER_RE = /[A-Za-z]/;

// Hiragana share of a line's Japanese characters (hiragana + kanji). Katakana
// is left out on purpose: staff credits write names in it ("ヨーク").
const JAPANESE_LINE_MIN_HIRAGANA = 0.25;
function readsAsJapaneseLine(text) {
  const hira = (String(text).match(/\p{Script=Hiragana}/gu) ?? []).length;
  const han = (String(text).match(/\p{Script=Han}/gu) ?? []).length;
  return hira > 0 && hira / (hira + han) >= JAPANESE_LINE_MIN_HIRAGANA;
}

// Removes a parallel translation track from a dual-language subtitle file,
// keeping only the Japanese lines (2026-07-26). Live testing found that when
// such a file is selected, its embedded English renders in the Japanese
// subtitle box AND lands in the Anki Sentence field, which is on the card
// front. Fixing it here — on the parsed cue list, before anything consumes it
// — cleans the on-screen display, the Anki sentence, and the audio-capture
// cue boundaries in one place, rather than each needing its own filter.
//
// Groups by ASS style rather than judging each line on its own, because
// per-line script detection gets real cases wrong: an ED song under a
// Japanese style can have genuinely English lyric lines (confirmed in
// Nekomoe kissaten's Frieren release — style `ED_JP` carries "And you
// alright"), and dropping those would corrupt a Japanese track rather than
// clean it. A style is the unit the fansubber themselves used to separate the
// tracks, so classifying the STYLE by its majority script and keeping or
// dropping it wholesale respects that grouping.
//
// Style NAMES are deliberately not used, only the text under them: real files
// name their English styles `Default`, `Flashback`, `Signs`, `Songs_OP` —
// nothing that identifies a language (confirmed against SubsPlease's own
// `_ja-en.ass`, whose only Japanese style is the sole informatively-named
// one). Matching on names would be a guess that fails on the most common
// case; measuring the content is not.
//
// Fails OPEN in every ambiguous case — if no style is majority-Japanese, the
// original list is returned untouched. Stripping everything and leaving the
// user with no subtitles at all is far worse than leaving a stray line in.
function stripDualLanguageCues(cues) {
  if (!Array.isArray(cues) || cues.length === 0) return cues;

  const hasStyles = cues.some((c) => c.style);
  if (!hasStyles) return stripDualLanguageCuesWithoutStyles(cues);

  const byStyle = new Map();
  for (const cue of cues) {
    const key = cue.style ?? "";
    if (!byStyle.has(key)) byStyle.set(key, { total: 0, kana: 0 });
    const bucket = byStyle.get(key);
    bucket.total++;
    if (KANA_RE.test(cue.text)) bucket.kana++;
  }

  const japaneseStyles = new Set();
  for (const [style, bucket] of byStyle) {
    if (bucket.kana / bucket.total > 0.5) japaneseStyles.add(style);
  }
  // Nothing recognisably Japanese — not a dual-language file we understand
  // (or kana detection failed); leave it exactly as it was.
  if (japaneseStyles.size === 0) return cues;

  // A Japanese line in a dropped style is still Japanese (2026-09-18) — the
  // audit corpus had 351 of them: dialogue in an English-majority Default, a
  // whole style named "JP" outvoted by its own song lines. Kept when hiragana
  // is at least a quarter of its Japanese characters; the Chinese staff
  // credits those styles also carry have at most a の inside a name.
  const kept = cues.filter((c) => japaneseStyles.has(c.style ?? "") || readsAsJapaneseLine(c.text));
  // Every style is Japanese: a normal single-language file, nothing to strip.
  if (kept.length === cues.length) return cues;
  return kept;
}

// .srt carries no style metadata at all, so the per-style grouping above has
// nothing to work with and each line has to stand on its own. Deliberately
// much more conservative as a result: only strips when a large share of the
// file is Latin-script-with-no-kana, i.e. it really is carrying a parallel
// English track. Real Japanese-only .srt files routinely contain a handful of
// Latin lines (song lyrics, a sign, a band name — `erai-raws` and the Netflix
// `ja[cc]` rip of Frieren ep 7 each have exactly 4), and those must survive.
function stripDualLanguageCuesWithoutStyles(cues) {
  const nonEmpty = cues.filter((c) => c.text && c.text.trim());
  if (nonEmpty.length === 0) return cues;
  const latinOnly = nonEmpty.filter((c) => LATIN_LETTER_RE.test(c.text) && !KANA_RE.test(c.text));
  const japanese = nonEmpty.filter((c) => KANA_RE.test(c.text));
  // Needs both a substantial English presence AND a Japanese track to keep.
  // The 0.25 threshold sits far above the ~1% incidental-Latin rate measured
  // on real Japanese-only files and far below the ~50% a genuine parallel
  // track produces.
  if (japanese.length === 0 || latinOnly.length / nonEmpty.length < 0.25) return cues;
  return cues.filter((c) => !(LATIN_LETTER_RE.test(c.text) && !KANA_RE.test(c.text)));
}

// The numpad-style alignment an override tag puts this line at, or null when it
// doesn't set one (2026-08-15). 1-3 are bottom, 4-6 middle, 7-9 top; \a is the
// older SSA form, whose numbering is different (5-7 are top there).
//
// Read out of the text field before the tags are stripped, and kept on the cue
// purely so English caption pairing can tell a line placed AT THE TOP of the
// screen from the main subtitle line at the bottom — see content.js's
// primaryEnglishCues for the Anki-field bug that needs this. Nothing about
// display uses it: this project never positions subtitles itself.
function assAlignment(rawText) {
  const an = /\\an\s*([1-9])/.exec(rawText);
  if (an) return Number(an[1]);
  const a = /\\a\s*(\d{1,2})/.exec(rawText);
  if (!a) return null;
  const legacy = { 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 };
  return legacy[Number(a[1])] ?? null;
}

function assTimeToSeconds(timeStr) {
  return subtitleTimeToSeconds(timeStr);
}

// Karaoke typeset ONE GLYPH PER EVENT (2026-09-18) — each character its own
// positioned Dialogue line, all on screen together. Joined for display they
// rendered one character per line, every character a separate clickable
// "word": measured in 7 of the audit corpus's 386 files (2,296 moments), all OP/ED
// lyrics. Defined structurally, since nothing in the text says "effect": a
// single-glyph event with three or more OTHER single-glyph events on screen at
// its start is an effect layer. A lone one-character line ("あ", "え？" is two)
// is dialogue and stays.
const GLYPH_BURST_MIN = 4;
function dropGlyphBursts(cues) {
  if (!Array.isArray(cues) || cues.length < GLYPH_BURST_MIN) return cues;
  const isGlyph = (c) => [...String(c.text ?? "").trim()].length === 1;
  const glyphs = cues.filter(isGlyph).sort((a, b) => a.start - b.start);
  if (glyphs.length < GLYPH_BURST_MIN) return cues;
  const burst = new Set();
  for (const g of glyphs) {
    let together = 0;
    for (const o of glyphs) {
      if (o.start > g.start) break;
      if (o.end > g.start) together++;
    }
    if (together >= GLYPH_BURST_MIN) {
      for (const o of glyphs) {
        if (o.start > g.start) break;
        if (o.end > g.start) burst.add(o);
      }
    }
  }
  return burst.size ? cues.filter((c) => !burst.has(c)) : cues;
}

// Everything that turns a parsed file into the dialogue track, in one place so
// every input path (Jimaku, manual upload) gets the same track.
function cleanParsedCues(cues) {
  return stripDualLanguageCues(dropGlyphBursts(cues));
}

if (typeof process !== "undefined") {
  module.exports = { parseSrt, parseAss, stripDualLanguageCues, dropGlyphBursts, cleanParsedCues, subtitleTimeToSeconds };
}
