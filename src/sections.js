// Splits a BRD into its heading sections.
// A BRD that describes several modules is sent to the AI module by module (see src/generator.js):
// the plan step gets the heading outline, then every module gets only the text of its own section.
//
// The text comes from src/parsers.js: .docx/.md keep their headings as markdown ("# Title"),
// a PDF is plain text and normally keeps the numbering ("3.1 Overview").

const MAX_HEADING_LEN = 240;      // longer lines are body text, not headings
const MAX_NUMBERED_LEN = 100;

const clean = s => String(s == null ? '' : s).replace(/\r\n?/g, '\n');
// comparable form of a title: lower case, single spaces, no trailing punctuation
const key = s => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').replace(/[\s.:\-–—]+$/, '').trim();

// "1. Introduction" / "1.1 Overview" / "1.0 Overview" -> { path: [1] | [1,1], title: 'Introduction', number: '1' }
function splitNumber(title) {
  const m = /^\s*(\d+(?:\.\d+)*)\s*\.?\s*[.)]?\s+(\S.*)$/.exec(String(title || ''));
  if (!m) return null;
  const parts = m[1].split('.').map(Number);
  if (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();   // "1.0" is the same level as "1"
  return { path: parts, title: m[2].trim(), number: m[1] };
}

// the title without its number ("3. Equipment" -> "Equipment")
const bare = s => { const n = splitNumber(s); return key(n ? n.title : s); };

const isPrefix = (a, b) => a.length < b.length && a.every((n, i) => b[i] === n);
const samePath = (a, b) => a.length === b.length && a.every((n, i) => b[i] === n);

// Does the number path P continue the outline of the previous heading (path C)?
// Only real outline numbering passes: the next sibling, a sub-section or the next chapter.
function continues(c, p) {
  if (!c) return p[0] === 1;                                                   // an outline starts at 1
  if (samePath(c, p)) return false;                                           // the same number twice
  if (p.length === c.length && p[0] === c[0]) return p[p.length - 1] === c[c.length - 1] + 1;   // next sibling
  if (p.length === c.length + 1) return isPrefix(c, p);                       // sub-section
  if (p.length === 1) return p[0] === c[0] + 1;                               // next chapter
  if (p.length === c.length && p[0] === c[0] + 1) return p.slice(1).every((n, i) => n === c[i + 1]);
  return false;
}

// markdown heading "## Title"
function atxHeading(line) {
  const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  return m ? { mdLevel: m[1].length, title: m[2].trim() } : null;
}

// setext heading: a title followed by "=====" or "-----"
function setextHeading(line, next) {
  const u = /^\s{0,3}(=+|-{3,})\s*$/.exec(next || '');
  if (!u || !line.trim()) return null;
  if (/^\s*([-*+]|\d+[.)])\s/.test(line)) return null;      // a list item, not a heading
  if (/^\s*\|/.test(line)) return null;                      // a table row
  return { mdLevel: u[1][0] === '=' ? 1 : 2, title: line.trim() };
}

// numbered heading of a plain text document: "3.1 Overview"
function numberedHeading(line) {
  const n = splitNumber(line);
  if (!n || !n.title) return null;
  if (n.title.length > MAX_NUMBERED_LEN) return null;              // a sentence
  if (/[.,;]$/.test(n.title)) return null;                         // a sentence
  if (/\.{3,}\s*\d+\s*$/.test(n.title)) return null;                // a table of contents line
  if (/\t\d+\s*$/.test(n.title)) return null;                       // a table of contents line
  return n;
}

// last resort for plain text without numbering: ALL CAPS titles on a line of their own
function capsHeadings(lines) {
  const heads = [];
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.length > 100) return;
    if (!/^[A-Z0-9][A-Z0-9 &/()'.,-]*$/.test(t)) return;            // no lower case letters
    if (t.replace(/[^A-Za-z]/g, '').length < 6) return;               // too short to be a title ("OK", "NOTE")
    if (i > 0 && lines[i - 1].trim()) return;                       // must start a block
    heads.push({ title: t, mdLevel: 1, num: null, line: i });
  });
  return heads.length >= 2 ? heads : [];
}

// every heading of the document, in document order
function collectHeadings(lines) {
  const heads = [];
  lines.forEach((line, i) => {
    const h = atxHeading(line) || setextHeading(line, lines[i + 1]);
    if (h && h.title) heads.push({ title: h.title, mdLevel: h.mdLevel, num: splitNumber(h.title), line: i });
  });
  if (heads.length) return heads;

  let cur = null;                                                   // plain text (a PDF): the numbering is the structure
  lines.forEach((line, i) => {
    const n = numberedHeading(line);
    if (!n) return;
    if (!continues(cur, n.path)) return;
    cur = n.path;
    heads.push({ title: line.trim(), mdLevel: 0, num: { path: n.path, title: n.title }, line: i });
  });
  return heads.length ? heads : capsHeadings(lines);
}

// The level of every heading. The markdown level is used, unless the headings are numbered
// consistently - then the numbering carries the hierarchy (Word documents often use one style
// for every heading, so the levels alone would not show which section belongs to which).
function assignLevels(heads) {
  const numbered = heads.filter(h => h.num);
  let cur = null;
  let coherent = numbered.length >= 2;
  for (const h of numbered) {
    if (!continues(cur, h.num.path)) { coherent = false; break; }
    cur = h.num.path;
  }
  const byNumber = coherent && new Set(numbered.map(h => h.num.path.length)).size > 1;

  let depth = 0;
  for (const h of heads) {
    if (h.num && byNumber) { h.level = h.num.path.length; depth = h.level; }
    else if (h.num) { h.level = h.mdLevel || depth || 1; depth = h.level; }
    else { h.level = Math.max(h.mdLevel || 1, byNumber ? depth + 1 : 1); }
  }
  return heads;
}

// The document split into its sections: every heading with the text range it owns.
// A section runs until the next heading of the same or a higher level, so its sub-sections stay inside it.
function parseSections(text) {
  const src = clean(text);
  const lines = src.split('\n');
  const offsets = [];
  let pos = 0;
  for (const line of lines) { offsets.push(pos); pos += line.length + 1; }

  const heads = assignLevels(collectHeadings(lines));
  for (const h of heads) h.start = offsets[h.line];
  for (let i = 0; i < heads.length; i++) {
    let end = src.length;
    for (let j = i + 1; j < heads.length; j++) {
      if (heads[j].level <= heads[i].level) { end = heads[j].start; break; }
    }
    heads[i].end = end;
  }
  return { src, heads };
}

// The headings of a BRD as an indented list. The AI uses it to name the sections of each module.
function outline(text) {
  const { heads } = parseSections(text);
  if (!heads.length) return '';
  const base = Math.min(...heads.map(h => h.level));
  return heads.map(h => `${'  '.repeat(Math.max(0, h.level - base))}${h.title}`).join('\n');
}

// The sections with the given headings, with everything nested inside them, in document order.
function sectionText(text, headings) {
  const wanted = (Array.isArray(headings) ? headings : [headings])
    .map(h => String(h == null ? '' : h).trim()).filter(Boolean);
  if (!wanted.length) return '';

  const { src, heads } = parseSections(text);
  if (!heads.length) return '';

  const picked = [];
  for (const want of wanted) for (const h of matchHeadings(heads, want)) picked.push(h);
  if (!picked.length) return '';

  picked.sort((a, b) => a.start - b.start);
  const kept = [];
  for (const h of picked) {
    if (kept.some(k => h.start >= k.start && h.start < k.end)) continue;      // already inside a section that was kept
    kept.push(h);
  }
  return kept.map(h => src.slice(h.start, h.end).trim()).filter(Boolean).join('\n\n');
}

// The headings that belong to the wanted title: the exact title first, then the same title
// without its number, and only if that is still unique a title that contains it (or is contained in it).
function matchHeadings(heads, want) {
  const w = key(want);
  if (!w) return [];
  const exact = heads.filter(h => key(h.title) === w);
  if (exact.length) return exact;
  const wb = bare(want);
  const withoutNumber = heads.filter(h => bare(h.title) === wb);
  if (withoutNumber.length) return withoutNumber;
  const contains = heads.filter(h => {
    const b = bare(h.title);
    return b.length >= 4 && (b.includes(wb) || wb.includes(b));
  });
  return contains.length === 1 ? contains : [];
}

module.exports = { outline, sectionText, parseSections };
