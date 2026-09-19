// Records every Jimaku response a scenario's REAL code path requests into a
// replayable fixture (2026-09-18), so pinned tests run on verbatim live data
// instead of hand-written listings. Subtitle downloads are recorded as "".
//
// Usage: node scripts/audit/record-scenario.js <out.json> '<js body using bg>'
//   where the body is an async function body with `bg` (loaded background.js).

"use strict";
const fs = require("fs");
const { createJimakuClient } = require("./jimaku-client.js");
const { loadBackground } = require("./load-background.js");

const [out, body] = process.argv.slice(2);
const client = createJimakuClient({ log: console.log });
const recorded = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
const fetch = async (url, init) => {
  const u = String(url);
  if (/\/download\//.test(u) || !/\/api\//.test(u)) {
    recorded[u] = "";
    return { ok: true, status: 200, text: async () => "", json: async () => ({}) };
  }
  const r = await client.fetch(u, init);
  const text = await r.text();
  if (r.ok) recorded[u] = JSON.parse(text);
  return { ok: r.ok, status: r.status, text: async () => text, json: async () => JSON.parse(text) };
};
const bg = loadBackground({ fetch, exportNames: ["fetchEntryFiles"], storage: { jimakuApiKey: process.env.JIMAKU_API_KEY } });
(async () => {
  await new Function("bg", `return (async () => { ${body} })()`)(bg);
  fs.writeFileSync(out, JSON.stringify(recorded, null, 1));
  console.log(`recorded ${Object.keys(recorded).length} responses -> ${out}`);
})();
