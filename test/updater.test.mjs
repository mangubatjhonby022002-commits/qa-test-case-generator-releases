import assert from 'node:assert';
import { EventEmitter } from 'node:events';

console.log('--- Starting Electron Auto-Updater Test Suite ---');

// Mock Electron components for deterministic unit testing
class MockAutoUpdater extends EventEmitter {
  constructor() {
    super();
    this.autoDownload = true;
    this.autoInstallOnAppQuit = true;
    this.feedConfig = null;
    this.downloadUpdateCalled = false;
    this.quitAndInstallCalled = false;
    this.checkForUpdatesCalled = false;
  }

  setFeedURL(config) {
    this.feedConfig = config;
  }

  async checkForUpdates() {
    this.checkForUpdatesCalled = true;
    return {};
  }

  async downloadUpdate() {
    this.downloadUpdateCalled = true;
    return [];
  }

  quitAndInstall(isSilent, isForceRunAfter) {
    this.quitAndInstallCalled = true;
    this.quitArgs = { isSilent, isForceRunAfter };
  }
}

class MockBrowserWindow {
  constructor() {
    this.title = 'QA Test Case Generator';
    this.destroyed = false;
  }
  isDestroyed() { return this.destroyed; }
  setTitle(t) { this.title = t; }
  getTitle() { return this.title; }
}

const mockWindow = new MockBrowserWindow();
let dialogBoxCalls = [];
let dialogResponseIndex = 0;

// The app/dialog objects of the updater module - in plain Node they are the built-in fallbacks.
const { initUpdater, checkForUpdates, getUpdaterState, resetUpdaterState, compareVersions, checkFeed, onState, app, dialog, REPO_OWNER, REPO_NAME } =
  await import('../src/updater.js');

// Intercept dialog calls for assertions
dialog.showMessageBox = async (win, options) => {
  dialogBoxCalls.push({ win, options });
  return { response: dialogResponseIndex };
};

function clearDialogHistory() {
  dialogBoxCalls = [];
  dialogResponseIndex = 0;
}

// A fetch that answers like GitHub does for the release feed.
function feedResponse(body, status = 200) {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const originalFetch = globalThis.fetch;
function withFeed(body, status, fn) {
  globalThis.fetch = feedResponse(body, status);
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = originalFetch; });
}

// -------------------------------------------------------------
// Test 1: Configuration & Defaults
// -------------------------------------------------------------
{
  resetUpdaterState();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  assert.strictEqual(mockUpdater.autoDownload, false, 'autoDownload must be false');
  assert.strictEqual(mockUpdater.autoInstallOnAppQuit, false, 'autoInstallOnAppQuit must be false');
  assert.strictEqual(mockUpdater.feedConfig?.provider, 'github', 'Provider must be github');
  assert.strictEqual(mockUpdater.feedConfig?.owner, 'mangubatjhonby022002-commits', 'Owner must match target repo');
  assert.strictEqual(mockUpdater.feedConfig?.repo, 'qa-test-case-generator-releases', 'Repo must be dedicated public releases repo');
  console.log('✓ Test 1: Updater initializes with autoDownload=false, autoInstallOnAppQuit=false, and public repo feed');
}

// -------------------------------------------------------------
// Test 2: Development mode does a REAL check of the release feed
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  app.isPackaged = false;

  // A newer release is published -> the check finds it
  const states = [];
  onState(s => states.push(s.status));
  await withFeed({ tag_name: 'v1.0.1' }, 200, async () => {
    const result = await checkForUpdates({ manual: true, window: mockWindow, customUpdater: mockUpdater });
    assert.strictEqual(result.status, 'available', 'A newer release must be reported as available');
    assert.strictEqual(result.version, '1.0.1', 'The version of the release must be reported');
  });
  assert.strictEqual(dialogBoxCalls.length, 1, 'Manual check in dev mode shows a dialog with the result');
  assert.match(dialogBoxCalls[0].options.title, /Update Available/i);
  assert.ok(states.includes('checking'), 'The checking state must be reported');
  assert.ok(states.includes('available'), 'The available state must be reported');

  // The same version -> up to date
  clearDialogHistory();
  await withFeed({ tag_name: 'v1.0.0' }, 200, async () => {
    const result = await checkForUpdates({ manual: true, window: mockWindow, customUpdater: mockUpdater });
    assert.strictEqual(result.status, 'up-to-date', 'The same version must be reported as up to date');
  });
  assert.match(dialogBoxCalls[0].options.title, /Up to Date/i);

  // The feed cannot be reached -> an error, never "up to date"
  clearDialogHistory();
  await withFeed({ message: 'Not Found' }, 404, async () => {
    const result = await checkForUpdates({ manual: true, window: mockWindow, customUpdater: mockUpdater });
    assert.strictEqual(result.status, 'error', 'A failing check must be reported as an error');
    assert.notStrictEqual(result.status, 'up-to-date', 'A failing check must never be reported as up to date');
    assert.match(result.message, /404|not found/i);
  });
  assert.match(dialogBoxCalls[0].options.title, /Update Check Failed/i);

  onState(null);
  console.log('✓ Test 2: Development mode checks the real release feed and reports check / available / up to date / error');
}

// -------------------------------------------------------------
// Test 3: No Update Available - Silent on Background Check
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  app.isPackaged = true;

  // Trigger background check
  await checkForUpdates({ manual: false, window: mockWindow, customUpdater: mockUpdater });
  assert.strictEqual(mockUpdater.checkForUpdatesCalled, true);

  // Emit update-not-available
  mockUpdater.emit('update-not-available', { version: '1.0.0' });
  assert.strictEqual(dialogBoxCalls.length, 0, 'Background check with no update must be completely silent');
  console.log('✓ Test 3: No update available during background startup check remains completely silent');
}

// -------------------------------------------------------------
// Test 4: No Update Available - Dialog on Manual Check
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  app.isPackaged = true;

  // Trigger manual check
  await checkForUpdates({ manual: true, window: mockWindow, customUpdater: mockUpdater });
  mockUpdater.emit('update-not-available', { version: '1.0.0' });

  assert.strictEqual(dialogBoxCalls.length, 1, 'Manual check must show up-to-date dialog');
  assert.match(dialogBoxCalls[0].options.title, /Up to Date/i);
  assert.strictEqual(getUpdaterState().status, 'up-to-date', 'The state must be up-to-date');
  console.log('✓ Test 4: Manual check when already up to date shows clear Up to Date dialog');
}

// -------------------------------------------------------------
// Test 5: Update Available - User Declines Download ("Later")
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  app.isPackaged = true;
  dialogResponseIndex = 1; // User clicks 'Later' (index 1)

  await checkForUpdates({ manual: false, window: mockWindow, customUpdater: mockUpdater });
  mockUpdater.emit('update-available', { version: '1.0.1' });

  // Await microtasks for async handler
  await new Promise(r => setTimeout(r, 10));

  assert.strictEqual(dialogBoxCalls.length, 1, 'Dialog must be shown asking to download');
  assert.strictEqual(mockUpdater.downloadUpdateCalled, false, 'downloadUpdate must NOT be called when user clicks Later');
  assert.strictEqual(getUpdaterState().userDeclinedDownload, true, 'userDeclinedDownload must be true');
  assert.strictEqual(getUpdaterState().status, 'available', 'The state must show the available update');

  // Trigger another background check -> must NOT prompt again in same session
  clearDialogHistory();
  await checkForUpdates({ manual: false, window: mockWindow, customUpdater: mockUpdater });
  mockUpdater.emit('update-available', { version: '1.0.1' });
  await new Promise(r => setTimeout(r, 10));

  assert.strictEqual(dialogBoxCalls.length, 0, 'Subsequent background check must not prompt user after declining');
  console.log('✓ Test 5: User declining update ("Later") stops download and suppresses repeat prompts in same session');
}

// -------------------------------------------------------------
// Test 6: Update Available - User Accepts Download ("Download Now")
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  app.isPackaged = true;
  dialogResponseIndex = 0; // User clicks 'Download Now' (index 0)

  await checkForUpdates({ manual: false, window: mockWindow, customUpdater: mockUpdater });
  mockUpdater.emit('update-available', { version: '1.0.1' });
  await new Promise(r => setTimeout(r, 10));

  assert.strictEqual(dialogBoxCalls.length, 1);
  assert.strictEqual(mockUpdater.downloadUpdateCalled, true, 'downloadUpdate MUST be called when user accepts');
  console.log('✓ Test 6: User accepting update ("Download Now") initiates downloadUpdate()');
}

// -------------------------------------------------------------
// Test 7: Download Progress
// -------------------------------------------------------------
{
  resetUpdaterState();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  mockUpdater.emit('download-progress', { percent: 45.7 });
  assert.strictEqual(mockWindow.getTitle(), 'QA Test Case Generator (Downloading update: 46%)');
  assert.strictEqual(getUpdaterState().status, 'downloading', 'The state must be downloading');
  assert.strictEqual(getUpdaterState().percent, 46, 'The progress must be reported');

  mockUpdater.emit('download-progress', { percent: 99.2 });
  assert.strictEqual(mockWindow.getTitle(), 'QA Test Case Generator (Downloading update: 99%)');
  console.log('✓ Test 7: Download progress updates window title cleanly');
}

// -------------------------------------------------------------
// Test 8: Update Downloaded - User Declines Restart ("Later")
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  dialogResponseIndex = 1; // User clicks 'Later' on restart prompt

  mockUpdater.emit('update-downloaded', { version: '1.0.1' });
  await new Promise(r => setTimeout(r, 10));

  assert.strictEqual(mockWindow.getTitle(), 'QA Test Case Generator', 'Window title restored');
  assert.strictEqual(dialogBoxCalls.length, 1, 'Prompt shown asking user to restart');
  assert.strictEqual(mockUpdater.quitAndInstallCalled, false, 'quitAndInstall must NOT be called if user clicked Later');
  assert.strictEqual(getUpdaterState().updateDownloaded, true, 'updateDownloaded must remain true');
  assert.strictEqual(getUpdaterState().status, 'downloaded', 'The state must show the ready to install update');
  console.log('✓ Test 8: User declining restart keeps update downloaded without forcing quit');
}

// -------------------------------------------------------------
// Test 9: Update Downloaded - User Accepts Restart ("Restart & Install")
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  dialogResponseIndex = 0; // User clicks 'Restart & Install'

  mockUpdater.emit('update-downloaded', { version: '1.0.1' });
  await new Promise(r => setTimeout(r, 10));

  assert.strictEqual(dialogBoxCalls.length, 1);
  assert.strictEqual(mockUpdater.quitAndInstallCalled, true, 'quitAndInstall MUST be called');
  assert.strictEqual(mockUpdater.quitArgs.isSilent, false);
  assert.strictEqual(mockUpdater.quitArgs.isForceRunAfter, true);
  console.log('✓ Test 9: User accepting restart triggers quitAndInstall(false, true)');
}

// -------------------------------------------------------------
// Test 10: Network Failure / Error Handling
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  app.isPackaged = true;

  // Background error -> no popup
  await checkForUpdates({ manual: false, window: mockWindow, customUpdater: mockUpdater });
  mockUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  assert.strictEqual(dialogBoxCalls.length, 0, 'Background error must not trigger dialog');
  assert.strictEqual(getUpdaterState().status, 'error', 'The state must be error');

  // Manual check error -> user-friendly dialog
  clearDialogHistory();
  await checkForUpdates({ manual: true, window: mockWindow, customUpdater: mockUpdater });
  mockUpdater.emit('error', new Error('net::ERR_CONNECTION_REFUSED'));
  assert.strictEqual(dialogBoxCalls.length, 1, 'Manual error must trigger friendly warning dialog');
  assert.match(dialogBoxCalls[0].options.title, /Update Check Failed/i);
  console.log('✓ Test 10: Network error is quiet in background and displays friendly dialog on manual check');
}

// -------------------------------------------------------------
// Test 11: A rejected check must not stay in the "checking" state
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  mockUpdater.checkForUpdates = async () => { throw new Error('Cannot reach the update server'); };
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  app.isPackaged = true;

  await checkForUpdates({ manual: true, window: mockWindow, customUpdater: mockUpdater });
  assert.strictEqual(getUpdaterState().isChecking, false, 'The check must not stay running');
  assert.strictEqual(getUpdaterState().status, 'error', 'A failed check must be reported as an error');
  assert.strictEqual(dialogBoxCalls.length, 1, 'The user must see why the check failed');
  console.log('✓ Test 11: A failed update check ends in the error state instead of hanging');
}

// -------------------------------------------------------------
// Test 12: Concurrency Guards
// -------------------------------------------------------------
{
  resetUpdaterState();
  clearDialogHistory();
  const mockUpdater = new MockAutoUpdater();
  initUpdater({ window: mockWindow, customUpdater: mockUpdater });

  app.isPackaged = true;

  // Start check
  await checkForUpdates({ manual: false, window: mockWindow, customUpdater: mockUpdater });
  assert.strictEqual(getUpdaterState().isChecking, true);

  // Attempt second concurrent check -> blocked
  mockUpdater.checkForUpdatesCalled = false;
  await checkForUpdates({ manual: false, window: mockWindow, customUpdater: mockUpdater });
  assert.strictEqual(mockUpdater.checkForUpdatesCalled, false, 'Concurrent check must be blocked');
  console.log('✓ Test 12: Concurrency guard blocks duplicate update checks while check is active');
}

// -------------------------------------------------------------
// Test 13: Version comparison
// -------------------------------------------------------------
{
  assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1);
  console.log('✓ Test 13: Versions are compared numerically');
}

// -------------------------------------------------------------
// Test 14: The feed check of a repository that does not exist
// -------------------------------------------------------------
{
  const result = await checkFeed({
    owner: 'mangubatjhonby022002-commits',
    repo: 'qa-test-case-generator-releases',
    currentVersion: '1.0.0',
    fetchImpl: async () => new Response('{}', { status: 404 })
  });
  assert.strictEqual(result.status, 'error', 'A missing repository must be an error');
  assert.match(result.message, /not found/i);
  console.log('✓ Test 14: A missing update feed is reported as an error, never as up to date');
}

app.isPackaged = false;

console.log('--- ALL 14 AUTO-UPDATER TESTS PASSED SUCCESSFULLY ---');
