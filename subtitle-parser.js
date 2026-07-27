// Minimal parsers for the two subtitle formats community fansubs commonly use.
// Both return an array of { start, end, text } with times in seconds.

function parseSrt(raw) {
  const cues = [];
  const blocks = raw.replace(/\r/g, "").trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timeLine = lines.find((line) => line.includes("-->"));
    if (!timeLine) continue;
    const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
    const text = lines.slice(lines.indexOf(timeLine) + 1).join("\n");
    cues.push({
      start: srtTimeToSeconds(startStr),
      end: srtTimeToSeconds(endStr),
      text,
    });
  }
  return cues;
}

function srtTimeToSeconds(timeStr) {
  const [h, m, sMs] = timeStr.split(":");
  const [s, ms] = sMs.split(",");
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
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
    const text = fields
      .slice(textFieldIndex)
      .join(",")
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/gi, "\n");
    const style = styleFieldIndex === -1 ? "" : (fields[styleFieldIndex] ?? "").trim();

    cues.push({ start, end, text, style });
  }
  return cues;
}

// Kana is the decisive signal: hiragana/katakana appear in Japanese and in no
// other language a subtitle file is realistically going to be written in.
// Kanji alone is NOT decisive — it's shared with Chinese, and dual-language
// CHS+JPN releases are common on Jimaku.
const KANA_RE = /[぀-ゟ゠-ヿ]/;
const LATIN_LETTER_RE = /[A-Za-z]/;

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

  const kept = cues.filter((c) => japaneseStyles.has(c.style ?? ""));
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

function assTimeToSeconds(timeStr) {
  const [h, m, s] = timeStr.split(":");
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

if (typeof process !== "undefined") {
  module.exports = { parseSrt, parseAss, stripDualLanguageCues };
}
