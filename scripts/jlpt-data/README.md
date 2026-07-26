# JLPT vocabulary source data

`n1.csv`–`n5.csv` are the `original_data/` files from
[stephenmk/yomitan-jlpt-vocab](https://github.com/stephenmk/yomitan-jlpt-vocab)
(commit as of 2026-07-22), which itself packages Jonathan Waller's JLPT
Resources vocabulary lists — the same underlying list Jisho.org uses for its
own JLPT tags. Each row is `jmdict_seq,kana,kanji,waller_definition`; the
`jmdict_seq` is the exact JMdict entry ID, matching `jmdict-compact.json`'s
own `id` field (added 2026-07-19 for this purpose) — a direct ID join, no
fuzzy kanji/reading matching needed.

**License: CC BY-SA 4.0** (see `LICENSE.txt`, copied from upstream). Using
this data requires attribution (Jonathan Waller's original list, packaged by
Stephen Kraus) and, if the derived JLPT-tag data is redistributed, that
redistribution stays under compatible share-alike terms. **Not yet surfaced
anywhere user-facing** — needs a credits/attribution line somewhere in the
extension (e.g. an options/about page) before public launch. Tracked as an
open item for Phase 7 packaging in `project-plan.md`.

**Accuracy caveat, from upstream's own README:** no official JLPT vocabulary
list has existed since 2010 — this is a community-compiled "educated guess,"
not authoritative. Matches this project's existing rule that JLPT level is
opt-in/off-by-default only, never shown as an authoritative label.
