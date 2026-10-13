// Fills the IVT-QAG-FRM-36 test case template by editing the .xlsx XML directly,
// so charts, images, summary sheets, formulas and dropdowns are all preserved.
//
// One workbook per run:
//   - one module sheet per module/portal ("1.0" Admin, "1.1" Resident, "2.0", ...) - no fixed limit
//   - the template's Login test case (rows 12-13) is kept on every sheet
//   - Summary sheets get one row per module sheet (rows are inserted when there are more than 5)
//   - an "Automation Test Scripts" sheet is added
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

// Layout of the module sheets. Edit here if your template changes.
const LAYOUT = {
  cloneFrom: '1.0',                 // module sheet used as the pattern for extra sheets
  slotPattern: /^\d+\.\d+$/,        // names of module sheets in the template (1.0 ... 5.0)
  loginRows: [12, 13],              // the standard Login test case - never removed
  firstGenRow: 14,                  // generated test cases start here
  titleCell: 'B1',
  cols: { id: 'A', scenario: 'B', testCase: 'C', steps: 'D', expected: 'K' },
  widths: { testCase: 29.33, steps: 37, expected: 33.89 },
  statusCols: ['M', 'O', 'Q', 'S', 'U', 'W'],
  statusValue: 'NOT EXECUTED',
  automationSheet: 'Automation Test Scripts'
};

const colNum = L => L.split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = s => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const clean = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/\r\n?/g, '\n').trim();
const base = p => path.posix.basename(p);

function cellXml(ref, style, text) {
  const s = style !== undefined ? ` s="${style}"` : '';
  const t = clean(text);
  if (!t) return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(t)}</t></is></c>`;
}
function formulaCellXml(ref, style, f) {
  const s = style !== undefined ? ` s="${style}"` : '';
  return `<c r="${ref}"${s}><f>${esc(f)}</f></c>`;
}
const CELL_RE = ref => new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
const styleOf = attrs => (attrs.match(/\bs="(\d+)"/) || [])[1];
function setCell(xml, ref, text) { return xml.replace(CELL_RE(ref), (_, a) => cellXml(ref, styleOf(a), text)); }
function setFormula(xml, ref, f) { return xml.replace(CELL_RE(ref), (_, a) => (f == null ? cellXml(ref, styleOf(a), '') : formulaCellXml(ref, styleOf(a), f))); }

function estLines(text, width) {
  return clean(text).split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.length / (width * 1.15))), 0);
}
// Numbered list that ALWAYS starts at 1 (strips any numbers the AI wrote, then renumbers).
function numbered(text) {
  const lines = clean(text).split('\n').map(l => l.trim()).filter(Boolean);
  const anyNum = lines.some(l => /^\d+[.)]\s+/.test(l));
  const items = [];
  for (const l of lines) {
    if (!anyNum || !items.length || /^\d+[.)]\s+/.test(l)) items.push(l.replace(/^\d+[.)]\s+/, ''));
    else items[items.length - 1] += '\n' + l;
  }
  return items.length ? items.map((t, i) => `${i + 1}. ${t}`) : [''];
}
// Blank every value in a row but keep its styles (used for leftover template rows).
const blankRow = row => row.replace(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g, (m, ref, attrs) => {
  const st = styleOf(attrs);
  return `<c r="${ref}"${st !== undefined ? ` s="${st}"` : ''}/>`;
});

function rowStyles(xml, rowNum) {
  const m = xml.match(new RegExp(`<row r="${rowNum}"[^>]*>([\\s\\S]*?)</row>`));
  const styles = {};
  if (m) for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)\/?>/g)) { const s = styleOf(c[2]); if (s !== undefined) styles[c[1]] = s; }
  return styles;
}
// Remove stale cached results from formula cells so Excel/LibreOffice recalculate them.
const stripCached = xml => xml.replace(/(<f\b[^>]*>[^<]*<\/f>|<f\b[^>]*\/>)<v>[^<]*<\/v>/g, '$1');

// ---------------------------------------------------------------------------------------------
// Module sheet
// ---------------------------------------------------------------------------------------------
// Pure function: module sheet XML in -> filled module sheet XML out.
function fillSheetXml(xml, { testCases = [], code = 'MOD', title = '', login }) {
  const { cols } = LAYOUT;
  const [loginA, loginB] = LAYOUT.loginRows;
  const firstGen = LAYOUT.firstGenRow;
  const styleFirst = rowStyles(xml, loginA);
  const styleNext = { ...styleFirst, ...rowStyles(xml, loginB) };
  if (!Object.keys(styleFirst).length) throw new Error(`The module sheet has no Login row at row ${loginA}, so the layout can't be copied.`);
  const letters = Object.keys(styleFirst).sort((a, b) => colNum(a) - colNum(b));

  // The standard Login test case is ALWAYS rewritten in rows 12-13, whatever the template sheet contained.
  const loginValues = {
    [`${cols.id}${loginA}`]: `TC_${code}_001`, [`${cols.id}${loginB}`]: `TC_${code}_002`,
    [`${cols.scenario}${loginA}`]: login.title, [`${cols.testCase}${loginA}`]: login.description,
    [`${cols.steps}${loginA}`]: login.steps,
    [`${cols.expected}${loginA}`]: '1. System to display the expected login page.',
    [`${cols.expected}${loginB}`]: '2. User will be able to sign-in based on user credentials and account.'
  };
  for (const r of LAYOUT.loginRows) {
    for (const L of letters) {
      const ref = `${L}${r}`;
      const v = ref in loginValues ? loginValues[ref] : LAYOUT.statusCols.includes(L) ? LAYOUT.statusValue : '';
      xml = setCell(xml, ref, v);
    }
  }

  const order = [];
  const groups = new Map();
  for (const tc of testCases) {
    const key = clean(tc.scenario) || 'General';
    if (!groups.has(key)) { groups.set(key, []); order.push(key); }
    groups.get(key).push(tc);
  }

  const rowsXml = [];
  const merges = [];
  const written = [];
  let r = firstGen;
  let seq = 2;

  for (const scenario of order) {
    const scenStart = r;
    for (const tc of groups.get(scenario)) {
      const caseStart = r;
      const expected = numbered(tc.expectedResult);
      const n = expected.length;
      const stepsText = [
        tc.preconditions ? `Pre-condition: ${clean(tc.preconditions)}` : '',
        numbered(tc.steps).join('\n'),
        tc.testData ? `Test data: ${clean(tc.testData)}` : ''
      ].filter(Boolean).join('\n');
      const mergedNeed = Math.max(estLines(stepsText, LAYOUT.widths.steps), estLines(tc.title, LAYOUT.widths.testCase));
      const firstId = `TC_${code}_${String(seq + 1).padStart(3, '0')}`;

      for (let i = 0; i < n; i++, r++) {
        const first = i === 0;
        const height = Math.min(409, Math.max(15, estLines(expected[i], LAYOUT.widths.expected) * 13, Math.ceil((mergedNeed * 13) / n)));
        const values = {
          [cols.id]: `TC_${code}_${String(++seq).padStart(3, '0')}`,
          [cols.scenario]: r === scenStart ? scenario : '',
          [cols.testCase]: first ? tc.title : '',
          [cols.steps]: first ? stepsText : '',
          [cols.expected]: expected[i]
        };
        LAYOUT.statusCols.forEach(c => { values[c] = LAYOUT.statusValue; });
        const cells = letters.map(L => {
          const continuation = (L === cols.scenario && r !== scenStart) || ((L === cols.testCase || L === cols.steps) && !first);
          return cellXml(`${L}${r}`, continuation ? styleNext[L] : styleFirst[L], values[L]);
        }).join('');
        rowsXml.push(`<row r="${r}" ht="${height}" customHeight="1">${cells}</row>`);
      }
      if (n > 1) merges.push(`${cols.testCase}${caseStart}:${cols.testCase}${r - 1}`, `${cols.steps}${caseStart}:${cols.steps}${r - 1}`);
      written.push({ tc, id: firstId });
    }
    if (r - 1 > scenStart) merges.push(`${cols.scenario}${scenStart}:${cols.scenario}${r - 1}`);
  }
  const lastRow = Math.max(r - 1, loginB);

  if (title) xml = setCell(xml, LAYOUT.titleCell, title);

  const sd = xml.match(/<sheetData[^>]*>/);
  const sdStart = sd.index + sd[0].length;
  const sdEnd = xml.indexOf('</sheetData>');
  const keepTop = [];
  const keepBottom = [];
  for (const m of xml.slice(sdStart, sdEnd).matchAll(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    const n = Number(m[1]);
    if (n < firstGen) keepTop.push(m[0]);
    else if (n > lastRow) keepBottom.push(blankRow(m[0]));
  }
  xml = xml.slice(0, sdStart) + keepTop.join('') + rowsXml.join('') + keepBottom.join('') + xml.slice(sdEnd);

  // Merged cells: keep the Login ones, add ours.
  const mc = xml.match(/<mergeCells[^>]*>([\s\S]*?)<\/mergeCells>/);
  const existing = mc ? [...mc[1].matchAll(/<mergeCell ref="([^"]+)"\s*\/>/g)].map(m => m[1]) : [];
  const loginMerges = [cols.scenario, cols.testCase, cols.steps].map(c => `${c}${loginA}:${c}${loginB}`);
  const all = [...existing.filter(ref => Number(ref.match(/\d+/)[0]) < loginA), ...loginMerges, ...merges];
  const mcXml = all.length ? `<mergeCells count="${all.length}">${all.map(ref => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>` : '';
  xml = mc ? xml.replace(mc[0], mcXml) : xml.replace('</sheetData>', `</sheetData>${mcXml}`);

  // Status dropdowns cover the new rows. The sample hyperlink on the Login steps is dropped.
  if (lastRow >= firstGen) {
    xml = xml.replace(/sqref="([^"]*)"/g, (_, v) =>
      `sqref="${v.replace(/([A-Z]+)12:([A-Z]+)13/g, (__, a, b) => `${a}12:${b}${lastRow}`)}"`);
  }
  xml = xml.replace(/<hyperlinks>[\s\S]*?<\/hyperlinks>/, '');
  return { xml: stripCached(xml), lastRow, written };
}

// ---------------------------------------------------------------------------------------------
// Summary sheets (dynamic rows)
// ---------------------------------------------------------------------------------------------
const fEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fUnesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Shift row numbers >= R by d in every reference that points at `target` sheet.
function shiftFormulaText(f, own, target, R, d) {
  const re = /(?<![A-Za-z0-9_.$'])((?:'[^']+'|[A-Za-z_][\w.]*)!)?(\$?[A-Z]{1,3}\$?)(\d+)(?::(\$?[A-Z]{1,3}\$?)(\d+))?(?![A-Za-z0-9_(])/g;
  return f.replace(re, (m, q, c1, r1, c2, r2) => {
    const sheet = q ? q.slice(0, -1).replace(/^'|'$/g, '') : own;
    if (sheet !== target) return m;
    const sh = r => (Number(r) >= R ? Number(r) + d : Number(r));
    return `${q || ''}${c1}${sh(r1)}${c2 ? `:${c2}${sh(r2)}` : ''}`;
  });
}
function shiftFormulasIn(xml, own, target, R, d) {
  return xml.replace(/<(f|c:f)(\s[^>]*)?>([^<]*)<\/\1>/g, (m, tag, attrs, body) =>
    `<${tag}${attrs || ''}>${fEsc(shiftFormulaText(fUnesc(body), own, target, R, d))}</${tag}>`);
}
function insertRowsInSheet(xml, R, d) {
  xml = xml.replace(/<row r="(\d+)"([^>]*?)(\/>|>[\s\S]*?<\/row>)/g, (m, n, attrs, rest) => {
    n = Number(n);
    if (n < R) return m;
    return `<row r="${n + d}"${attrs}${rest.replace(new RegExp(`<c r="([A-Z]+)${n}"`, 'g'), `<c r="$1${n + d}"`)}`;
  });
  const shiftRange = ref => ref.replace(/([A-Z]+)(\d+)/g, (m, c, r) => c + (Number(r) >= R ? Number(r) + d : Number(r)));
  xml = xml.replace(/<mergeCell ref="([^"]+)"/g, (m, ref) => `<mergeCell ref="${shiftRange(ref)}"`);
  xml = xml.replace(/sqref="([^"]+)"/g, (m, v) => `sqref="${shiftRange(v)}"`);
  return xml;
}
const shiftDrawing = (xml, R, d) => xml.replace(/<xdr:row>(\d+)<\/xdr:row>/g, (m, r) => (Number(r) + 1 >= R ? `<xdr:row>${Number(r) + d}</xdr:row>` : m));

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => [...m[1].matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map(t => unesc(t[1])).join(''));
}
function cellInfo(xml, ref, ss) {
  const m = xml.match(CELL_RE(ref));
  if (!m) return {};
  const inner = (m[0].match(/>([\s\S]*)<\/c>$/) || [])[1] || '';
  const f = (inner.match(/<f\b[^>]*>([^<]*)<\/f>/) || [])[1];
  let text = null;
  if (/\bt="s"/.test(m[1])) { const v = (inner.match(/<v>(\d+)<\/v>/) || [])[1]; if (v !== undefined) text = ss[Number(v)]; }
  else if (/\bt="inlineStr"/.test(m[1])) text = unesc((inner.match(/<t\b[^>]*>([^<]*)<\/t>/) || [])[1] || '');
  return { formula: f === undefined ? undefined : fUnesc(f), text };
}
function detectBlocks(xml, ss) {
  const blocks = [];
  let cur = null;
  for (const m of xml.matchAll(/<row r="(\d+)"/g)) {
    const r = Number(m[1]);
    const t = cellInfo(xml, `A${r}`, ss).text;
    if (t === 'Modules') cur = { H: r };
    else if (cur && t === 'Overall') { cur.O = r; blocks.push(cur); cur = null; }
  }
  for (const b of blocks) {
    b.oldCount = b.O - b.H - 1;
    const bf = cellInfo(xml, `B${b.H + 1}`, ss).formula || '';
    b.statCol = (bf.match(/!\$?([A-Z]+)\$?7\b/) || [])[1];
    const af = cellInfo(xml, `A${b.H + 1}`, ss).formula;
    b.nameKind = af === undefined ? 'text' : /!/.test(af) ? 'cross' : 'same';
  }
  return blocks;
}
function editRow(xml, r, fn) {
  return xml.replace(new RegExp(`<row r="${r}"[^>]*>[\\s\\S]*?</row>`), fn);
}

// One row per module sheet in every "Modules ... Overall" block of every Summary sheet.
async function updateSummaries({ zip, read, entries, sheetFile, specs }) {
  const sums = entries.filter(e => /^Summary - /.test(e.name));
  if (!sums.length) return;
  const N = specs.length;
  const ss = parseSharedStrings(await read('xl/sharedStrings.xml'));

  const S = {};
  for (const e of sums) {
    const p = sheetFile(e.rid);
    const xml = await read(p);
    const relsPath = `xl/worksheets/_rels/${base(p)}.rels`;
    let drawPath = null;
    let drawXml = '';
    if (zip.file(relsPath)) {
      const t = ((await read(relsPath)).match(/Target="([^"]*drawing[^"]*)"/) || [])[1];
      if (t) { drawPath = path.posix.normalize(path.posix.join('xl/worksheets', t)); drawXml = await read(drawPath); }
    }
    S[e.name] = { name: e.name, path: p, xml, drawPath, drawXml, blocks: detectBlocks(xml, ss) };
  }
  const charts = {};
  for (const n of Object.keys(zip.files).filter(n => /^xl\/charts\/chart\d+\.xml$/.test(n))) charts[n] = await read(n);

  // 1) make room: insert rows before each block's "Overall" row, bottom block first.
  for (const sh of Object.values(S)) {
    for (const b of [...sh.blocks].sort((a, c) => c.O - a.O)) {
      const d = Math.max(0, N - b.oldCount);
      if (!d) continue;
      sh.xml = insertRowsInSheet(sh.xml, b.O, d);
      for (const other of Object.values(S)) other.xml = shiftFormulasIn(other.xml, other.name, sh.name, b.O, d);
      for (const k of Object.keys(charts)) charts[k] = shiftFormulasIn(charts[k], null, sh.name, b.O, d);
      sh.drawXml = shiftDrawing(sh.drawXml, b.O, d);
    }
  }

  // 2) final positions
  for (const sh of Object.values(S)) {
    let before = 0;
    for (const b of sh.blocks) {
      b.d = Math.max(0, N - b.oldCount);
      b.first = b.H + 1 + before;
      b.count = b.oldCount + b.d;
      b.overall = b.first + b.count;
      b.tplRow = b.O - 1 + before;        // last original module row (style/format template)
      before += b.d;
    }
  }
  const nameSheet = Object.values(S).find(sh => sh.blocks[0] && sh.blocks[0].nameKind === 'text');

  // 3) write the rows
  for (const sh of Object.values(S)) {
    sh.blocks.forEach((b, j) => {
      if (b.d) {
        const tpl = sh.xml.match(new RegExp(`<row r="${b.tplRow}"[^>]*>[\\s\\S]*?</row>`))[0];
        const clones = [];
        for (let t = 1; t <= b.d; t++) {
          const rr = b.tplRow + t;
          clones.push(tpl.replace(`<row r="${b.tplRow}"`, `<row r="${rr}"`).replace(new RegExp(`<c r="([A-Z]+)${b.tplRow}"`, 'g'), `<c r="$1${rr}"`));
        }
        sh.xml = sh.xml.replace(new RegExp(`(<row r="${b.overall}")`), `${clones.join('')}$1`);
      }
      for (let i = 1; i <= b.count; i++) {
        const r = b.first + i - 1;
        const spec = specs[i - 1];
        sh.xml = editRow(sh.xml, r, row => {
          if (!spec) { for (const c of 'ABCDEFGH') row = setFormula(row, `${c}${r}`, null); return row; }
          if (b.nameKind === 'text') row = setCell(row, `A${r}`, spec.label);
          else if (b.nameKind === 'cross') row = setFormula(row, `A${r}`, `'${nameSheet.name}'!A${nameSheet.blocks[0].first + i - 1}`);
          else row = setFormula(row, `A${r}`, `A${sh.blocks[0].first + i - 1}`);
          const col = b.statCol || 'E';
          [['B', 7], ['C', 2], ['D', 3], ['E', 4], ['F', 5], ['G', 6]].forEach(([c, n]) => { row = setFormula(row, `${c}${r}`, `'${spec.name}'!${col}${n}`); });
          return setFormula(row, `H${r}`, `(C${r}+D${r})/B${r}`);
        });
      }
      const o = b.overall;
      sh.xml = editRow(sh.xml, o, row => {
        'BCDEFG'.split('').forEach(c => { row = setFormula(row, `${c}${o}`, `SUM(${c}${b.first}:${c}${o - 1})`); });
        return setFormula(row, `H${o}`, `(C${o}+D${o})/B${o}`);
      });
    });
    zip.file(sh.path, stripCached(sh.xml));
    if (sh.drawPath) zip.file(sh.drawPath, sh.drawXml);
  }
  for (const [k, v] of Object.entries(charts)) zip.file(k, v);
}

// ---------------------------------------------------------------------------------------------
// Automation Test Scripts sheet
// ---------------------------------------------------------------------------------------------
const AUTO_HEADERS = ['Module Number', 'Module Name', 'Portal', 'Test Case ID', 'Test Case Title', 'Step No.', 'Automation Command', 'Configuration Notes', 'Source Input'];
const AUTO_WIDTHS = [10, 24, 16, 20, 40, 8, 48, 44, 32];

function buildAutomationXml(rows, headStyle, bodyStyle) {
  const colsXml = AUTO_WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const L = i => String.fromCharCode(65 + i);
  const head = `<row r="1" ht="22" customHeight="1">${AUTO_HEADERS.map((h, i) => cellXml(`${L(i)}1`, headStyle, h)).join('')}</row>`;
  const body = rows.map((row, k) =>
    `<row r="${k + 2}">${row.map((v, i) => cellXml(`${L(i)}${k + 2}`, bodyStyle, v === undefined ? '' : String(v))).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${colsXml}</cols><sheetData>${head}${body}</sheetData></worksheet>`;
}

const SUPPORTED = ['click', 'text', 'dropdown', 'link', 'Login', 'sleep', 'calendar', 'checkbox', 'icon', 'upload'];
// Keep only commands in the supported syntax. Returns { ok: [], dropped: [] }.
function validateCommands(list) {
  const ok = [];
  const dropped = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = clean(raw);
    const m = s.match(/^(\w+):\s*(.+)$/);
    const cmd = m && SUPPORTED.find(c => c.toLowerCase() === m[1].toLowerCase());
    const needsComma = cmd && ['text', 'dropdown', 'Login', 'calendar', 'checkbox', 'upload'].includes(cmd);
    if (!cmd || (needsComma && !m[2].includes(','))) { if (s) dropped.push(s); continue; }
    if (cmd === 'checkbox' && !/,\s*(ON|OFF)\s*$/i.test(m[2])) { dropped.push(s); continue; }
    ok.push(`${cmd}: ${m[2].trim()}`);
  }
  return { ok, dropped };
}

function loginCommands(portal, urls) {
  const url = portal === 'Resident Portal' ? (urls.resident || '<RESIDENT_PORTAL_URL>') : (urls.admin || '<ADMIN_PORTAL_URL>');
  return [`link: ${url}`, 'Login: Username, <USERNAME>', 'Login: Password, <PASSWORD>', 'text: Account, <ACCOUNT>', 'click: Login'];
}
// Standard Login test case wording (from the template). URL comes from .env, otherwise a clear placeholder.
const loginFor = (portal, urls) => {
  const resident = portal === 'Resident Portal';
  const url = (resident ? urls.resident : urls.admin) || (resident ? '<RESIDENT_PORTAL_URL>' : '<TENANT_PORTAL_URL>');
  const name = resident ? 'Resident Portal' : 'Tenant Portal';
  return {
    title: `Login to ${name}`,
    description: `Navigate to ${name}`,
    steps: `1. Go to ${url}\n2. Fill in your username and password.\n3. Fill in the Account.\n4. Click Login.`
  };
};

// ---------------------------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------------------------
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// specs: [{ name:'1.0', moduleNumber, moduleName, portal, label, code, title, testCases, source }]
async function writeWorkbook({ templatePath, outPath, specs, urls = {}, automation = false }) {
  if (!specs.length) throw new Error('No test cases to write.');
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const read = async p => {
    const f = zip.file(p);
    if (!f) throw new Error(`Template is missing ${p}`);
    return f.async('string');
  };

  let wb = await read('xl/workbook.xml');
  let rels = await read('xl/_rels/workbook.xml.rels');
  let ct = await read('[Content_Types].xml');

  const entries = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = (m[0].match(/\bname="([^"]*)"/) || [])[1];
    const rid = (m[0].match(/\br:id="([^"]*)"/) || [])[1];
    const id = Number((m[0].match(/\bsheetId="(\d+)"/) || [])[1] || 0);
    if (name !== undefined && rid) entries.push({ name: unesc(name), rid, id, tag: m[0] });
  }
  const sheetFile = rid => {
    for (const m of rels.matchAll(/<Relationship\b[^>]*\/>/g)) {
      if (new RegExp(`\\bId="${rid}"`).test(m[0])) {
        const t = m[0].match(/\bTarget="([^"]*)"/)[1];
        return t.startsWith('/') ? t.slice(1) : 'xl/' + t;
      }
    }
    throw new Error(`Could not find the file for sheet ${rid}.`);
  };

  const slots = entries.filter(e => LAYOUT.slotPattern.test(e.name));
  const src = entries.find(e => e.name === LAYOUT.cloneFrom);
  if (!src) throw new Error(`The template needs a module sheet named "${LAYOUT.cloneFrom}".`);
  const srcPath = sheetFile(src.rid);
  const srcXml = await read(srcPath);
  const headStyle = rowStyles(srcXml, 11).A;
  const bodyStyle = rowStyles(srcXml, 12).D;

  // Drawing (logo) of the pattern sheet - read now, the sheet itself may be deleted below.
  const drawRid = (srcXml.match(/<drawing\s+r:id="([^"]+)"/) || [])[1];
  let drawXml = null;
  let drawRelsXml = null;
  const srcRelsPath = `xl/worksheets/_rels/${base(srcPath)}.rels`;
  if (drawRid && zip.file(srcRelsPath)) {
    for (const m of (await read(srcRelsPath)).matchAll(/<Relationship\b[^>]*\/>/g)) {
      if (new RegExp(`\\bId="${drawRid}"`).test(m[0])) {
        const dp = path.posix.normalize(path.posix.join('xl/worksheets', m[0].match(/\bTarget="([^"]*)"/)[1]));
        drawXml = await read(dp);
        const dr = `xl/drawings/_rels/${base(dp)}.rels`;
        drawRelsXml = zip.file(dr) ? await read(dr) : null;
      }
    }
  }

  const names = Object.keys(zip.files);
  const maxNum = re => Math.max(0, ...names.map(n => Number((n.match(re) || [])[1] || 0)));
  let nextSheetFile = maxNum(/^xl\/worksheets\/sheet(\d+)\.xml$/) + 1;
  let nextDrawing = maxNum(/^xl\/drawings\/drawing(\d+)\.xml$/) + 1;
  let nextSheetId = Math.max(0, ...entries.map(e => e.id)) + 1;
  let nextRid = Math.max(0, ...[...rels.matchAll(/\bId="rId(\d+)"/g)].map(m => Number(m[1]))) + 1;

  const addSheetParts = (sheetPath, xml, withDrawing, sheetName) => {
    ct = ct.replace('</Types>', `<Override ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml" PartName="/${sheetPath}"/></Types>`);
    if (withDrawing && drawXml) {
      const drawPath = `xl/drawings/drawing${nextDrawing++}.xml`;
      zip.file(drawPath, drawXml);
      if (drawRelsXml) zip.file(`xl/drawings/_rels/${base(drawPath)}.rels`, drawRelsXml);
      zip.file(`xl/worksheets/_rels/${base(sheetPath)}.rels`,
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL_NS}"><Relationship Id="${drawRid}" Type="${REL_TYPE}/drawing" Target="../drawings/${base(drawPath)}"/></Relationships>`);
      ct = ct.replace('</Types>', `<Override ContentType="application/vnd.openxmlformats-officedocument.drawing+xml" PartName="/${drawPath}"/></Types>`);
    } else if (withDrawing) {
      xml = xml.replace(/<drawing\b[^>]*\/>/, '');
    }
    zip.file(sheetPath, xml);
    const tag = `<sheet state="visible" name="${esc(sheetName)}" sheetId="${nextSheetId++}" r:id="rId${nextRid}"/>`;
    rels = rels.replace('</Relationships>', `<Relationship Id="rId${nextRid}" Type="${REL_TYPE}/worksheet" Target="worksheets/${base(sheetPath)}"/></Relationships>`);
    nextRid++;
    return tag;
  };

  const finalTags = [];
  const automationRows = [];
  const warnings = [];

  for (const spec of specs) {
    const portal = spec.portal;
    const filled = (xml) => fillSheetXml(xml, { testCases: spec.testCases, code: spec.code, title: spec.title, login: loginFor(portal, urls) });
    const existing = entries.find(e => e.name === spec.name && LAYOUT.slotPattern.test(e.name));
    let res;
    if (existing) {
      const p = sheetFile(existing.rid);
      res = filled(await read(p));
      zip.file(p, res.xml);
      finalTags.push(existing.tag);
      existing.used = true;
    } else {
      res = filled(srcXml);
      const sheetPath = `xl/worksheets/sheet${nextSheetFile++}.xml`;
      finalTags.push(addSheetParts(sheetPath, res.xml, true, spec.name));
    }

    // Automation rows: login workflow + the case's own commands, grouped per test case.
    const addCase = (id, title, own, notes, source) => {
      const login = loginCommands(portal, urls);
      const { ok, dropped } = validateCommands(own);
      if (dropped.length) warnings.push(`${spec.name} ${id}: dropped unsupported commands: ${dropped.join(' | ')}`);
      const cmds = [...login, ...ok];
      cmds.forEach((c, i) => {
        const placeholders = [...new Set(c.match(/<[A-Z_]+>/g) || [])];
        const note = [placeholders.length ? `Configure: ${placeholders.join(', ')}` : '', i === login.length && notes ? notes : '',
          i === login.length && dropped.length ? 'Some steps could not be mapped to a supported command.' : ''].filter(Boolean).join(' ');
        automationRows.push([spec.moduleNumber, spec.moduleName, portal, id, title, i + 1, c, note, source]);
      });
    };
    if (automation) {
      addCase(`TC_${spec.code}_001`, 'Navigate to Tenant Portal (Login)', [], '', 'Template Login test case');
      for (const w of res.written) addCase(w.id, w.tc.title, w.tc.automation, w.tc.automationNotes, w.tc.source || spec.source || '');
    }
  }

  // Template module sheets nobody used are removed (the Summary only lists the sheets below).
  for (const slot of slots) {
    if (slot.used) continue;
    const p = sheetFile(slot.rid);
    const relsPath = `xl/worksheets/_rels/${base(p)}.rels`;
    if (zip.file(relsPath)) {
      for (const m of (await read(relsPath)).matchAll(/Target="\.\.\/drawings\/([^"]+)"/g)) {
        zip.remove(`xl/drawings/${m[1]}`);
        zip.remove(`xl/drawings/_rels/${m[1]}.rels`);
        ct = ct.replace(new RegExp(`<Override[^>]*PartName="/xl/drawings/${m[1]}"[^>]*/>`), '');
      }
      zip.remove(relsPath);
    }
    zip.remove(p);
    ct = ct.replace(new RegExp(`<Override[^>]*PartName="/${p}"[^>]*/>`), '');
    rels = rels.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${slot.rid}"[^>]*/>`), '');
  }

  // Automation Test Scripts sheet (optional: AUTOMATION_SHEET=on)
  if (automation) {
    const sheetPath = `xl/worksheets/sheet${nextSheetFile++}.xml`;
    finalTags.push(addSheetParts(sheetPath, buildAutomationXml(automationRows, headStyle, bodyStyle), false, LAYOUT.automationSheet));
  }

  // Put the module sheets (and the automation sheet) in order where the template's module sheets were.
  const firstSlot = slots[0];
  const at = wb.indexOf(firstSlot.tag);
  for (const s of slots) wb = wb.replace(s.tag, '');
  wb = wb.slice(0, at) + finalTags.join('') + wb.slice(at);

  // Re-read entries for the summary update (sheet list changed).
  const entries2 = [...entries.filter(e => !LAYOUT.slotPattern.test(e.name))];
  await updateSummaries({ zip, read, entries: entries2, sheetFile, specs });

  if (/<calcPr\b[^>]*\/>/.test(wb)) wb = wb.replace(/<calcPr\b[^>]*\/>/, '<calcPr fullCalcOnLoad="1"/>');
  zip.file('xl/workbook.xml', wb);
  zip.file('xl/_rels/workbook.xml.rels', rels);
  zip.file('[Content_Types].xml', ct);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return { sheets: specs.map(s => s.name), automationRows: automationRows.length, warnings };
}

module.exports = { writeWorkbook, validateCommands };
