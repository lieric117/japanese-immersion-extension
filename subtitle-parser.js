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

    cues.push({ start, end, text });
  }
  return cues;
}

function assTimeToSeconds(timeStr) {
  const [h, m, s] = timeStr.split(":");
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

if (typeof process !== "undefined") {
  module.exports = { parseSrt, parseAss };
}
