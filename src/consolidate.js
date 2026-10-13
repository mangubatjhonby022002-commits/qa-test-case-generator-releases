// Merges the AI results of ALL inputs of a run into modules -> portal sheets.
// Same module (from several BRDs / pasted issues) = one sheet; duplicates are removed.
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const moduleKey = n => norm(n).replace(/\b(module|portal)\b/g, '').replace(/\s+/g, '');
const tokens = s => new Set(norm(s).split(' ').filter(w => w.length > 2));

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

// items: [{ id, name, analysis:{moduleName, assumptions, clarifications, testCases[]} }] in processing order
function consolidate(items) {
  const modules = new Map();
  let removed = 0;

  for (const item of items) {
    const name = cleanModuleName(item.analysis.moduleName);
    const key = moduleKey(name) || `m${item.id}`;
    if (!modules.has(key)) modules.set(key, { name, portals: { 'Admin Portal': [], 'Resident Portal': [] }, notes: [] });
    const mod = modules.get(key);
    for (const tc of item.analysis.testCases) {
      const list = mod.portals[tc.portal];
      if (list.some(x => x.source !== item.name && similar(x.title, tc.title))) { removed++; continue; }
      list.push({ ...tc, source: item.name, _item: item.id });
    }
    if (item.analysis.assumptions.length || item.analysis.clarifications.length) {
      mod.notes.push({ source: item.name, assumptions: item.analysis.assumptions, clarifications: item.analysis.clarifications });
    }
  }

  const specs = [];
  const itemSheets = new Map();
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
      const spec = {
        name: `${k}.${resident ? 1 : 0}`,
        moduleNumber: k,
        moduleName: mod.name,
        portal,
        label: hasAdmin && hasRes ? `${mod.name} (${portal})` : resident ? `${mod.name} (Resident Portal)` : mod.name,
        code: codeFrom(mod.name) + (resident ? 'R' : ''),
        title: `${mod.name} - ${portal}`,
        testCases,
        source: [...new Set(testCases.map(t => t.source))].join(', ')
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

module.exports = { consolidate };
