// Loads the REAL background.js into a vm sandbox with a caller-supplied fetch,
// the same technique test-entry-resolution.js / audit-resolution.js use, so
// harness tools exercise the code that ships rather than a copy of it.
//
// Returns the requested globals plus a `logs` array that the resolver's
// console output is collected into (cleared by the caller per call).

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const DEFAULT_BACKGROUND = path.join(__dirname, "..", "..", "background.js");

function loadBackground({ fetch, backgroundPath = DEFAULT_BACKGROUND, exportNames = [], storage = {} }) {
  const logs = [];
  const store = { ...storage };
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.join(" ")),
      warn: (...a) => logs.push("WARN " + a.join(" ")),
      error: (...a) => logs.push("ERROR " + a.join(" ")),
    },
    fetch,
    importScripts: () => {},
    chrome: {
      runtime: { onMessage: { addListener: () => {} }, getURL: (s) => s },
      storage: {
        local: {
          get: async (keys) => {
            if (keys == null) return { ...store };
            const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
            return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
          },
          set: async (obj) => Object.assign(store, obj),
        },
      },
    },
    setTimeout,
    clearTimeout,
    URL,
  };
  // subtitle-parser.js and tokenize-utils.js are importScripts()'d by the real
  // worker; load them into the same context first so fetchAndParseFile etc.
  // resolve.
  vm.createContext(sandbox);
  for (const dep of ["subtitle-parser.js", "tokenize-utils.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", dep), "utf8").replace(/if \(typeof process !== "undefined"\) \{[\s\S]*?\n\}\s*$/, "");
    vm.runInContext(src, sandbox, { filename: dep });
  }
  const names = ["resolveTextFiles", "fetchSubtitles", "looseTitle", "ARCHIVE_RE", ...exportNames];
  const exportSrc = `;this.__x = {${[...new Set(names)].map((n) => `${n}: typeof ${n} !== "undefined" ? ${n} : undefined`).join(", ")}};`;
  vm.runInContext(fs.readFileSync(backgroundPath, "utf8") + exportSrc, sandbox, { filename: backgroundPath });
  return { ...sandbox.__x, logs, storage: store };
}

module.exports = { loadBackground, DEFAULT_BACKGROUND };
