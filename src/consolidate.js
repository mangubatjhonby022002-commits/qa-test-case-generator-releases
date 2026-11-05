// Merges the AI results of ALL inputs of a run into modules -> portal sheets.
// Same module (from several BRDs / pasted issues) = one sheet; duplicates are removed.
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const moduleKey = n => norm(n).replace(/\b(module|portal)\b/g, '').replace(/\s+/g, '');
const tokens = s => new Set(norm(s).split(' ').filter(w => w.length > 2));

// Make a safe Excel sheet name: strip extension, strip illegal chars, trim, max 25 chars
// (leaving 7 chars for the "(Admin)" or "(Portal)" suffix → total ≤ 32, but Excel limit is 31
// so we cap at 24 to be safe with the longest suffix "(Portal)" = 8 chars → 32 total... use 23).
function safeSheetName(name) {
  return String(name || 'BRD')
    .replace(/\.[^.]+$/, '')           // strip file extension (e.g. .pdf, .docx)
    .replace(/[[\]*\/\\?:]/g, '_')     // replace Excel-illegal chars
    .replace(/^'+|'+$/g, '')          // strip leading/trailing single quotes
    .trim()
    .slice(0, 23);                     // leave room for "(Portal)" suffix (8 chars) → max 31
}

function similar(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return norm(a) === norm(b);
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / (A.size + B.size - hit) >= 0.85;
}

const STOP = new Set(['system', 'specification', 'specifications', 'document', 'doc', 'brd', 'business', 'requirement', 'requirements', 'functional', 'spec']);
function cleanModuleName(name) {
  const parts = String(name).replace(/\.[a-z0-9]+$/i, '').split(/\s+[-–—]\s+/);
  return (parts[parts.length - 1] || name).trim();
}
function codeFrom(name) {
  const words = String(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const keep = words.filter(w => !STOP.has(w.toLowerCase()));
  return (keep.length ? keep : words).join('').toUpperCase().slice(0, 12) || 'MOD';
}

// items: [{ id, name, analysis:{ modules:[{ moduleName, assumptions, clarifications, testCases[] }] } }] in processing order
// One input can hold several modules (a BRD is split by the generator), and the same module can
// appear in several inputs - they end up on the same sheet.
function consolidate(items) {
  const modules = new Map();
  let removed = 0;

  for (const item of items) {
    const analysis = item.analysis || {};
    const list = (Array.isArray(analysis.modules) && analysis.modules.length)
      ? analysis.modules
      : [{ moduleName: analysis.moduleName || item.name, assumptions: analysis.assumptions || [], clarifications: analysis.clarifications || [], testCases: analysis.testCases || [] }];

    for (const mod of list) {
      const name = cleanModuleName(mod.moduleName);
      const key = moduleKey(name) || `m${item.id}-${mod.moduleName}`;
      if (!modules.has(key)) modules.set(key, {
        name,
        summary: mod.summary || '',
        description: mod.description || '',
        portals: { 'Admin Portal': [], 'Resident Portal': [] },
        notes: []
      });
      const bucket = modules.get(key);
      if (!bucket.summary && mod.summary) bucket.summary = mod.summary;
      if (!bucket.description && mod.description) bucket.description = mod.description;
      for (const tc of mod.testCases || []) {
        const cases = bucket.portals[tc.portal];
        if (!cases) continue;                                   // unknown portal
        if (cases.some(x => x.source !== item.name && similar(x.title, tc.title))) { removed++; continue; }
        cases.push({ ...tc, source: item.name, _item: item.id });
      }
      if ((mod.assumptions || []).length || (mod.clarifications || []).length) {
        bucket.notes.push({ source: item.name, assumptions: mod.assumptions || [], clarifications: mod.clarifications || [] });
      }
    }
  }

  const specs = [];
  const itemSheets = new Map();
  const usedSheetNames = new Set();
  let k = 0;
  for (const mod of modules.values()) {
    const hasAdmin = mod.portals['Admin Portal'].length > 0;
    const hasRes = mod.portals['Resident Portal'].length > 0;
    if (!hasAdmin && !hasRes) continue;
    k++;
    for (const portal of ['Admin Portal', 'Resident Portal']) {
      const testCases = mod.portals[portal];
      if (!testCases.length) continue;
      const resident = portal === 'Resident Portal';
      // Dynamic sheet name: derive from the source input name(s) if all test cases share one source,
      // otherwise fall back to the module name. Format: "<baseName>(Admin)" or "<baseName>(Portal)".
      const sources = [...new Set(testCases.map(t => t.source))];
      const baseName = sources.length === 1 ? sources[0] : mod.name;
      const sheetBase = safeSheetName(baseName);
      const sheetSuffix = resident ? '(Portal)' : '(Admin)';
      let sheetName = `${sheetBase}${sheetSuffix}`;
      if (usedSheetNames.has(sheetName)) {
        const modPart = safeSheetName(mod.name).slice(0, 10);
        sheetName = safeSheetName(`${sheetBase}_${modPart}`).slice(0, 31 - sheetSuffix.length) + sheetSuffix;
      }
      let counter = 2;
      const baseCandidate = sheetName;
      while (usedSheetNames.has(sheetName)) {
        const cSuffix = `_${counter++}${sheetSuffix}`;
        sheetName = baseCandidate.slice(0, 31 - cSuffix.length) + cSuffix;
      }
      usedSheetNames.add(sheetName);

      // Test Description field placed in cell B2 (above Name of Tester/s in row 3).
      // Short, clear description based on the BRD requirement and actual test scenarios.
      const scenarios = [...new Set(testCases.map(t => t.scenario).filter(Boolean))];
      let description = mod.description || mod.summary || '';
      if (!description) {
        const scenList = scenarios.slice(0, 3).join(', ');
        description = scenList
          ? `Verify ${mod.name} requirements and test scenarios (${scenList}) in ${portal}.`
          : `Verify ${mod.name} requirements and functionality in ${portal}.`;
      }

      const spec = {
        name: sheetName,
        moduleNumber: k,
        moduleName: mod.name,
        portal,
        label: hasAdmin && hasRes ? `${mod.name} (${portal})` : resident ? `${mod.name} (Resident Portal)` : mod.name,
        code: codeFrom(mod.name) + (resident ? 'R' : ''),
        title: `${mod.name} - ${portal}`,
        testCases,
        source: sources.join(', '),
        description
      };
      specs.push(spec);
      for (const t of testCases) {
        if (!itemSheets.has(t._item)) itemSheets.set(t._item, new Set());
        itemSheets.get(t._item).add(spec.name);
      }
    }
  }

  const lines = [];
  for (const mod of modules.values()) {
    if (!mod.notes.length) continue;
    lines.push(`## ${mod.name}`);
    for (const n of mod.notes) {
      lines.push(`Source: ${n.source}`);
      if (n.assumptions.length) { lines.push('Assumptions:'); n.assumptions.forEach(a => lines.push(`  - ${a}`)); }
      if (n.clarifications.length) { lines.push('Needs clarification:'); n.clarifications.forEach(c => lines.push(`  - ${c}`)); }
      lines.push('');
    }
  }
  if (removed) lines.push(`(${removed} duplicate test case(s) across inputs were skipped.)`);

  return { specs, itemSheets, notes: lines.join('\n').trim(), removed };
}

module.exports = { consolidate, safeSheetName };
