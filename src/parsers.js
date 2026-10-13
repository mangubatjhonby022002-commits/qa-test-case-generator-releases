const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');

async function extractFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (ext === '.docx') return (await mammoth.extractRawText({ path: filePath })).value;
  if (ext === '.pdf') return (await pdf(fs.readFileSync(filePath))).text;
  if (['.txt', '.md'].includes(ext)) return fs.readFileSync(filePath, 'utf8');
  throw new Error(`Unsupported file type: ${ext}`);
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
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

module.exports = { extractFromFile, extractFromUrl };
