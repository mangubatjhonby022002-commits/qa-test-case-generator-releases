require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { extractFromFile, extractFromUrl } = require('./src/parsers');
const { analyzeInput } = require('./src/generator');
const { consolidate } = require('./src/consolidate');
const { writeWorkbook } = require('./src/templateWriter');
const { createCleaner } = require('./src/session');

const PORT = process.env.PORT || 3000;
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const DEFAULT_TEMPLATE = path.join(__dirname, 'templates', 'TC_Template.xlsx');
const TMP = path.join(__dirname, 'tmp');
const OUT = path.join(__dirname, 'output');
const AUTOMATION = String(process.env.AUTOMATION_SHEET || 'off').toLowerCase() === 'on';
const URLS = {
  admin: process.env.ADMIN_PORTAL_URL || '',
  resident: process.env.RESIDENT_PORTAL_URL || ''
};
[TMP, OUT].forEach(d => fs.mkdirSync(d, { recursive: true }));

const app = express();
const upload = multer({ dest: TMP, limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100kb' }));

const jobs = new Map();
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MINUTES || 60) * 60 * 1000;   // runs nobody ended are deleted after this
const cleaner = createCleaner({ jobs, outDir: OUT, tmpDir: TMP });
const SUPPORTED = ['.docx', '.pdf', '.txt', '.md'];
const cleanMode = m => (String(m || '').toLowerCase().startsWith('smoke') ? 'smoke' : 'comprehensive');
const safeName = s => String(s).replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '_').trim().slice(0, 60) || 'Input';

async function runPool(items, limit, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await worker(items[i++]);
  }));
}

async function processItem(job, item) {
  try {
    if (job.cancelled) { item.status = 'cancelled'; return; }
    item.status = 'reading';
    let text;
    if (item.type === 'file') text = await extractFromFile(item.path, item.originalName);
    else if (item.type === 'url') text = await extractFromUrl(item.url);
    else text = item.text;
    // Short issue summaries are fine - only reject empty input.
    if (!text || text.trim().length < 15) throw new Error('No readable text found in this input.');

    if (job.cancelled) { item.status = 'cancelled'; return; }
    item.status = 'generating';
    item.analysis = await analyzeInput({
      text, inputType: item.inputType, sourceName: item.name,
      moduleHint: item.moduleHint, portalHint: item.portalHint, mode: item.mode, automation: AUTOMATION
    });
    if (job.cancelled) { delete item.analysis; item.status = 'cancelled'; return; }
    if (!item.analysis.testCases.length) throw new Error('The AI returned no test cases. Try again or add more detail.');
    item.count = item.analysis.testCases.length;
    item.status = 'generated';
  } catch (e) {
    const stage = item.status;
    item.status = 'error';
    item.error = `(${stage}) ${e.message}`;
    console.error(`[${item.name}] failed while ${stage}:`, e.stack);
  } finally {
    if (item.path) fs.unlink(item.path, () => {});
  }
}

// After every input is processed: write the workbook(s).
//   single   -> ONE workbook, one sheet per module / portal (1.0, 1.1, 2.0 ...)
//   separate -> one workbook per module (its own Summary; module sheet is 1.0 / 1.1 inside it)
async function finishJob(job) {
  if (job.cancelled) { job.done = true; return; }
  const ok = job.items.filter(i => i.status === 'generated');
  try {
    if (ok.length) {
      const { specs, itemSheets, notes, removed } = consolidate(ok);
      ok.forEach(it => { it.status = 'writing'; });
      const stamp = `${new Date().toISOString().slice(0, 10)}_${job.id.slice(0, 4)}`;
      const account = job.account ? safeName(job.account) : '';
      const outputs = [];
      if (job.outputMode === 'separate') {
        const byModule = new Map();
        specs.forEach(sp => { if (!byModule.has(sp.moduleNumber)) byModule.set(sp.moduleNumber, []); byModule.get(sp.moduleNumber).push(sp); });
        for (const list of byModule.values()) {
          outputs.push({
            label: list[0].moduleName,
            fileName: `${account ? account + '_' : ''}${safeName(list[0].moduleName)}_TestCases.xlsx`,
            specs: list.map(sp => ({ ...sp, moduleNumber: 1, name: `1.${sp.portal === 'Resident Portal' ? 1 : 0}` }))
          });
        }
      } else {
        outputs.push({ label: 'All modules', fileName: account ? `${account}_TestCases.xlsx` : `TestCases_${stamp}.xlsx`, specs });
      }

      job.downloads = [];
      const warnings = [];
      let steps = 0;
      for (const o of outputs) {
        const result = await writeWorkbook({ templatePath: job.templatePath, outPath: path.join(OUT, job.id, o.fileName), specs: o.specs, urls: URLS, automation: AUTOMATION });
        steps += result.automationRows;
        warnings.push(...result.warnings);
        job.downloads.push({ label: outputs.length > 1 ? o.label : 'workbook', file: o.fileName });
        for (const sp of o.specs) for (const tc of sp.testCases) {
          const it = ok.find(x => x.id === tc._item);
          if (it) it.sheetSet = (it.sheetSet || new Set()).add(job.outputMode === 'separate' ? o.fileName : sp.name);
        }
      }
      ok.forEach(it => { it.sheet = [...(it.sheetSet || itemSheets.get(it.id) || [])].join(', '); delete it.sheetSet; });

      job.summary = `${outputs.length} workbook(s), ${specs.length} module sheet(s)` + (AUTOMATION ? `, ${steps} automation step(s)` : '') + (removed ? `, ${removed} duplicate(s) skipped` : '');
      const noteText = [notes, ...(warnings.length ? ['', 'Automation notes:', ...warnings.map(w => `  - ${w}`)] : [])].join('\n').trim();
      if (noteText) {
        job.notesFile = `Assumptions_and_Notes_${stamp}.txt`;
        fs.writeFileSync(path.join(OUT, job.id, job.notesFile), noteText);
      }
      ok.forEach(it => { it.status = 'done'; });
    }
  } catch (e) {
    console.error('Workbook write failed:', e.message);
    ok.forEach(it => { it.status = 'error'; it.error = `(writing) ${e.message}`; });
  }
  // Keep only what the results table needs. Test case content, pasted text and uploads are dropped from memory now.
  for (const it of job.items) {
    it.assumptions = it.analysis?.assumptions || [];
    it.clarifications = it.analysis?.clarifications || [];
    delete it.analysis; delete it.text; delete it.path;
  }
  job.done = true;
}

app.post('/api/generate',
  upload.fields([{ name: 'brds', maxCount: 200 }, { name: 'template', maxCount: 1 }]),
  (req, res) => {
    const mode = cleanMode(req.body.mode);
    const id = randomUUID();

    let templatePath = DEFAULT_TEMPLATE;
    const t = req.files?.template?.[0];
    if (t) { templatePath = `${t.path}.xlsx`; fs.renameSync(t.path, templatePath); }
    if (!fs.existsSync(templatePath)) {
      return res.status(400).json({ error: 'No template found. Upload your template (.xlsx) or put it at templates/TC_Template.xlsx.' });
    }

    const items = [];
    const used = new Set();
    const add = (name, extra) => {
      let unique = safeName(name), n = 1;
      const base = unique;
      while (used.has(unique)) unique = `${base}_${++n}`;
      used.add(unique);
      items.push({ id: items.length, name: unique, mode, status: 'queued', inputType: 'BRD document', moduleHint: '', portalHint: 'Auto', ...extra });
    };

    // Order = sheet order: files by name, then links, then pasted items.
    const files = (req.files?.brds || []).slice()
      .sort((a, b) => a.originalname.localeCompare(b.originalname, undefined, { numeric: true, sensitivity: 'base' }));
    for (const f of files) {
      const ext = path.extname(f.originalname).toLowerCase();
      if (!SUPPORTED.includes(ext)) { fs.unlink(f.path, () => {}); continue; }
      add(f.originalname, { type: 'file', path: f.path, originalName: f.originalname });
    }

    // One link per line. Optional per-link mode:  https://... | smoke
    for (const line of String(req.body.links || '').split('\n')) {
      const [url, m] = line.split('|').map(s => s.trim());
      if (!url) continue;
      add(url.replace(/^https?:\/\//, '').replace(/[^\w]+/g, '_').slice(0, 40), { type: 'url', url, ...(m ? { mode: cleanMode(m) } : {}) });
    }

    // Pasted items: BRD text, feature description, issue summary, CRF summary ...
    let pasted = [];
    try { pasted = JSON.parse(req.body.pasted || '[]'); } catch (_) {}
    pasted.forEach((p, i) => {
      if (!String(p.text || '').trim()) return;
      const type = String(p.type || 'Pasted text');
      add(`${type} ${i + 1}${p.module ? ' - ' + p.module : ''}`, {
        type: 'text', text: String(p.text), inputType: type, moduleHint: String(p.module || '').trim(), portalHint: String(p.portal || 'Auto')
      });
    });

    if (!items.length) return res.status(400).json({ error: 'Add at least one input (link, file/folder, or pasted text).' });

    const job = {
      id, templatePath, items, done: false, createdAt: Date.now(), templateTmp: t ? templatePath : null,
      outputMode: String(req.body.outputMode) === 'separate' ? 'separate' : 'single',
      account: String(req.body.account || '').trim()
    };
    jobs.set(id, job);
    res.json({ jobId: id });

    runPool(items, CONCURRENCY, it => processItem(job, it))
      .then(() => finishJob(job))
      .finally(() => {
        if (t) fs.unlink(templatePath, () => {});
        if (job.cancelled) cleaner.endSession([job.id]);   // ended while running: remove anything written meanwhile
      });
  });

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const link = f => (f ? `/api/download/${job.id}/${encodeURIComponent(f)}` : null);
  res.json({
    done: job.done,
    summary: job.summary || '',
    downloads: (job.downloads || []).map(d => ({ label: d.label, url: link(d.file) })),
    notesDownload: link(job.notesFile),
    items: job.items.map(i => ({
      id: i.id, name: i.name, mode: i.mode, status: i.status, error: i.error, count: i.count, sheet: i.sheet,
      assumptions: i.assumptions || [], clarifications: i.clarifications || []
    }))
  });
});

app.get('/api/download/:jobId/:file', (req, res) => {
  res.download(path.join(OUT, path.basename(req.params.jobId), path.basename(req.params.file)), err => {
    if (err && !res.headersSent) res.status(404).send('File not found - the session may have been ended.');
  });
});

// End Session: delete this session's uploads, generated files and in-memory data.
app.post('/api/session/end', (req, res) => {
  try {
    const ids = Array.isArray(req.body?.jobIds) ? req.body.jobIds.slice(0, 50) : [];
    const r = cleaner.endSession(ids);
    res.json({ ok: r.failed.length === 0, ended: r.ended, deleted: r.removed, failed: r.failed });
  } catch (e) {
    console.error('End session failed:', e.message);
    res.status(500).json({ ok: false, failed: ['Cleanup hit an unexpected error'] });
  }
});

const left = cleaner.clearAppDirs();
if (left.removed) console.log(`Removed ${left.removed} leftover temp item(s) from a previous run.`);
setInterval(() => cleaner.sweepExpired(SESSION_TTL_MS), 5 * 60 * 1000).unref();

app.listen(PORT, () => console.log(`BRD → Test Case generator running at http://localhost:${PORT}  |  Automation sheet: ${AUTOMATION ? 'ON' : 'OFF'}`));
