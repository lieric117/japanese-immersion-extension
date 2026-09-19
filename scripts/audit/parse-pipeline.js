// The extension's REAL text pipeline, assembled in Node for the audit harness
// (2026-09-18): content.js's cueDisplayText + buildGroupsForText (extracted from
// the source, not re-implemented), tokenize-utils.js, and background.js's own
// checkKanaMergeCandidates / lookupWord running over the shipped
// jmdict-compact.json. What the harness measures is therefore what ships.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const kuromoji = require(path.join(ROOT, "scripts", "node_modules", "kuromoji"));
const utils = require(path.join(ROOT, "tokenize-utils.js"));
const parser = require(path.join(ROOT, "subtitle-parser.js"));
const { loadBackground } = require("./load-background.js");

function grab(src, re, label) {
  const m = src.match(re);
  if (!m) throw new Error(`could not extract ${label} from content.js — renamed?`);
  return m[0];
}

function buildTokenizer() {
  return new Promise((resolve, reject) =>
    kuromoji.builder({ dicPath: path.join(ROOT, "vendor", "kuromoji-dict") }).build((e, t) => (e ? reject(e) : resolve(t)))
  );
}

async function createPipeline({ contentPath = path.join(ROOT, "content.js"), backgroundPath } = {}) {
  const tokenizer = await buildTokenizer();

  // background.js with fetch pointed at the local dictionary file.
  const jmdictText = fs.readFileSync(path.join(ROOT, "jmdict-compact.json"), "utf8");
  const bg = loadBackground({
    backgroundPath,
    fetch: async (url) => {
      if (String(url).endsWith("jmdict-compact.json")) return { ok: true, json: async () => JSON.parse(jmdictText) };
      throw new Error(`unexpected fetch in parse pipeline: ${url}`);
    },
    exportNames: ["checkKanaMergeCandidates", "lookupWord", "loadJmdict"],
  });

  const src = fs.readFileSync(contentPath, "utf8");
  const consts = [
    grab(src, /^const STAGE_RE = .*$/m, "STAGE_RE"),
    grab(src, /^const SPEAKER_PREFIX_RE = .*$/m, "SPEAKER_PREFIX_RE"),
    grab(src, /^const INLINE_FURIGANA_RE = .*$/m, "INLINE_FURIGANA_RE"),
    grab(src, /^const FANSUB_MARKUP_RE =\n.*$/m, "FANSUB_MARKUP_RE"),
    grab(src, /^const ASS_OVERRIDE_RE = .*$/m, "ASS_OVERRIDE_RE"),
    grab(src, /^const SENTENCE_PERIOD_RE = .*$/m, "SENTENCE_PERIOD_RE"),
  ];
  // Optional helpers a fixed content.js may define and cueDisplayText call.
  const optional = [];
  for (const name of ["FORMAT_CHAR_RE", "DIGIT_COLON_RE", "DIALOGUE_DASH_RE", "DOUBLED_OPEN_RE", "DOUBLED_CLOSE_RE"]) {
    const m = src.match(new RegExp(`^const ${name} = .*$`, "m"));
    if (m) optional.push(m[0]);
  }
  const cueDisplayTextSrc =
    grab(src, /^function cueDisplayText\([\s\S]*?\n\}/m, "cueDisplayText") +
    "\n" +
    ((src.match(/^function lineDisplayText\([\s\S]*?\n\}/m) ?? [""])[0]);
  const buildSrc = grab(src, /^async function buildGroupsForText\([\s\S]*?\n\}/m, "buildGroupsForText");

  const checkKanaMerges = async (texts) => bg.checkKanaMergeCandidates(texts);
  const factory = new Function(
    "utils",
    "tokenizer",
    "checkKanaMerges",
    `const { ${Object.keys(utils).join(", ")} } = utils;\n` +
      [...consts, ...optional, cueDisplayTextSrc, buildSrc].join("\n") +
      "\nreturn { cueDisplayText, buildGroupsForText };"
  );
  const { cueDisplayText, buildGroupsForText } = factory(utils, tokenizer, checkKanaMerges);

  await bg.loadJmdict();
  return {
    tokenizer,
    cueDisplayText,
    buildGroupsForText,
    lookupWord: bg.lookupWord,
    checkKanaMergeCandidates: bg.checkKanaMergeCandidates,
    parseSrt: parser.parseSrt,
    parseAss: parser.parseAss,
    stripDualLanguageCues: parser.stripDualLanguageCues,
    // The real track-cleaning step when this subtitle-parser.js has one.
    cleanParsedCues: parser.cleanParsedCues ?? parser.stripDualLanguageCues,
    utils,
  };
}

module.exports = { createPipeline, buildTokenizer };
