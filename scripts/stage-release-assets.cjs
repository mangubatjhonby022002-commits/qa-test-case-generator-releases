// Prepares the release assets for the GitHub releases repository.
//
// The updater asks GitHub for these exact names (electron-builder strips the spaces
// from the file name, and the updater asks for the same name without them):
//
//   QA-Test-Case-Generator-Setup-<version>.exe
//   QA-Test-Case-Generator-Setup-<version>.exe.blockmap
//   latest.yml
//
// The script copies them from dist/ into dist/release-assets/ with those names and
// checks that latest.yml points at them. Nothing is uploaded - that stays manual.
//
// Run with:  npm run release:assets
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const OUT = path.join(DIST, 'release-assets');

const ymlPath = path.join(DIST, 'latest.yml');
if (!fs.existsSync(ymlPath)) {
  console.error('dist/latest.yml is missing - run "npm run dist" first.');
  process.exit(1);
}
const yml = fs.readFileSync(ymlPath, 'utf8');
const version = (yml.match(/^version:\s*(\S+)/m) || [])[1];
const assetName = (yml.match(/^\s*-\s*url:\s*(\S+)/m) || [])[1];
const sha512 = (yml.match(/sha512:\s*(\S+)/) || [])[1];
if (!version || !assetName) {
  console.error('dist/latest.yml does not contain a version and a file name.');
  process.exit(1);
}

const onDisk = fs.readdirSync(DIST).find(f => f.toLowerCase().endsWith('.exe') && !f.endsWith('.blockmap'));
if (!onDisk) {
  console.error('No installer in dist/ - run "npm run dist" first.');
  process.exit(1);
}

const wanted = [
  { from: path.join(DIST, onDisk), to: assetName },
  { from: path.join(DIST, `${onDisk}.blockmap`), to: `${assetName}.blockmap` },
  { from: ymlPath, to: 'latest.yml' }
];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

for (const w of wanted) {
  if (!fs.existsSync(w.from)) {
    console.error(`Missing: ${w.from}`);
    process.exit(1);
  }
  fs.copyFileSync(w.from, path.join(OUT, w.to));
}

// The checksum in latest.yml has to belong to the installer that is published.
const crypto = require('crypto');
const digest = crypto.createHash('sha512').update(fs.readFileSync(path.join(OUT, assetName))).digest('base64');
if (digest !== sha512) {
  console.error('The sha512 in latest.yml does not match the installer - the assets are not from the same build.');
  process.exit(1);
}

console.log(`Release assets for version ${version} (tag v${version}) are ready in:`);
console.log(`  ${OUT}`);
for (const f of fs.readdirSync(OUT)) {
  console.log(`  - ${f}  (${(fs.statSync(path.join(OUT, f)).size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log('\nUpload all three files to the release of the GitHub repository');
console.log('mangubatjhonby022002-commits/qa-test-case-generator-releases and publish it.');
console.log('The release tag must be v' + version + '.');
