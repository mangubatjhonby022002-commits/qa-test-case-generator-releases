// Offline end-to-end check of the real auto-update path.
//
// It starts a local server that mimics the GitHub releases layout, points the real
// electron-updater GitHubProvider at it and lets it check, download and verify the
// REAL build artifacts from dist/ (latest.yml + installer + blockmap).
// Nothing is installed and nothing outside this machine is contacted.
//
// Run with:  npx electron scripts/verify-updater-feed.cjs
const { app } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
// The same semver instance electron-updater uses - it compares SemVer objects.
const semver = require('electron-updater/node_modules/semver');

const DIST = path.join(__dirname, '..', 'dist');
const OWNER = 'local-check-owner';
const REPO = 'local-check-releases';

// The release assets of the build, exactly as they have to be published on GitHub:
// electron-builder names them without spaces, and the updater asks for those names.
function readRelease() {
  const info = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf8');
  const version = (info.match(/^version:\s*(\S+)/m) || [])[1];
  const file = (info.match(/^\s*-\s*url:\s*(\S+)/m) || [])[1];
  const sha = (info.match(/sha512:\s*(\S+)/) || [])[1];
  const size = Number((info.match(/^\s*size:\s*(\d+)/m) || [])[1]);
  if (!version || !file || !sha) throw new Error('dist/latest.yml is not readable - run "npm run dist" first.');
  const onDisk = fs.readdirSync(DIST).find(f => f.toLowerCase().endsWith('.exe') && !f.endsWith('.blockmap'));
  if (!onDisk) throw new Error('No installer in dist/ - run "npm run dist" first.');
  return {
    version,
    file,                       // name on GitHub, e.g. QA-Test-Case-Generator-Setup-1.0.0.exe
    sha,
    size: size || fs.statSync(path.join(DIST, onDisk)).size,
    installerName: onDisk,      // name on disk, e.g. QA Test Case Generator Setup 1.0.0.exe
    tag: `v${version}`
  };
}

const atom = tag => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Releases</title>
  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <link type="text/html" rel="alternate" href="https://github.com/${OWNER}/${REPO}/releases/tag/${tag}"/>
    <title>${tag}</title>
    <updated>2026-01-01T00:00:00Z</updated>
    <content type="html">Release ${tag}</content>
  </entry>
</feed>`;

// Serves the real files of dist/ under the names they have on GitHub.
function startServer(rel) {
  const requested = [];
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    requested.push(url);
    if (url.endsWith('/releases.atom')) {
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
      return res.end(atom(rel.tag));
    }
    if (url.includes('/releases/latest')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: rel.tag, name: rel.tag }));
    }
    if (url.includes('/releases/download/')) {
      const file = url.substring(url.lastIndexOf('/') + 1);
      const send = (source) => {
        const stat = fs.statSync(source);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
        fs.createReadStream(source).pipe(res);
      };
      if (file === 'latest.yml') {
        const body = fs.readFileSync(path.join(DIST, 'latest.yml'));
        res.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': body.length });
        return res.end(body);
      }
      if (file === rel.file) return send(path.join(DIST, rel.installerName));
      if (file === `${rel.file}.blockmap`) {
        const blockmap = path.join(DIST, rel.installerName + '.blockmap');
        if (!fs.existsSync(blockmap)) { res.writeHead(404); return res.end('no blockmap'); }
        return send(blockmap);
      }
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(404);
    res.end('not found');
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requested })));
}

(async () => {
  const result = { steps: [] };
  let server;
  try {
    const rel = readRelease();
    const { server: feedServer, requested } = await startServer(rel);
    server = feedServer;
    const port = server.address().port;
    result.release = { version: rel.version, tag: rel.tag, assets: [rel.file, `${rel.file}.blockmap`, 'latest.yml'] };
    result.steps.push(`mock GitHub feed on 127.0.0.1:${port} serving the real dist/ artifacts`);

    const { autoUpdater } = require('electron-updater');
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // An older version is simulated, so the release in dist/ counts as an update.
    autoUpdater.currentVersion = semver.parse('0.0.1');

    // In dev mode electron-updater reads the feed configuration from a file.
    const configFile = path.join(require('os').tmpdir(), 'kilo', 'dev-app-update.yml');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, [
      'provider: github',
      `owner: ${OWNER}`,
      `repo: ${REPO}`,
      `host: 127.0.0.1:${port}`,
      'protocol: http',
      'updaterCacheDirName: brd-tc-generator-updater',
      ''
    ].join('\n'), 'utf8');
    autoUpdater.updateConfigPath = configFile;

    const events = [];
    autoUpdater.on('update-available', i => events.push(['update-available', i && i.version]));
    autoUpdater.on('download-progress', p => events.push(['download-progress', Math.round(p.percent || 0)]));
    autoUpdater.on('update-downloaded', i => events.push(['update-downloaded', i && i.version]));
    autoUpdater.on('update-not-available', () => events.push(['update-not-available']));
    autoUpdater.on('error', e => events.push(['error', e && e.message]));

    autoUpdater.setFeedURL({
      provider: 'github',
      owner: OWNER,
      repo: REPO,
      host: `127.0.0.1:${port}`,
      protocol: 'http'
    });

    const check = await autoUpdater.checkForUpdates();
    result.updateAvailable = Boolean(check && check.updateInfo);
    result.feedVersion = check && check.updateInfo ? check.updateInfo.version : null;
    result.downloadURL = check && check.updateInfo && check.updateInfo.files[0] ? check.updateInfo.files[0].url : null;

    if (!check || !check.updateInfo) {
      result.steps.push('no update info - check failed');
    } else {
      await autoUpdater.downloadUpdate();
      const pendingDir = autoUpdater.downloadedUpdateHelper.cacheDirForPendingUpdate;
      const downloaded = path.join(pendingDir, rel.file);
      result.downloadedFile = downloaded;
      result.downloadedExists = fs.existsSync(downloaded);
      result.downloadedSize = result.downloadedExists ? fs.statSync(downloaded).size : 0;
      result.expectedSize = rel.size;
      result.sizeMatches = result.downloadedSize === rel.size;
    }

    result.events = events;
    result.eventsIncludeAvailable = events.some(e => e[0] === 'update-available');
    result.eventsIncludeDownloaded = events.some(e => e[0] === 'update-downloaded');
    result.noError = !events.some(e => e[0] === 'error');
    // Everything the updater asked the release for - this is what has to be published.
    result.requestedAssets = requested.slice();
  } catch (err) {
    result.error = err && err.stack ? err.stack : String(err);
  } finally {
    if (server) server.close();
  }

  console.log('\n===UPDATER FEED VERIFICATION===');
  console.log(JSON.stringify(result, null, 1));
  console.log('===END===');
  app.exit(result.error || !result.eventsIncludeDownloaded || !result.sizeMatches ? 1 : 0);
})();
