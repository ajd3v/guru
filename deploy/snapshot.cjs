// Recoverable snapshot. Capture the queue and its source files before library copies.
const D = require('better-sqlite3');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.resolve(process.env.GURU_DATA_ROOT || '/app/data');
const stage = path.resolve(process.env.GURU_STAGE);
const queue = path.resolve(process.env.GURU_JOBS_DB || path.join(root, 'jobs.db'));
const manifest = { version: 1, databases: [], uploads: [], queue: null };
const inside = (file) => { const rel = path.relative(root, file); if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Backup file outside data root'); return rel; };
const snapshot = (file) => {
  const relative = inside(file), name = relative.replaceAll(path.sep, '_');
  const db = new D(file, { readonly: true });
  try { db.prepare('vacuum into ?').run(path.join(stage, name)); } finally { db.close(); }
  manifest.databases.push({ source: relative, archive: name });
  return path.join(stage, name);
};
fs.mkdirSync(stage, { recursive: true });
if (fs.existsSync(queue)) {
  const queueSnapshot = snapshot(queue);
  manifest.queue = path.basename(queueSnapshot);
  const copy = new D(queueSnapshot, { readonly: true });
  try {
    for (const job of copy.prepare("select id,path from jobs where state in ('queued','running')").all()) {
      const source = path.resolve(job.path), relative = inside(source), archive = 'uploads/' + job.id + path.extname(source);
      fs.mkdirSync(path.dirname(path.join(stage, archive)), { recursive: true });
      // If a worker consumed this file, fail this snapshot. Never archive an unrecoverable queue.
      fs.copyFileSync(source, path.join(stage, archive));
      const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(stage, archive))).digest('hex');
      manifest.uploads.push({ job: job.id, source: relative, archive, sha256 });
    }
  } finally { copy.close(); }
}
for (const folder of [root, path.join(root, 'users')]) {
  if (!fs.existsSync(folder)) continue;
  for (const name of fs.readdirSync(folder).filter((f) => f.endsWith('.db')).sort()) {
    const file = path.join(folder, name);
    if (file !== queue) snapshot(file);
  }
}
if (!manifest.databases.length) throw new Error('No databases found');
fs.writeFileSync(path.join(stage, 'snapshot.json'), JSON.stringify(manifest, null, 2));
console.log(`Captured ${manifest.databases.length} databases and ${manifest.uploads.length} pending uploads.`);
