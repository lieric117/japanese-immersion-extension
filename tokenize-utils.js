// Shared tokenization helpers used by both content.js (browser) and the
// offline batch-testing script (Node.js). In the browser this file is loaded
// as a plain content script before content.js, so these names become globals.
// In Node.js the bottom module.exports block makes them importable normally.

// Matches hiragana, katakana (full-width and half-width), and kanji.
// Half-width katakana (ｦ-ﾟ, U+FF66-FF9F) is included because some fansub
// groups (e.g. VCB-Studio Bocchi) encode katakana in half-width form.
const JAPANESE_WORD_RE = /[ぁ-ヿ㐀-鿿ｦ-ﾟ]/;

// Katakana only (full-width, half-width, prolonged sound mark). Used to spot
// character/place names spelled with no kanji at all — kuromoji frequently
// fragments these into a real common-word token plus an unrecognized proper-
// noun fragment (フリーレン → フリー "free" + レン, no entry), which otherwise
// leaves a real-but-wrong definition sitting on part of a name.
const KATAKANA_ONLY_RE = /^[ァ-ヺｦ-ﾟー]+$/;

// Returns true for a 動詞 token that is a contracted te-form auxiliary:
// てる/てた/てく/てき = contracted ている/ていた/ていく/てくる.
// Only て-starting contractions are checked here; voiced-stem contractions
// (でる, でた) are ambiguous with the standalone verb 出る/出た and are
// deferred until testing surfaces them as a real problem.
function isContractedTeAux(token) {
  return token.pos === "動詞" && token.surface_form.startsWith("て");
}

// Auxiliaries that always absorb into the preceding word regardless of what
// that word is (verb, adjective, or — for だ/です only, via isPlainCopula —
// a noun) because they carry no independent lexical meaning of their own:
// pure tense/negation/desire/causative/passive markers, and う (always its
// own kuromoji token — even after a plain volitional stem: 行こう → 行こ+う —
// so it's absorbed unconditionally rather than only after でしょ/だろ).
const PURE_INFLECTION_AUX = new Set(["た", "ない", "たい", "せる", "させる", "れる", "られる", "う"]);

// だ/です only count as the plain (always-absorbable) copula when tagged
// 基本形 (base form). でしょ/だろ share the exact same basic_form (です/だ
// respectively) but are tagged 未然形 (imperfective — they're だ/です's
// imperfective stem plus a following volitional う), which is kuromoji's only
// distinguishing signal between "polite/plain copula" and "conjecture form."
function isPlainCopula(token) {
  return (token.basic_form === "だ" || token.basic_form === "です") && token.conjugated_form === "基本形";
}

// Content-word POS categories, used to decide whether a phrase-match's
// boundary tokens are "real" independent words worth their own click (see
// applyPhraseMatches' dual-view vs. full-fuse split). Deliberately does NOT
// exclude 名詞/非自立 ("dependent noun") despite that covering both real
// content nouns (もの "thing") and pure grammatical contractions (ん, a
// contraction of の) — kuromoji tags both identically, so there's no reliable
// way to tell them apart at the tag level. In practice this doesn't matter:
// every phrase-match that should stay split (んだ, たら) also has a genuinely
// non-content token at the OTHER boundary (だ, or たら itself being tagged
// 助動詞), so the two-sided check still gives the right answer either way.
const CONTENT_POS = new Set(["動詞", "名詞", "形容詞", "副詞", "連体詞"]);
function isContentToken(token) {
  return CONTENT_POS.has(token.pos);
}

// Groups kuromoji tokens into learner-clickable units. `fuseSpans` (optional)
// is a sorted, non-overlapping list of {start, end, lookupText} raw-token
// index ranges that findPhraseMatchCandidates/applyPhraseMatches has already
// decided must become ONE clickable unit (からといって, じゃない, んだ, たら,
// etc.) — these take priority over every rule below, since e.g. Rule 3 would
// otherwise absorb た into 帰った before the たら phrase-match ever got a
// chance to see it as a separate token (see applyPhraseMatches for why this
// has to run first, not as a post-process). Every pushed group also records
// which raw token indices it covers (tokenStart/tokenEnd) so a *dual-view*
// phrase match (one that doesn't consume tokens, just annotates — see
// applyPhraseMatches) can find which final group to attach its note to.
//
// Rule 0 — Honorific prefix (接頭詞) + following word → merge:
//   e.g. お弁当 → one span, looks up 弁当
//   The honorific prefix adds no independent lookup value.
//
// Rule 0.5 — Pronoun + pluralizing suffix (私たち, 僕たち, 彼ら) → merge
//   unconditionally, a productive always-grammatical compounding pattern.
//
// Rule 1 — Te-form: [動詞]+[助詞 て/で] → one group:
//   e.g. 食べてしまった → 食べて (looks up 食べる) + しまった (looks up しまう)
//   Merges verb + て into one span regardless of what follows. If the next
//   token is another 動詞 (the auxiliary), it gets its own separate group.
//
// Rule 2 — Contracted te-form [動詞]+[動詞 starting with て]:
//   e.g. 見てる (contracted 見ている) → 見てる (looks up 見る)
//
// Rule 3 — Auxiliary absorption, allowlisted (not "any 助動詞"): only
// PURE_INFLECTION_AUX (た/ない/たい/せる/させる/れる/られる/う — no
// independent meaning of their own) and the plain copula (isPlainCopula: だ/
// です tagged 基本形) absorb into the preceding word. Modal auxiliaries with
// real independent meaning — でしょ/だろ (未然形, not 基本形), らしい, べき,
// まい — do NOT absorb; they fall through and start their own group instead
// (でしょ+う then correctly re-merges via this same rule on its next pass,
// since う is in PURE_INFLECTION_AUX regardless of what precedes it).
// たり/だり is pos 助詞, so it needs an explicit surface-form check.
function groupTokens(tokens, fuseSpans = []) {
  const groups = [];
  let i = 0;
  let fuseIdx = 0;
  while (i < tokens.length) {
    if (fuseIdx < fuseSpans.length && fuseSpans[fuseIdx].start === i) {
      const span = fuseSpans[fuseIdx];
      let surface = "";
      for (let k = span.start; k <= span.end; k++) surface += tokens[k].surface_form;
      groups.push({ surface, word: span.lookupText, inflections: [], tokenStart: span.start, tokenEnd: span.end });
      i = span.end + 1;
      fuseIdx++;
      continue;
    }

    const token = tokens[i];
    if (!JAPANESE_WORD_RE.test(token.surface_form)) {
      groups.push({ surface: token.surface_form, word: null, tokenStart: i, tokenEnd: i });
      i++;
      continue;
    }

    // Katakana-only proper-noun runs (character/place names with no kanji)
    // become one fully inert span covering the WHOLE run, not just whichever
    // fragment kuromoji happened to tag 固有名詞 — covers cases where the rest
    // of the name coincidentally matches a real, unrelated word (フリー
    // "free" sitting right next to レン, an unrecognized name fragment).
    // Non-name katakana loanwords (ｷﾞﾀｰ, ﾊﾞﾝﾄﾞ) are never tagged 固有名詞, so
    // they fall through to normal processing untouched.
    if (KATAKANA_ONLY_RE.test(token.surface_form)) {
      let j = i;
      let hasProperNoun = false;
      let surface = "";
      while (
        j < tokens.length &&
        KATAKANA_ONLY_RE.test(tokens[j].surface_form) &&
        (fuseIdx >= fuseSpans.length || j < fuseSpans[fuseIdx].start)
      ) {
        if (tokens[j].pos_detail_1 === "固有名詞") hasProperNoun = true;
        surface += tokens[j].surface_form;
        j++;
      }
      if (hasProperNoun) {
        groups.push({ surface, word: null, tokenStart: i, tokenEnd: j - 1 });
        i = j;
        continue;
      }
    }

    // Particles (助詞) are grammatical function words. They're clickable, but
    // the lookup should filter for particle senses, not homophone nouns
    // (に→荷 "cargo", は→歯 "tooth"). isParticle flags this for background.js.
    if (token.pos === "助詞") {
      groups.push({ surface: token.surface_form, word: token.surface_form, isParticle: true, inflections: [], tokenStart: i, tokenEnd: i });
      i++;
      continue;
    }

    const surface0 = token.surface_form;
    const word = token.basic_form !== "*" ? token.basic_form : token.surface_form;
    const next1 = (fuseIdx >= fuseSpans.length || i + 1 < fuseSpans[fuseIdx].start) ? tokens[i + 1] : undefined;

    // Rule 0: honorific prefix + following word
    if (token.pos === "接頭詞" && next1 && JAPANESE_WORD_RE.test(next1.surface_form)) {
      const nextWord = next1.basic_form !== "*" ? next1.basic_form : next1.surface_form;
      groups.push({ surface: surface0 + next1.surface_form, word: nextWord, inflections: [], pos: next1.pos, tokenStart: i, tokenEnd: i + 1 });
      i += 2;
      continue;
    }

    // Rule 0.5: pronoun + pluralizing suffix (私たち, 僕たち, 彼ら, あなたがた) —
    // merged unconditionally (not gated on JMdict lookup like the general
    // phrase-merge mechanism) since this is a productive, always-grammatical
    // Japanese compounding pattern regardless of whether that exact pronoun+
    // suffix combination happens to have its own JMdict headword.
    if (
      token.pos === "名詞" && token.pos_detail_1 === "代名詞" &&
      next1 && next1.pos === "名詞" && next1.pos_detail_1 === "接尾"
    ) {
      groups.push({ surface: surface0 + next1.surface_form, word: surface0 + next1.surface_form, inflections: [], pos: "名詞", tokenStart: i, tokenEnd: i + 1 });
      i += 2;
      continue;
    }

    // Rule 0.6: ん + copula-family (explanatory contraction of の+だ/です).
    // Bare ん here has no useful standalone meaning — it's a contraction of
    // の — but JMdict only has a headword for んだ itself, not for んだろう/
    // んでしょう (だろう/でしょう replacing plain だ/です to add conjecture
    // nuance). Phrase-matching's exact-headword-anchoring can't reach those
    // extended forms, so this recognizes the construction deterministically
    // instead and looks up のだ directly, keeping the copula-family chain
    // that followed (だろう, でしょう, ...) as the inflection label.
    //
    // Deliberately checks the RAW next token (tokens[i+1]), not the
    // fuseSpan-gated `next1` — phrase-matching independently finds だろう/
    // でしょう as their own valid 2-token fuse (they have their own JMdict
    // entry), which would otherwise claim that position first and hide it
    // from this rule's lookahead. This rule needs to win that race, since
    // ん+だろう is the more specific, more correct construction.
    if (
      token.pos === "名詞" && token.basic_form === "ん" &&
      tokens[i + 1] && tokens[i + 1].pos === "助動詞" &&
      (tokens[i + 1].basic_form === "だ" || tokens[i + 1].basic_form === "です")
    ) {
      let surface = surface0 + tokens[i + 1].surface_form;
      const inflections = [tokens[i + 1].surface_form];
      let k = i + 2;
      while (
        k < tokens.length &&
        tokens[k].pos === "助動詞" && PURE_INFLECTION_AUX.has(tokens[k].basic_form)
      ) {
        surface += tokens[k].surface_form;
        inflections.push(tokens[k].surface_form);
        k++;
      }
      groups.push({ surface, word: "のだ", inflections, pos: "助動詞", tokenStart: i, tokenEnd: k - 1 });
      i = k;
      // A fuseSpan (e.g. plain だろう) may have started inside the range this
      // rule just consumed — skip past it so fuseIdx stays aligned with `i`.
      while (fuseIdx < fuseSpans.length && fuseSpans[fuseIdx].start < i) fuseIdx++;
      continue;
    }

    // Rule 1: te-form — always merge verb + て/で into one group
    if (
      token.pos === "動詞" &&
      next1 && next1.pos === "助詞" &&
      (next1.surface_form === "て" || next1.surface_form === "で")
    ) {
      groups.push({ surface: surface0 + next1.surface_form, word, inflections: ["て"], pos: token.pos, tokenStart: i, tokenEnd: i + 1 });
      i += 2;
      continue;
    }

    // Rule 2: contracted te-form auxiliary
    if (token.pos === "動詞" && next1 && isContractedTeAux(next1)) {
      groups.push({ surface: surface0 + next1.surface_form, word, inflections: [], pos: token.pos, tokenStart: i, tokenEnd: i + 1 });
      i += 2;
      continue;
    }

    // Rule 3: allowlisted auxiliary absorption (see function doc comment).
    let surface = surface0;
    const inflections = [];
    let j = i + 1;
    let prevConjugatedForm = token.conjugated_form;
    while (j < tokens.length && (fuseIdx >= fuseSpans.length || j < fuseSpans[fuseIdx].start)) {
      const n = tokens[j];
      const isTari = n.pos === "助詞" && (n.surface_form === "たり" || n.surface_form === "だり");
      // せる/させる/れる/られる are listed in PURE_INFLECTION_AUX but kuromoji
      // never tags them 助動詞 like た/ない/たい/う — it tags them 動詞 with
      // pos_detail_1 "接尾" (verb-suffix), distinct from an ordinary
      // independent verb (自立). Confirmed empirically 2026-07-03: without
      // this check they were never actually absorbed by the line below,
      // since inclusion in the set alone doesn't satisfy `n.pos === "助動詞"`.
      const isSuffixAux = n.pos === "動詞" && n.pos_detail_1 === "接尾" && PURE_INFLECTION_AUX.has(n.basic_form);
      const isAbsorbable =
        (n.pos === "助動詞" && (PURE_INFLECTION_AUX.has(n.basic_form) || isPlainCopula(n))) || isSuffixAux;
      // ば (助詞, conditional/hypothetical) absorbs only right after a verb or
      // adjective already conjugated to 仮定形 (見れ+ば, 聞け+ば) — narrow,
      // matches the isTari precedent below (surface-form check on a 助詞
      // rather than requiring 助動詞) but additionally gated on the preceding
      // conjugation, since bare ば has its own unrelated meanings (a real
      // noun "ば" = "place") that only the 仮定形 context rules out. Added
      // 2026-07-03 at the user's request: two separate clicks (a verb stem
      // fragment + a bare ば particle) is worse than one click on the actual
      // conditional-inflected verb, the same reasoning that already justified
      // merging て/た, and leaving ば out was an inconsistency, not a
      // deliberate exclusion.
      const isBaConditional = n.pos === "助詞" && n.surface_form === "ば" && prevConjugatedForm === "仮定形";
      if (!isAbsorbable && !isTari && !isBaConditional) break;
      surface += n.surface_form;
      inflections.push(n.surface_form);
      prevConjugatedForm = n.conjugated_form;
      j++;
    }
    // Proper nouns (人名/地名 etc., IPADIC pos_detail_1 "固有名詞") are frequently
    // invented character/place names with no JMdict entry at all. Flagging
    // this lets content.js suppress the popup on an empty lookup instead of
    // showing "no dictionary entry for X" — the word still stays clickable
    // in case it turns out to have a real entry (many real names do).
    const isProperNoun = token.pos_detail_1 === "固有名詞";
    // でしょ/だろ (conjecture stem) starting a group shares です/だ's
    // basic_form, but is NOT です/だ itself — でしょう/だろう have their own
    // JMdict headword ("probably; I guess"). Rule 0.6 already special-cases
    // the ん-prefixed version (んでしょう); this covers the bare version so it
    // doesn't fall through to `word` = です/だ's own "be; is" definition.
    // Fires even when う was never absorbed (confirmed 2026-07-03: bare
    // だろ/でしょ — colloquial そうだろ, without う — is common real speech,
    // not just a truncation of だろう, and jmdict-compact.json's index
    // already resolves "だろ"/"でしょ" to the same real headword as
    // "だろう"/"でしょう").
    //
    // Must check conjugated_form === "未然形" specifically, NOT just
    // "!== 基本形" — confirmed as a real regression 2026-07-03 via batch-test:
    // past-tense でした/だった tokenize as でし/だっ (conjugated_form 連用形 /
    // 連用タ接続, both also "not 基本形") + absorbed た, and the broader check
    // wrongly routed their surface string (でした/だった, no JMdict headword
    // of their own) through as the lookup word instead of です/だ, turning a
    // silent wrong-entry bug into a new lookup miss. 未然形 is specifically
    // だ/です's imperfective stem + volitional う — the one signal that
    // actually means "this is でしょう/だろう," per the original find.
    const isConjectureCopula =
      token.pos === "助動詞" &&
      (token.basic_form === "だ" || token.basic_form === "です") &&
      token.conjugated_form === "未然形";
    const resolvedWord = isConjectureCopula ? surface : word;
    // Recorded purely for popup display (e.g. detecting imperative — 食べろ
    // is one token with no following auxiliary, so `inflections` stays empty
    // and conjugated_form is the only signal it inflected at all). Doesn't
    // affect grouping/merge behavior, just carries a bit more of what
    // kuromoji already knows through to content.js.
    const conjugatedForm = token.conjugated_form && token.conjugated_form !== "*" ? token.conjugated_form : null;
    groups.push({ surface, word: resolvedWord, inflections, isProperNoun, pos: token.pos, conjugatedForm, tokenStart: i, tokenEnd: j - 1 });
    i = j;
  }
  return groups;
}

// Pure hiragana (+ long-vowel mark ー). Kanji/katakana runs aren't checked here
// since the failure mode this targets — kuromoji's Viterbi cost picking a
// fragmented grammatical parse (た+だ+いま) over a legitimate single-word
// reading (ただいま) when punctuation sits directly against the word — shows
// up on hiragana interjections/nouns, not on kanji compounds.
const HIRAGANA_ONLY_RE = /^[ぁ-ゖー]+$/;

// Caps how many characters a candidate merge can span. Keeps candidates scoped
// to short common words/interjections (ただいま=4, かくれんぼ=5) rather than
// growing into long, unrelated multi-word runs that would risk false merges.
const MAX_KANA_MERGE_LEN = 6;

// Wave dash / fullwidth tilde, used by fansub typesetters to show a speaker
// drawing out a sound mid-word (か〜くれんぼ = "kaaa~kurenbo"). kuromoji tokenizes
// it as its own symbol token, which would otherwise break a merge candidate
// right in the middle of a real word. Treated as transparent: kept in the
// displayed surface, stripped from the text used to check JMdict.
const ELONGATION_RE = /^[〜～]+$/;

// Hard sentence-ending punctuation that sometimes sits directly against a
// word with no space in subtitle files. Confirmed empirically: ただいま！
// fragments into た+だ+いま, but ただいまー (trailing long-vowel mark instead of
// punctuation) tokenizes correctly as one word. So trailing punctuation is a
// real trigger for kuromoji's Viterbi cost picking a fragmented parse — but
// two ordinary adjacent words (今日は + いい) are NOT evidence of a mistake on
// their own, even though "はいい" coincidentally matches an unrelated obscure
// JMdict entry. Restricting merge attempts to only fire when a concrete
// disruption (trailing hard punctuation, or an embedded elongation mark) is
// present keeps the scan from firing on ordinary running dialogue.
const HARD_PUNCTUATION_RE = /^[！？。!?]+$/;

// JMdict POS codes that mark an entry as a grammatical/expressive fusion
// (particle, expression, conjunction, interjection, auxiliary verb) rather
// than a standalone content word. Confirmed against a 1257-line real corpus
// (Bocchi/Frieren/One Piece): every punctuation-triggered false positive
// (あったか→adj-na "warm", たんだ→n "base hit", いくよ→n "how many nights") matched
// only a content-word POS, while every correct punctuation-triggered merge
// (よね/かな/のか→prt, ために→conj, そうか/うわっ/んっ→int, やんす→aux-v) matched one
// of these. Used as an extra gate on punctuation-triggered candidates only —
// see requiresFunctionPos in applyKanaMerges.
const FUNCTION_POS_CODES = new Set(["prt", "exp", "conj", "int", "aux-v"]);

// Scans groups for runs that might be a single word kuromoji fragmented, and
// returns merge candidates gated on one of the two confirmed trigger
// conditions above. Particle-tagged fragments are included (not excluded)
// because homograph collisions are common on single-mora fragments — e.g. か
// is both a real question particle and the first fragment of かくれんぼ — so
// the POS tag isn't a reliable filter here. This doesn't decide which
// candidates are real words — callers check `lookupText` against JMdict and
// pick non-overlapping matches (see applyKanaMerges).
function findKanaMergeCandidates(groups) {
  const candidates = [];
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].word === null || !HIRAGANA_ONLY_RE.test(groups[i].surface)) continue;

    let surface = groups[i].surface; // displayed text, keeps elongation marks
    let lookupText = groups[i].surface; // JMdict lookup key, elongation stripped
    let end = i;
    let sawElongation = false;

    for (let j = i + 1; j < groups.length; j++) {
      const next = groups[j];
      if (next.word === null && ELONGATION_RE.test(next.surface)) {
        surface += next.surface;
        end = j;
        sawElongation = true;
        continue;
      }
      if (next.word === null || !HIRAGANA_ONLY_RE.test(next.surface)) break;

      const candidateLookup = lookupText + next.surface;
      if (candidateLookup.length > MAX_KANA_MERGE_LEN) break;
      surface += next.surface;
      lookupText = candidateLookup;
      end = j;

      const following = groups[end + 1];
      const followedByHardPunctuation =
        following?.word === null && HARD_PUNCTUATION_RE.test(following.surface);
      if (sawElongation || followedByHardPunctuation) {
        candidates.push({ start: i, end, surface, lookupText, viaElongation: sawElongation });
      }
    }
  }
  return candidates;
}

// Given merge candidates and a membership map ({lookupText: {exists, posCodes}}
// from background.js's JMdict index), picks the longest, non-overlapping
// candidates that pass their gate and splices them into the group list as
// single clickable words.
//
// Two different gates, matched to how each trigger's false-positive risk
// actually showed up empirically (see the 1257-line corpus check referenced
// on FUNCTION_POS_CODES above):
// - Elongation-triggered (a real word interrupted by a mid-word 〜) only needs
//   plain existence — 100% correct in the corpus check, including plain-noun
//   matches like かくれんぼ, which a POS gate would have wrongly rejected.
// - Punctuation-triggered (two adjacent words that happen to end a sentence)
//   is weaker evidence on its own, since any verb/particle combo ending a
//   line is common — needs at least one matching entry tagged as a
//   grammatical/expressive fusion (FUNCTION_POS_CODES), not just any content
//   word a coincidental concatenation could hit.
// Shared by applyKanaMerges and applyPhraseMerges: picks the longest,
// non-overlapping candidates that pass `isAccepted`, preferring earlier spans
// on ties.
function selectNonOverlappingSpans(groups, candidates, isAccepted) {
  const accepted = candidates
    .filter(isAccepted)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);

  const used = new Array(groups.length).fill(false);
  const chosen = [];
  for (const c of accepted) {
    let overlaps = false;
    for (let k = c.start; k <= c.end; k++) {
      if (used[k]) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    for (let k = c.start; k <= c.end; k++) used[k] = true;
    chosen.push(c);
  }
  chosen.sort((a, b) => a.start - b.start);
  return chosen;
}

// Splices the chosen spans into the group list, replacing each span with a
// single group built by `toGroup`.
function spliceMergedGroups(groups, chosen, toGroup) {
  const result = [];
  let i = 0;
  let ci = 0;
  while (i < groups.length) {
    if (ci < chosen.length && chosen[ci].start === i) {
      result.push(toGroup(chosen[ci]));
      i = chosen[ci].end + 1;
      ci++;
    } else {
      result.push(groups[i]);
      i++;
    }
  }
  return result;
}

function applyKanaMerges(groups, candidates, membership) {
  const chosen = selectNonOverlappingSpans(groups, candidates, (c) => {
    const m = membership[c.lookupText];
    if (!m?.exists) return false;
    if (c.viaElongation) return true;
    return m.posCodes?.some((p) => FUNCTION_POS_CODES.has(p));
  });
  return spliceMergedGroups(groups, chosen, (c) => ({
    surface: c.surface,
    word: c.lookupText,
    inflections: [],
  }));
}

// Caps how many raw tokens a phrase-match window can span — grammar
// expressions like なければならない or からといって run several tokens long.
const MAX_PHRASE_MATCH_LEN = 4;

// General multi-token phrase matcher, operating on RAW kuromoji tokens —
// deliberately BEFORE groupTokens/Rule 3 ever runs, not as a post-process on
// its output. This has to happen first: 帰ったら tokenizes as 帰っ+たら (one
// combined auxiliary token, basic_form "た"), and Rule 3 would already have
// absorbed that た-tagged token into 帰った (pure-inflection auxiliaries
// always absorb) before any post-hoc scan could see it as available for a
// separate たら phrase match. Scans windows of 2-4 consecutive tokens;
// candidates are just raw spans — callers check `lookupText` against JMdict
// and classify/select them (see classifyAndSelectPhraseMatches).
function findPhraseMatchCandidates(tokens) {
  const candidates = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!JAPANESE_WORD_RE.test(tokens[i].surface_form)) continue;
    let surface = tokens[i].surface_form;
    for (let j = i + 1; j < tokens.length && j - i < MAX_PHRASE_MATCH_LEN; j++) {
      if (!JAPANESE_WORD_RE.test(tokens[j].surface_form)) break;
      surface += tokens[j].surface_form;
      candidates.push({ start: i, end: j, lookupText: surface });
    }
  }
  return candidates;
}

// A matched phrase is shown as an *additional* entry alongside the normal
// per-token breakdown (dual-view) — rather than replacing it (full fuse) —
// when BOTH boundary tokens of the match are genuine content words (動詞/
// 名詞/形容詞/副詞/連体詞): real nouns/verbs/adjectives that would already be
// worth their own click regardless of the match (もの…なる in 長いものになる —
// both real, independently useful words; the ものになる idiom is additional
// information, not a replacement, since context alone can't say which
// reading is meant — the same reasoning that rules out AI grammar
// explanations generally: guessing the "right" sense from context is a soft
// judgment call, out of scope). If EITHER boundary is a particle/auxiliary/
// contracted-copula fragment (じゃない, からといって, そうか, たら, んだ — じゃ/
// か/ら/だ carry no useful standalone meaning in this position), the match
// fully replaces the individual breakdown instead — items 1/3/4 already
// establish those specific fragments aren't worth their own click, so
// exposing them again here would just undo that.
//
// と particle is an explicit exception, always forced to dual-view even when
// it sits next to a negative verb (探さないと): unlike じゃ/か/ら/だ, と keeps a
// genuinely common, unrelated job in that exact position — plain reported-
// speech/conditional と (できないと思う, 分からないと言った) — far more often
// than it's actually the ないと "have to" idiom. Fully fusing on that
// coincidence would mis-gloss ordinary quotation as an obligation statement;
// dual-view keeps 探さ/ない/と individually correct while still surfacing
// ないと as a real, additional possibility to check.
//
// hasSuspiciousFragment guards the opposite mistake: ひとりぼっち's boundary
// tokens (ひとり, ち) both happen to carry a content POS tag, which would
// otherwise route it to dual-view — but ち is a bogus 1-character 動詞
// fragment from kuromoji's own ぼっち mis-segmentation (never fixed this
// session), not a real independent word the way もの/なる are in
// 長いものになる. Leaving ぼっ/ち individually clickable under dual-view would
// just reproduce the exact bug this was meant to solve. Forcing these back
// to the fuse path (where the length-based gate below can still accept them
// as one unit) is correct: unlike ものになる, there's no valid independent
// breakdown here to preserve.
// TWO CONSECUTIVE 1-character 動詞/形容詞 tokens, with nothing between them —
// not just any short verb token — is the red flag for a kuromoji
// segmentation error (ぼっ+ち, from ぼっち/ひとりぼっち): real Japanese grammar
// essentially never puts two independent verbs directly adjacent with no
// connector (て-form, a particle, an auxiliary) between them, so this pattern
// is a strong, narrow signal that kuromoji invented a fake boundary rather
// than a genuine two-word sequence.
//
// Originally checked for ANY single 1-character 動詞/形容詞 token anywhere in
// the span, which was far too broad: ordinary common verbs routinely have a
// correct 1-mora conjunctive stem (し for する, い for いる, み for 見る) with a
// real particle in between (し+て+い, み+た) — that pattern isn't a
// segmentation error at all, and the broad version wrongly forced it away
// from dual-view and into fuse, where it then collided with unrelated
// coincidental entries (してい→"servant", てい→"appearance", にい→"big
// brother", all real headwords, all completely unrelated here).
//
// Threshold is <=2 characters, not exactly 1 — confirmed ぼっ (from ぼっち) is
// itself 2 characters (ぼ + the small っ sokuon, a separate character in a JS
// string despite not adding its own mora), so a strict ===1 check silently
// never matched the very case this was written for.
function hasSuspiciousFragment(tokens, span) {
  const isShortVerbOrAdj = (t) => (t.pos === "動詞" || t.pos === "形容詞") && t.surface_form.length <= 2;
  for (let k = span.start; k < span.end; k++) {
    if (isShortVerbOrAdj(tokens[k]) && isShortVerbOrAdj(tokens[k + 1])) return true;
  }
  return false;
}

function isDualViewMatch(tokens, span) {
  const isToParticle = (t) => t.pos === "助詞" && t.surface_form === "と";
  if (isToParticle(tokens[span.start]) || isToParticle(tokens[span.end])) return true;
  if (hasSuspiciousFragment(tokens, span)) return false;
  return isContentToken(tokens[span.start]) && isContentToken(tokens[span.end]);
}

// Splits accepted candidates into fuseSpans (become one clickable unit,
// replacing the individual tokens) and dualViewSpans (individual tokens stay
// clickable; the phrase is attached as a secondary note only).
//
// Both outcomes are resolved in ONE combined overlap-resolution pass (longest
// span wins, regardless of which outcome it's headed for) rather than two
// independent ones — otherwise a shorter fuse candidate that was never in
// competition with a longer dual-view candidate can win a position by
// default. Confirmed real: ひとりぼっち (dual-view eligible, 3 tokens) and ちな
// (fuse eligible, 2 tokens, overlapping at ち) need to compete directly, or
// ちな wins simply because it was never in ひとりぼっち's candidate pool.
//
// dualViewSpans don't consume or alter any tokens, so — unlike fusion — a
// coincidental match there just risks showing an accurate-but-not-strictly-
// relevant extra fact (それも's real "moreover" sense surfacing even when
// それ+も is meant compositionally), never a wrong replacement. It only needs
// the existence check. fuseSpans keep the full gate from this session's
// fusion-only design, since a wrong fuse there really would replace a
// correct individual breakdown with a coincidental one — every correct
// grammatical fuse matched exp/prt/conj/int/aux-v (see FUNCTION_POS_CODES),
// every correct compound-noun fuse was pure 名詞+名詞, and every confirmed-
// real long phrase (からといって, にもかかわらず, ひとりぼっち) was 5+
// characters. That length check is now on CHARACTERS, not raw token count —
// あった alone splits into two raw tokens (あっ+た), so あったか (a confirmed
// false positive, "warm") was wrongly passing a "3+ raw tokens" version of
// this same check even though it's really just two short words, 4
// characters total.
function classifyAndSelectPhraseMatches(tokens, candidates, membership) {
  // Reject any candidate span that plain (non-phrase) groupTokens already
  // produces as exactly one group — Rule 1/2/3/0.5/0.6 already give the
  // right answer for it (い+た already correctly absorbs to いる via Rule 3's
  // pure-inflection allowlist), so phrase-matching re-checking that same
  // span against JMdict can only ever find a coincidentally different
  // answer, never a better one. Confirmed real and high-frequency: いた
  // (い+た, the ordinary いる-past continuation, in nearly every scene with
  // past-progressive tense) coincidentally matches 板 ("board/plank",
  // marked common) — far more common a collision than があん's narrow
  // trigger, since verb-stem + pure-inflection-auxiliary spans appear
  // constantly, and every single one was a live candidate for a wrong
  // dictionary answer before this filter.
  const baselineGroups = groupTokens(tokens);
  const alreadyGrouped = new Set(baselineGroups.map((g) => `${g.tokenStart}:${g.tokenEnd}`));

  const scored = [];
  for (const c of candidates) {
    if (alreadyGrouped.has(`${c.start}:${c.end}`)) continue;
    const m = membership[c.lookupText];
    if (!m?.exists) continue;
    // A pure noun+noun run (王都 = 王+都, no intervening particle/verb) is
    // always a straightforward compound noun, never a dual-view idiom —
    // dual-view exists for cases like もの…なる where the boundary words stay
    // independently meaningful across an intervening particle. Checked before
    // isDualViewMatch (not just left to the fuse-eligibility gate below,
    // which already grants allNouns spans a fuse pass) because isDualViewMatch
    // would otherwise claim any allNouns span first — both 王 and 都 are
    // individually genuine content words, exactly what isDualViewMatch looks
    // for — and bury the compound's own definition under 王's on its own.
    const allNouns = tokens.slice(c.start, c.end + 1).every((t) => t.pos === "名詞");
    if (!allNouns && isDualViewMatch(tokens, c)) {
      scored.push({ ...c, outcome: "dualView" });
      continue;
    }
    const isLong = c.lookupText.length >= 5;
    const hasFunctionPos = m.posCodes?.some((p) => FUNCTION_POS_CODES.has(p));
    // A suspicious fragment (ぼっ/ち) is itself strong evidence of a real
    // segmentation bug rather than a coincidental collision — bare ぼっち
    // (no ひとり prefix) is only 2 raw tokens / 3 characters, too short for
    // the other gates, but still a genuine word (n, "aloneness") worth fixing.
    if (isLong || allNouns || hasFunctionPos || hasSuspiciousFragment(tokens, c)) {
      scored.push({ ...c, outcome: "fuse" });
    }
  }

  const chosen = selectNonOverlappingSpans(tokens, scored, () => true);
  const fuseSpans = chosen.filter((c) => c.outcome === "fuse");
  const dualViewSpans = chosen.filter((c) => c.outcome === "dualView");

  return { fuseSpans, dualViewSpans };
}

// Runs groupTokens with fuseSpans already decided (see groupTokens' doc
// comment for why fuse spans must be applied *during* grouping, not after),
// then attaches each dual-view span's phrase info to whichever final group
// covers that span's starting token — even if Rule 3 already absorbed that
// token into a larger group.
function applyPhraseMatches(tokens, fuseSpans, dualViewSpans) {
  const groups = groupTokens(tokens, fuseSpans);
  for (const span of dualViewSpans) {
    const owner = groups.find((g) => g.tokenStart <= span.start && span.start <= g.tokenEnd);
    if (owner && !owner.idiomWord) owner.idiomWord = span.lookupText;
  }
  return groups;
}

// Catches standalone katakana names groupTokens' 固有名詞-based rule misses.
// kuromoji's UNK handler is inconsistent about tagging unrecognized katakana
// as 固有名詞 vs. plain 名詞/一般 — confirmed empirically: レン/ハイター got
// 固有名詞, but ヒンメル/アイゼン (equally fictional, equally absent from
// JMdict) got tagged as ordinary nouns. Existence is the reliable signal
// instead: a standalone katakana word with no real JMdict entry is a name (or
// otherwise not worth a definition popup), while real loanwords (ｷﾞﾀｰ, ﾊﾞﾝﾄﾞ)
// always resolve. Deliberately scoped to single, standalone katakana groups
// only — multi-word katakana runs already went through groupTokens' merge
// rule if any part was recognized as a name, and re-checking a real 2-word
// loanword sequence (ｷﾞﾀｰﾋｰﾛｰ) here would risk wrongly suppressing it just for
// lacking its own combined dictionary entry.
function findKatakanaNameCandidates(groups) {
  const candidates = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.word === null || g.isParticle || g.isProperNoun) continue;
    if (KATAKANA_ONLY_RE.test(g.surface)) candidates.push(i);
  }
  return candidates;
}

// Given candidate group indices and a membership map ({surface: {exists}}
// from background.js's JMdict index), replaces any group with no JMdict entry
// with an inert (non-clickable, no popup) plain-text group.
function applyKatakanaNameSuppression(groups, candidates, membership) {
  return groups.map((g, i) => {
    if (!candidates.includes(i)) return g;
    if (membership[g.surface]?.exists) return g;
    return { surface: g.surface, word: null };
  });
}

// typeof process is the reliable Node.js signal — module can be defined in
// some browser/extension contexts and would cause unexpected assignment there.
if (typeof process !== "undefined") {
  module.exports = {
    groupTokens,
    JAPANESE_WORD_RE,
    findKanaMergeCandidates,
    applyKanaMerges,
    findPhraseMatchCandidates,
    classifyAndSelectPhraseMatches,
    applyPhraseMatches,
    findKatakanaNameCandidates,
    applyKatakanaNameSuppression,
    FUNCTION_POS_CODES,
  };
}
