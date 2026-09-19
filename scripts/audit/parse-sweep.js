// Parsing / segmentation / lookup sweep over a real Jimaku corpus (2026-09-18).
//
// Usage:
//   node scripts/audit/parse-sweep.js [--corpus .audit-cache/corpus.json] [--limit N]
//        [--no-unidic] [--out report.json] [--examples N] [--content path] [--background path]
//   (run build-corpus.js first; this reads downloads from the disk cache and
//    makes no network request of its own — JIMAKU_CACHE_MODE=offline is implied)
//
// Runs every file through the extension's REAL pipeline (parse-pipeline.js) at
// every distinct moment a line is on screen, and checks:
//
//   INVARIANTS (a violation is a defect by definition)
//     TOKEN-LOSSY        kuromoji tokens don't concatenate back to the display text
//     GROUP-LOSSY        final groups don't — the Anki bold offset would drift
//     GROUP-EMPTY-WORD   a clickable group with no lookup word
//     NAN-TIME           a cue whose start/end didn't parse (silently never shown)
//     DUAL-STRIP-KANA    the dual-language strip dropped a line containing kana
//
//   ANOMALIES (clustered by signature; each cluster is a candidate root cause)
//     RESIDUE-*          markup that survived the display filters
//     SPEAKER-STRIP      text removed as a "speaker name" (sub-typed by shape)
//     STAGE-DROP         a whole line dropped as a stage direction (sub-typed)
//     PARTIAL-PAREN      a parenthetical left inside displayed dialogue
//     DUP-LAYER          the same text shown twice at once (layered events)
//     MIDWORD-BREAK      a line break that splits a word kuromoji would keep whole
//     HAN-UNCLICKABLE    a Han character outside the clickable-character ranges
//     UNRESOLVED         clickable, but lookupWord finds nothing
//     UNIDIC-RESOLVES    …and the UniDic lemma for the same span DOES resolve
//     LEMMA-DRIFT        verb/adjective whose lookup lemma isn't consistent with
//                        its surface (mis-segmentation → wrong dictionary word)
//     KANJI-FRAGMENT     a lone kanji split off an adjacent kanji run
//     UNIDIC-SPLIT       our group boundary falls inside a word UniDic keeps whole
//     UNIDIC-LEMMA       both analyzers resolve the span, to disjoint entries
//
// Nothing here is scored against hand-written expectations; every check is
// either an invariant or a disagreement between two independent sources.

"use strict";

const fs = require("fs");
const path = require("path");
process.env.JIMAKU_CACHE_MODE = process.env.JIMAKU_CACHE_MODE || "offline";
const { createJimakuClient } = require("./jimaku-client.js");
const { createPipeline } = require("./parse-pipeline.js");

const args = process.argv.slice(2);
const opt = (name, fallback = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const corpusPath = opt("--corpus") ?? path.join(__dirname, "..", "..", ".audit-cache", "corpus.json");
const limit = Number(opt("--limit")) || Infinity;
const useUnidic = !args.includes("--no-unidic");
const outPath = opt("--out");
const EXAMPLES = Number(opt("--examples")) || 4;

const JWORD = /[ぁ-ヿ㐀-鿿ｦ-ﾟ]/; // tokenize-utils.js JAPANESE_WORD_RE
const HAN = /\p{Script=Han}/u;
const KANA = /[ぁ-ゖァ-ヺ]/;
const KANJI_CHAR = /^[㐀-鿿々]$/;
const IRREGULAR_LEMMAS = new Set(["する", "くる", "来る", "為る", "いく", "行く", "ある", "いる", "居る", "有る", "だ", "です", "ます", "ない", "無い", "いい", "良い", "よい"]);

async function loadUnidic() {
  if (!useUnidic) return null;
  const mod = await import(path.join(__dirname, "node_modules", "lindera-wasm-unidic", "lindera_wasm_unidic.js"));
  mod.initSync({ module: fs.readFileSync(path.join(__dirname, "node_modules", "lindera-wasm-unidic", "lindera_wasm_unidic_bg.wasm")) });
  const b = new mod.TokenizerBuilder();
  b.set_dictionary("embedded://unidic");
  b.set_mode("normal");
  const t = b.build();
  // UTF-8 byte offsets → UTF-16 indices.
  return (text) => {
    const byteToIdx = new Map();
    let bytes = 0;
    for (let i = 0; i < text.length; ) {
      byteToIdx.set(bytes, i);
      const cp = text.codePointAt(i);
      const units = cp > 0xffff ? 2 : 1;
      bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      i += units;
    }
    byteToIdx.set(bytes, text.length);
    return t.tokenize(text).map((tok) => ({
      surface: tok.surface,
      start: byteToIdx.get(tok.byte_start),
      end: byteToIdx.get(tok.byte_end),
      pos: tok.details[0],
      pos2: tok.details[1],
      lemma: tok.details[7],
      orthBase: tok.details[10],
    }));
  };
}

// ── findings ─────────────────────────────────────────────────────────────────
const clusters = new Map(); // key → {type, signature, count, lines:Set, words:Map, examples:[]}
const invariantViolations = [];
function note(type, signature, { line, word = null, file, detail = null, invariant = false }) {
  const key = `${type} :: ${signature}`;
  if (!clusters.has(key)) clusters.set(key, { type, signature, count: 0, lines: new Set(), words: new Map(), files: new Set(), examples: [] });
  const c = clusters.get(key);
  c.count++;
  c.lines.add(line);
  c.files.add(file);
  if (word != null) c.words.set(word, (c.words.get(word) ?? 0) + 1);
  if (c.examples.length < 40) c.examples.push({ line, word, file, detail });
  if (invariant) invariantViolations.push({ type, signature, line, word, file, detail });
}

function scriptClass(s) {
  if (/^[ァ-ヺー・ｦ-ﾟ]+$/.test(s)) return "katakana";
  if (/^[ぁ-ゖー]+$/.test(s)) return "hiragana";
  if (/^[㐀-鿿々]+$/.test(s)) return "kanji";
  if (/^[0-9０-９]+$/.test(s)) return "digits";
  return "mixed";
}

function speakerShape(prefix) {
  const p = prefix.replace(/[:：\s]+$/, "");
  if (/[0-9０-９]/.test(p)) return "has-digits";
  if (/^[（(]/.test(p)) return "paren-name";
  if (/[ぁ-ゖ]/.test(p) && /[をにがはでとへのもや]/.test(p)) return "has-particle";
  if (/^[ァ-ヺー・]+$/.test(p)) return "katakana-name";
  if (/^[㐀-鿿々]+$/.test(p)) return "kanji-name";
  if (/^[A-Za-z .'-]+$/.test(p)) return "latin-name";
  return "other";
}

function stageShape(line) {
  const inner = line.replace(/^[（(]|[）)]$/g, "");
  if (/(音|声|笑|泣|ため息|咳|拍手|悲鳴|歓声|足音|物音|鳴る|響く|息)/.test(inner) && !/[よねかなぞわ]$|[？！?!]/.test(inner)) return "sound-effect";
  if (/[？！?!…]|[よねかなぞわの]$|って$|[てた]$/.test(inner)) return "speech-like";
  return "other";
}

(async () => {
  // --files a.ass b.srt … sweeps local files instead of the cached corpus (used
  // for the adversarial fixtures in scripts/audit/fixtures/).
  const localFiles = args.includes("--files") ? args.slice(args.indexOf("--files") + 1).filter((a) => !a.startsWith("--")) : null;
  const corpus = localFiles
    ? localFiles.map((f) => ({ name: path.basename(f), url: `local:${path.resolve(f)}`, entryId: "local" }))
    : JSON.parse(fs.readFileSync(corpusPath, "utf8")).slice(0, limit);
  const client = createJimakuClient();
  const pipe = await createPipeline({ contentPath: opt("--content") ?? undefined, backgroundPath: opt("--background") ?? undefined });
  const unidic = await loadUnidic();
  const lookupCache = new Map();
  const lookup = async (word, isParticle = false, pos = null, isHonorificSuffix = false) => {
    const k = `${word}|${isParticle}|${pos}|${isHonorificSuffix}`;
    if (!lookupCache.has(k)) lookupCache.set(k, await pipe.lookupWord(word, isParticle, pos, isHonorificSuffix));
    return lookupCache.get(k);
  };
  const idsOf = (res) => new Set(res.results.map((e) => e.id ?? `${e.r}|${JSON.stringify(e.g?.[0])}`));

  let files = 0;
  let lines = 0;
  let groupsSeen = 0;
  let clickable = 0;
  let unresolvedCount = 0;
  for (const item of corpus) {
    let raw;
    try {
      if (item.url.startsWith("local:")) raw = fs.readFileSync(item.url.slice(6), "utf8");
      const r = raw != null ? { ok: true, text: async () => raw } : await client.fetch(item.url);
      if (!r.ok) continue;
      raw = await r.text();
    } catch {
      continue;
    }
    files++;
    const file = `${item.name} [entry ${item.entryId}]`;
    const isAss = /\.(ass|ssa)$/i.test(item.name);
    let cues;
    try {
      cues = isAss ? pipe.parseAss(raw) : pipe.parseSrt(raw);
    } catch (e) {
      note("PARSE-THROW", isAss ? "ass" : "srt", { line: e.message, file, invariant: true });
      continue;
    }
    if (!cues.length) note("PARSE-EMPTY", isAss ? "ass" : "srt", { line: `(0 cues from ${raw.length} bytes)`, file });
    const bad = cues.filter((c) => !Number.isFinite(c.start) || !Number.isFinite(c.end));
    for (const c of bad.slice(0, 3)) note("NAN-TIME", isAss ? "ass" : "srt", { line: c.text.slice(0, 60), file, invariant: true });
    if (bad.length > 3) note("NAN-TIME", `${isAss ? "ass" : "srt"} (+${bad.length - 3} more in file)`, { line: "", file, invariant: true });
    for (const c of cues.filter((c) => c.end < c.start).slice(0, 2)) note("NEG-DURATION", isAss ? "ass" : "srt", { line: c.text.slice(0, 60), file });

    const kept = pipe.stripDualLanguageCues(cues);
    if (kept !== cues && kept.length !== cues.length) {
      const keptSet = new Set(kept);
      const droppedKana = cues.filter((c) => !keptSet.has(c) && KANA.test(c.text));
      for (const c of droppedKana.slice(0, 3)) note("DUAL-STRIP-KANA", `style ${c.style || "(none)"}`, { line: c.text.slice(0, 80), file, invariant: true });
    }

    // Every distinct on-screen moment: the join of all cues active just after
    // each cue start — japaneseDisplayAt's own definition.
    const active = kept.filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end));
    const moments = [...new Set(active.map((c) => c.start))].sort((a, b) => a - b);
    const seenText = new Set();
    for (const t of moments) {
      const at = t + 0.001;
      const parts = [];
      const rawParts = [];
      for (const cue of active) {
        if (at < cue.start || at > cue.end) continue;
        const d = pipe.cueDisplayText(cue);
        rawParts.push(cue.text);
        if (!d) {
          const trimmed = cue.text.trim();
          if (/^[（(][^）)]*[）)]$/u.test(trimmed.replace(/\{\\[^}]*\}/g, "")) && KANA.test(trimmed)) {
            note("STAGE-DROP", stageShape(trimmed), { line: trimmed, file });
          }
          continue;
        }
        parts.push(d);
        // Speaker strip: what the filter removed from the front.
        const pre = cue.text.trim().replace(/\{\\[^}]*\}/g, "");
        const m = pre.match(/^(?:[（(][^）)]{1,12}[）)]|[^:：\n]{1,12}[:：])\s*/);
        if (m && d && !pre.startsWith(d.slice(0, 1)) && JWORD.test(pre.slice(m[0].length))) {
          note("SPEAKER-STRIP", speakerShape(m[0]), { line: pre.slice(0, 60), word: m[0], file });
        }
      }
      if (!parts.length) continue;
      // Identical text from two simultaneously active cues.
      const dupCount = parts.length - new Set(parts).size;
      if (dupCount) note("DUP-LAYER", isAss ? "ass" : "srt", { line: parts.join(" ⏎ ").slice(0, 80), file });
      const text = parts.join("\n");
      if (seenText.has(text)) continue;
      seenText.add(text);
      lines++;

      // Residue that survived the filters.
      if (/<\/?[a-zA-Z][^>]*>/.test(text)) note("RESIDUE-HTML", (text.match(/<\/?([a-zA-Z]+)/) ?? [])[1] ?? "?", { line: text.slice(0, 80), file });
      if (/\\[a-zA-Z]/.test(text)) note("RESIDUE-ASS-ESCAPE", (text.match(/\\([a-zA-Z])/) ?? [])[1], { line: text.slice(0, 80), file });
      if (/(^|\s)m\s+-?\d+(\.\d+)?\s+-?\d+/.test(text)) note("RESIDUE-DRAWING", isAss ? "ass" : "srt", { line: text.slice(0, 80), file });
      if (/&(amp|lt|gt|nbsp|quot|#\d+);/.test(text)) note("RESIDUE-ENTITY", "html-entity", { line: text.slice(0, 80), file });
      if (/[{}]/.test(text)) note("RESIDUE-BRACE", isAss ? "ass" : "srt", { line: text.slice(0, 80), file });
      const paren = text.match(/[（(][^）)]{1,30}[）)]/);
      if (paren && text.trim() !== paren[0]) note("PARTIAL-PAREN", /^[（(]/.test(text.trim()) ? "leading" : "inline", { line: text.slice(0, 80), word: paren[0], file });
      for (const ch of text.match(/\p{Script=Han}/gu) ?? []) {
        if (!JWORD.test(ch) && ch !== "々" && ch !== "〆") note("HAN-UNCLICKABLE", `U+${ch.codePointAt(0).toString(16).toUpperCase()}`, { line: text.slice(0, 60), word: ch, file });
      }

      const tokens = pipe.tokenizer.tokenize(text);
      if (tokens.map((x) => x.surface_form).join("") !== text) note("TOKEN-LOSSY", "kuromoji", { line: text, file, invariant: true });

      // Line break inside a word: tokenizing without the break joins across it.
      if (text.includes("\n")) {
        const flat = text.replace(/\n/g, "");
        const flatTokens = pipe.tokenizer.tokenize(flat);
        let off = 0;
        const breakAt = [];
        for (let i = 0, j = 0; i < text.length; i++) {
          if (text[i] === "\n") breakAt.push(j);
          else j++;
        }
        for (const ft of flatTokens) {
          const s = off;
          const e = off + ft.surface_form.length;
          off = e;
          if (breakAt.some((b) => b > s && b < e) && JWORD.test(ft.surface_form)) {
            note("MIDWORD-BREAK", ft.pos, { line: text.replace(/\n/g, "⏎"), word: ft.surface_form, file });
          }
        }
      }

      let groups;
      try {
        groups = await pipe.buildGroupsForText(text);
      } catch (e) {
        note("PIPELINE-THROW", e.message.slice(0, 60), { line: text, file, invariant: true });
        continue;
      }
      if (groups.map((g) => g.surface).join("") !== text) {
        note("GROUP-LOSSY", "concat≠display", { line: text, file, detail: groups.map((g) => g.surface).join("|"), invariant: true });
      }

      // UniDic spans for the disagreement checks.
      const uni = unidic ? unidic(text) : null;
      let off = 0;
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const gStart = off;
        const gEnd = off + g.surface.length;
        off = gEnd;
        groupsSeen++;
        if (g.word === null) continue;
        clickable++;
        if (typeof g.word !== "string" || !g.word) {
          note("GROUP-EMPTY-WORD", String(g.pos), { line: text, word: g.surface, file, invariant: true });
          continue;
        }
        const res = await lookup(g.word, g.isParticle ?? false, g.pos ?? null, g.isHonorificSuffix ?? false);
        const sig = `${scriptClass(g.word)}/${g.pos ?? "merged"}${g.isProperNoun ? "/固有名詞" : ""}`;
        if (!res.results.length) {
          unresolvedCount++;
          // Would UniDic's lemma for the same span have resolved it?
          let rescued = null;
          if (uni) {
            const inside = uni.filter((u) => u.start >= gStart && u.end <= gEnd);
            if (inside.length === 1) {
              for (const cand of [inside[0].orthBase, inside[0].lemma]) {
                if (cand && cand !== g.word && cand !== "*") {
                  const r2 = await lookup(cand);
                  if (r2.results.length) {
                    rescued = cand;
                    break;
                  }
                }
              }
            }
          }
          if (rescued) note("UNIDIC-RESOLVES", sig, { line: text, word: `${g.surface}→${g.word} (unidic: ${rescued})`, file });
          else note("UNRESOLVED", sig, { line: text, word: g.word, file });
        }
        // Lemma drift: an inflected word's surface must begin with the lemma's
        // stem (everything but the final kana), modulo kana/kanji orthography.
        if ((g.pos === "動詞" || g.pos === "形容詞") && g.word.length >= 2 && !IRREGULAR_LEMMAS.has(g.word)) {
          const stem = g.word.slice(0, -1);
          const surf = g.surface;
          const consistent =
            surf.startsWith(stem) ||
            // kanji stem written in kana or vice versa can't be checked by string
            (HAN.test(stem) !== HAN.test(surf.slice(0, stem.length))) ||
            (g.inflections?.length && surf.startsWith(g.inflections[0]) === false && surf.includes(stem));
          if (!consistent) note("LEMMA-DRIFT", `${g.pos}/${g.word.slice(-1)}`, { line: text, word: `${surf}→${g.word}`, file });
        }
        // A lone kanji split off an adjacent kanji run.
        if (KANJI_CHAR.test(g.surface) && !g.isProperNoun) {
          const prev = groups[gi - 1]?.surface ?? "";
          const next = groups[gi + 1]?.surface ?? "";
          if (/[㐀-鿿々]$/.test(prev) || /^[㐀-鿿々]/.test(next)) note("KANJI-FRAGMENT", String(g.pos), { line: text, word: `${prev}|${g.surface}|${next}`, file });
        }
        if (uni) {
          // A UniDic word our boundaries cut through.
          const cut = uni.find(
            (u) =>
              JWORD.test(u.surface) &&
              ((u.start < gStart && u.end > gStart) || (u.start < gEnd && u.end > gEnd)) &&
              !(u.start >= gStart && u.end <= gEnd)
          );
          if (cut && !/助詞|助動詞|補助記号/.test(cut.pos)) {
            note("UNIDIC-SPLIT", `${cut.pos}/${cut.pos2}`, { line: text, word: `ours:${g.surface} unidic:${cut.surface}`, file });
          }
          // Same span, both resolve, disjoint entries.
          const same = uni.filter((u) => u.start >= gStart && u.end <= gEnd);
          if (same.length === 1 && same[0].start === gStart && same[0].end === gEnd && res.results.length && !g.isParticle) {
            const lemma = same[0].orthBase && same[0].orthBase !== "*" ? same[0].orthBase : same[0].lemma;
            if (lemma && lemma !== g.word && !/^[0-9０-９]+$/.test(lemma)) {
              const r2 = await lookup(lemma, false, g.pos ?? null);
              if (r2.results.length) {
                const a = idsOf(res);
                const overlap = [...idsOf(r2)].some((id) => a.has(id));
                if (!overlap) note("UNIDIC-LEMMA", `${g.pos}/${same[0].pos}`, { line: text, word: `${g.surface}: ours ${g.word}, unidic ${lemma}`, file });
              }
            }
          }
        }
      }
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  const rows = [...clusters.values()].sort((a, b) => b.lines.size - a.lines.size);
  console.log(`\n${"═".repeat(78)}`);
  console.log(`Parsed ${files} files, ${lines} distinct displayed lines, ${groupsSeen} groups (${clickable} clickable, ${unresolvedCount} unresolved).`);
  console.log(`INVARIANT VIOLATIONS: ${invariantViolations.length}`);
  const byType = new Map();
  for (const c of rows) byType.set(c.type, (byType.get(c.type) ?? 0) + c.lines.size);
  console.log(`By type (distinct lines): ${[...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join("  ")}`);
  console.log(`\nClusters, largest first (occurrences / distinct lines / files):`);
  for (const c of rows) {
    const topWords = [...c.words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, n]) => `${w}×${n}`).join(", ");
    console.log(`\n■ ${c.type} :: ${c.signature}   ${c.count} / ${c.lines.size} / ${c.files.size}${topWords ? `   [${topWords}]` : ""}`);
    for (const ex of c.examples.slice(0, EXAMPLES)) console.log(`     ${ex.word ? `«${String(ex.word).slice(0, 40)}» ` : ""}${String(ex.line).replace(/\n/g, "⏎").slice(0, 90)}`);
  }
  if (outPath) {
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          files,
          lines,
          groupsSeen,
          clickable,
          unresolvedCount,
          invariantViolations,
          clusters: rows.map((c) => ({ ...c, lines: c.lines.size, files: [...c.files], words: Object.fromEntries(c.words) })),
        },
        null,
        1
      )
    );
    console.log(`\nfull report → ${outPath}`);
  }
})();
