const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');

async function extractFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.docx') {
    try { return htmlToText((await mammoth.convertToHtml({ path: filePath })).value); }   // keeps headings, lists, tables
    catch (_) { return (await mammoth.extractRawText({ path: filePath })).value; }
  }
  if (ext === '.pdf') return (await pdf(fs.readFileSync(filePath))).text;
  if (['.txt', '.md'].includes(ext)) return fs.readFileSync(filePath, 'utf8');
  throw new Error(`Unsupported file type: ${ext}`);
}

// HTML -> plain text that keeps the structure: headings as "# Title", list items as "- item", table rows as "a | b".
function htmlToText(html) {
  const strip = t => t.replace(/<[^>]+>/g, '');
  return html
    .replace(/\s*\n\s*/g, ' ')                  // line breaks in the HTML source are just spaces
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, l, t) => `\n\n${'#'.repeat(Number(l))} ${strip(t).trim()}\n\n`)
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|table|section)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\|[ \t]*(?=\n)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractFromUrl(url) {
  // Google Docs -> plain-text export (doc must be shared "Anyone with the link can view")
  const g = url.match(/docs\.google\.com\/document\/d\/([\w-]+)/);
  const target = g ? `https://docs.google.com/document/d/${g[1]}/export?format=txt` : url;

  const res = await fetch(target, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Could not open link (HTTP ${res.status}). Set sharing to "Anyone with the link can view", or upload/paste the BRD instead.`);
  }
  const type = res.headers.get('content-type') || '';
  const body = await res.text();
  if (g) {
    if (type.includes('text/html')) throw new Error('This Google Doc is private. Share it as "Anyone with the link can view", or upload the file instead.');
    return body;
  }
  return type.includes('text/plain') ? body : htmlToText(body);
}


// ---------------------------------------------------------------------------------------------
// Screenshots and screen recordings
// Formats the Gemini API reads directly are sent as they are. Everything else (and recordings that are too big
// to send inline) is converted with ffmpeg when it is installed; otherwise a clear error is shown.
// ---------------------------------------------------------------------------------------------
const MB = 1024 * 1024;
const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif' };
const VIDEO_MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.wmv': 'video/wmv', '.flv': 'video/x-flv', '.3gp': 'video/3gpp' };
const CONVERT_IMAGE = ['.bmp', '.tif', '.tiff'];
const CONVERT_VIDEO = ['.avi', '.mkv', '.m4v', '.gif'];
const UNSUPPORTED_MEDIA = ['.svg', '.psd', '.ico', '.ai', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'];
const IMAGE_MAX_BYTES = 7 * MB;

// 'image' | 'video' (sent directly), 'image-convert' | 'video-convert' (needs ffmpeg), 'unsupported', or null (not a media file)
function mediaKind(ext) {
  ext = String(ext).toLowerCase();
  if (IMAGE_MIME[ext]) return 'image';
  if (VIDEO_MIME[ext]) return 'video';
  if (CONVERT_IMAGE.includes(ext)) return 'image-convert';
  if (CONVERT_VIDEO.includes(ext)) return 'video-convert';
  if (UNSUPPORTED_MEDIA.includes(ext)) return 'unsupported';
  return null;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err = (err + d).slice(-600); });
    p.on('error', e => reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed`) : e));
    p.on('close', c => (c === 0 ? resolve(out) : reject(new Error(`${cmd} failed: ${err.trim().split('\n').pop()}`))));
  });
}
let ffmpegOk;
const hasFfmpeg = async () => (ffmpegOk === undefined ? (ffmpegOk = await run('ffmpeg', ['-version']).then(() => true, () => false)) : ffmpegOk);
const needFfmpeg = async (why, hint) => { if (!(await hasFfmpeg())) throw new Error(`${why} ffmpeg is not installed, so it cannot be converted automatically. ${hint}`); };
const b64 = p => fs.readFileSync(p).toString('base64');
const clock = sec => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// Image -> JPEG (BMP/TIFF, or a PNG/JPG over 7 MB), at most 1600 px wide.
async function convertImage(file) {
  await needFfmpeg(`"${file.originalName}" cannot be sent to the AI directly (format not supported, or over 7 MB).`, 'Use a PNG/JPG under 7 MB, or install ffmpeg.');
  const dir = fs.mkdtempSync(path.join(path.dirname(file.path), 'img-'));
  try {
    const out = path.join(dir, 'out.jpg');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file.path, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", '-q:v', '3', out]);
    return { label: `Screenshot: ${file.originalName}`, mimeType: 'image/jpeg', kind: 'image', data: b64(out) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Recording -> evenly spaced frames (max `maxFrames`), as images.
async function extractFrames(file, maxFrames, limitMb) {
  await needFfmpeg(`"${file.originalName}" cannot be sent to the AI directly (format not supported, or over ${limitMb} MB).`, `Use an MP4/WebM under ${limitMb} MB, upload screenshots instead, or install ffmpeg.`);
  let dur = 0;
  try { dur = parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file.path])) || 0; } catch (_) {}
  const step = dur ? Math.max(1, Math.ceil(dur / maxFrames)) : 3;
  const dir = fs.mkdtempSync(path.join(path.dirname(file.path), 'frames-'));
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file.path, '-vf', `fps=1/${step},scale='min(1280,iw)':-2`, '-frames:v', String(maxFrames), '-q:v', '4', path.join(dir, 'f%03d.jpg')]);
    const frames = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).sort();
    if (!frames.length) throw new Error(`No frames could be extracted from "${file.originalName}".`);
    return frames.map((f, i) => ({
      label: `Recording "${file.originalName}" - frame ${i + 1}, about ${clock(i * step)} into the video`,
      mimeType: 'image/jpeg', kind: 'image', data: b64(path.join(dir, f))
    }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// files: [{ path, originalName }] -> [{ label, mimeType, kind: 'image'|'video', data(base64) }]
async function loadMedia(files, { inlineMaxMb = Number(process.env.VIDEO_INLINE_MAX_MB || 12), maxFrames = Number(process.env.MAX_VIDEO_FRAMES || 30) } = {}) {
  const out = [];
  for (const f of files) {
    const ext = path.extname(f.originalName).toLowerCase();
    const kind = mediaKind(ext);
    const size = fs.statSync(f.path).size;
    if (kind === 'image' && size <= IMAGE_MAX_BYTES) out.push({ label: `Screenshot: ${f.originalName}`, mimeType: IMAGE_MIME[ext], kind: 'image', data: b64(f.path) });
    else if (kind === 'image' || kind === 'image-convert') out.push(await convertImage(f));
    else if (kind === 'video' && size <= inlineMaxMb * MB) out.push({ label: `Screen recording: ${f.originalName}`, mimeType: VIDEO_MIME[ext], kind: 'video', data: b64(f.path) });
    else if (kind === 'video' || kind === 'video-convert') out.push(...await extractFrames(f, maxFrames, inlineMaxMb));
    else throw new Error(`Unsupported file type ${ext || '(none)'}. Use PNG/JPG/WebP screenshots or MP4/WebM recordings.`);
  }
  return out;
}

module.exports = { extractFromFile, extractFromUrl, htmlToText, loadMedia, mediaKind };
