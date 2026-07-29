const MIN_CHAPTERS = 3;
const MIN_CHAPTER_LENGTH = 10;
const MAX_TITLE_LENGTH = 120;
const TIMESTAMP = String.raw`\d{1,3}:[0-5]\d(?::[0-5]\d)?`;
const LEADING_TIMESTAMP = new RegExp(String.raw`^[([\-–—•*·]*\s*(${TIMESTAMP})\s*[)\]]*\s*(.*)$`);
const TRAILING_TIMESTAMP = new RegExp(String.raw`^(.*?)\s*[([\-–—•*·|]*\s*(${TIMESTAMP})\s*[)\]]*$`);

// Invidious does not expose YouTube chapters, so they are recovered from the description
// timestamps, which is the same source YouTube builds its own chapter list from.
export function parseChapters(video) {
  const duration = Number(video?.lengthSeconds || 0);
  const chapters = [];

  for (const line of descriptionText(video).split("\n")) {
    const mark = parseChapterLine(line);
    if (!mark || !mark.title) continue;
    if (duration > 0 && mark.start >= duration) continue;

    const previous = chapters[chapters.length - 1];
    if (previous && mark.start < previous.start + MIN_CHAPTER_LENGTH) continue;

    chapters.push(mark);
  }

  if (chapters.length < MIN_CHAPTERS || chapters[0].start !== 0) return [];
  return chapters;
}

function parseChapterLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const leading = trimmed.match(LEADING_TIMESTAMP);
  if (leading) return chapterMark(leading[1], leading[2]);

  const trailing = trimmed.match(TRAILING_TIMESTAMP);
  if (trailing) return chapterMark(trailing[2], trailing[1]);

  return null;
}

function chapterMark(timestamp, title) {
  const start = timestampToSeconds(timestamp);
  return start === null ? null : { start, title: cleanTitle(title) };
}

function timestampToSeconds(timestamp) {
  const parts = String(timestamp).split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function cleanTitle(title) {
  return String(title || "")
    .replace(/^[\s\-–—:|»·•>]+/, "")
    .replace(/[\s\-–—:|«·•<]+$/, "")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}

function descriptionText(video) {
  const description = video?.description;
  if (typeof description === "string" && description.trim()) return description;
  return htmlToText(video?.descriptionHtml);
}

function htmlToText(html) {
  if (!html) return "";
  const document = new DOMParser().parseFromString(String(html).replace(/<br\s*\/?>/gi, "\n"), "text/html");
  return document.body.textContent || "";
}
