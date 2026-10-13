// Session cleanup: deletes the temporary files and in-memory data of finished (or abandoned) runs.
// It only ever touches:  tmp/  and  output/<job-id>/  inside this app, plus the in-memory `jobs` map.
// It never touches templates/, source code, or anything outside those two folders.
const fs = require('fs');
const path = require('path');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inside = (root, target) => {
  const r = path.resolve(root);
  const t = path.resolve(target);
  return t !== r && t.startsWith(r + path.sep);
};

function createCleaner({ jobs, outDir, tmpDir, log = console }) {
  // Remove one file/folder if it exists. Returns true when something was deleted. Never throws.
  function remove(target, root, failed, label) {
    try {
      if (!inside(root, target)) { failed.push(`${label} (outside the app's temp folders - skipped)`); return false; }
      if (!fs.existsSync(target)) return false;
      fs.rmSync(target, { recursive: true, force: true });
      if (fs.existsSync(target)) throw new Error('still exists');
      return true;
    } catch (e) {
      failed.push(label);
      log.error(`[cleanup] could not delete ${label}: ${e.message}`);
      return false;
    }
  }

  // Delete everything that belongs to one job: uploads still on disk, the template copy, generated files, memory.
  function cleanupJob(job) {
    const failed = [];
    let removed = 0;
    job.cancelled = true;                         // running work stops and discards its results
    for (const it of job.items || []) {
      if (it.path && remove(it.path, tmpDir, failed, 'uploaded file')) removed++;
    }
    if (job.templateTmp && remove(job.templateTmp, tmpDir, failed, 'uploaded template')) removed++;
    if (ID_RE.test(job.id) && remove(path.join(outDir, job.id), outDir, failed, `output/${job.id}`)) removed++;
    for (const it of job.items || []) { delete it.text; delete it.analysis; delete it.path; delete it.assumptions; delete it.clarifications; }
    job.items = [];
    job.downloads = [];
    jobs.delete(job.id);
    return { removed, failed };
  }

  // End the session for the given job ids (only those - other users' jobs are left alone).
  function endSession(ids) {
    const result = { ended: 0, removed: 0, failed: [] };
    for (const id of [...new Set(ids)]) {
      if (typeof id !== 'string' || !ID_RE.test(id)) continue;
      const job = jobs.get(id);
      let r;
      if (job) r = cleanupJob(job);
      else {                                       // unknown job (e.g. server restarted): remove leftover output only
        const failed = [];
        r = { removed: remove(path.join(outDir, id), outDir, failed, `output/${id}`) ? 1 : 0, failed };
      }
      result.ended++;
      result.removed += r.removed;
      result.failed.push(...r.failed);
    }
    return result;
  }

  // Remove runs nobody ended (tab closed, forgot to click) after ttlMs.
  function sweepExpired(ttlMs) {
    const now = Date.now();
    let n = 0;
    for (const job of [...jobs.values()]) {
      const age = now - (job.createdAt || now);
      if ((job.done && age > ttlMs) || age > ttlMs * 3) { cleanupJob(job); n++; }
    }
    return n;
  }

  // Start-up: nothing from a previous run should still be on disk. Only the CHILDREN of tmp/ and output/ are removed.
  function clearAppDirs() {
    const failed = [];
    let removed = 0;
    for (const dir of [tmpDir, outDir]) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) {}
      for (const name of names) if (remove(path.join(dir, name), dir, failed, `${path.basename(dir)}/${name}`)) removed++;
    }
    return { removed, failed };
  }

  return { cleanupJob, endSession, sweepExpired, clearAppDirs };
}

module.exports = { createCleaner, ID_RE };
