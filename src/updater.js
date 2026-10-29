const electron = require('electron');

// In Electron runtime, electron is an object containing app, dialog, BrowserWindow.
// In plain Node.js test runners, require('electron') returns the path string to the electron binary.
const app = typeof electron === 'object' && electron?.app
  ? electron.app
  : { isPackaged: false, getVersion: () => '1.0.0' };

const dialog = typeof electron === 'object' && electron?.dialog
  ? electron.dialog
  : { showMessageBox: async () => ({ response: 0 }) };

const BrowserWindow = typeof electron === 'object' && electron?.BrowserWindow
  ? electron.BrowserWindow
  : class { static getFocusedWindow() { return null; } };

let _autoUpdater = null;
function getAutoUpdaterInstance() {
  if (!_autoUpdater) {
    try {
      const { autoUpdater } = require('electron-updater');
      _autoUpdater = autoUpdater;
    } catch (err) {
      console.warn('[AutoUpdater] Failed to instantiate electron-updater:', err.message);
    }
  }
  return _autoUpdater;
}

/**
 * Manages desktop application updates using a separate public GitHub Releases repository.
 *
 * Requirements:
 * - Public releases repository: mangubatjhonby022002-commits/qa-test-case-generator-releases
 * - Zero embedded tokens: Public releases repository requires no client credentials.
 * - Non-intrusive: Background checks on startup are silent if no update is available.
 * - User control: Confirms before downloading; confirms before installing and restarting.
 * - Safe concurrency: Prevents duplicate prompts and concurrent update calls.
 */

const REPO_OWNER = 'mangubatjhonby022002-commits';
const REPO_NAME = 'qa-test-case-generator-releases';

let activeWindow = null;
let isChecking = false;
let isDownloading = false;
let updateDownloaded = false;
let userDeclinedDownload = false;
let isManualCheck = false;
let lastDownloadedVersion = null;

// The state of the update flow - the page shows it, the menu shows it in dialogs.
// 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'
let state = { status: 'idle', message: '', version: '', percent: 0 };
let stateListener = null;

// The main process pushes every state change to the page.
function onState(callback) {
  stateListener = typeof callback === 'function' ? callback : null;
}

function setState(patch) {
  state = { ...state, ...patch };
  if (stateListener) {
    try { stateListener({ ...state }); } catch (_) {}
  }
  return { ...state };
}

function getTargetWindow() {
  if (activeWindow && !activeWindow.isDestroyed()) return activeWindow;
  return BrowserWindow.getFocusedWindow() || null;
}

// 1.0.10 is newer than 1.0.9 - compares the numbers of the version parts.
function compareVersions(a, b) {
  const pa = String(a || '').split(/[.+-]/).map(p => parseInt(p, 10) || 0);
  const pb = String(b || '').split(/[.+-]/).map(p => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Reads the release feed of the repository - the same source the packaged app downloads from.
// Used for the check in a development build, where electron-updater has no app-update.yml to read.
async function checkFeed({ owner = REPO_OWNER, repo = REPO_NAME, currentVersion = app.getVersion(), fetchImpl = globalThis.fetch, token = process.env.GH_TOKEN } = {}) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'qa-test-case-generator-updater',
        'Accept': 'application/vnd.github+json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    });
  } catch (err) {
    return { status: 'error', version: '', percent: 0, message: `Could not reach the update server: ${err.message}` };
  }

  if (res.status === 404) {
    // A 404 here means either "no repository (or not public)" or "the repository exists but has
    // no release yet". Both are common, so the repository is asked once to tell them apart.
    let repoReachable = false;
    try {
      const repoRes = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
          'User-Agent': 'qa-test-case-generator-updater',
          'Accept': 'application/vnd.github+json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        }
      });
      repoReachable = repoRes.ok;
    } catch (_) {}
    return {
      status: 'error', version: '', percent: 0,
      message: repoReachable
        ? `The repository ${owner}/${repo} is reachable, but it has no release yet. Publish the installer, latest.yml and the .exe.blockmap as a release there - then the app finds the update.`
        : `The update feed ${owner}/${repo} was not found (HTTP 404). It has to be a public releases repository, or GH_TOKEN must be set in .env for a private one.`
    };
  }
  if (res.status === 403) {
    return { status: 'error', version: '', percent: 0, message: 'GitHub refused the update check (HTTP 403) - the repository is private or the rate limit was reached. Set GH_TOKEN in .env for a private releases repository.' };
  }
  if (res.status === 429) {
    return { status: 'error', version: '', percent: 0, message: 'The update check was rate limited by GitHub (HTTP 429). Try again later.' };
  }
  if (!res.ok) {
    return { status: 'error', version: '', percent: 0, message: `The update check failed (HTTP ${res.status}).` };
  }

  let data;
  try { data = await res.json(); }
  catch (_) { return { status: 'error', version: '', percent: 0, message: 'The update server returned an answer that could not be read.' }; }

  const latest = String(data?.tag_name || data?.name || '').trim().replace(/^v/i, '');
  if (!latest) return { status: 'error', version: '', percent: 0, message: 'The update server did not return a version number.' };

  if (compareVersions(latest, currentVersion) > 0) {
    return { status: 'available', version: latest, percent: 0, message: `Version ${latest} is available (you have ${currentVersion}).` };
  }
  return { status: 'up-to-date', version: currentVersion, percent: 0, message: `You are on the latest version (${currentVersion}).` };
}

function initUpdater({ window = null, customUpdater = null } = {}) {
  const updater = customUpdater || getAutoUpdaterInstance();
  if (window) activeWindow = window;
  if (!updater) {
    console.warn('[AutoUpdater] The updater is not available, automatic updates are disabled.');
    setState({ status: 'error', message: 'The updater is not available in this build.', percent: 0 });
    return null;
  }

  // 1. Enforce user control: never auto-download or force-restart
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  // 2. Configure public release feed
  try {
    updater.setFeedURL({
      provider: 'github',
      owner: REPO_OWNER,
      repo: REPO_NAME
    });
  } catch (err) {
    console.warn('[AutoUpdater] Failed to set feed URL:', err.message);
  }

  // 3. Event: Update Available
  updater.on('update-available', async (info) => {
    isChecking = false;
    const version = info?.version || 'new';
    setState({ status: 'available', version, percent: 0, message: `Version ${version} is available.` });

    // If user already declined in this session and this was a background check, do not nag
    if (userDeclinedDownload && !isManualCheck) return;

    const targetWin = getTargetWindow();
    const choice = await dialog.showMessageBox(targetWin, {
      type: 'info',
      title: 'Update Available',
      message: 'A new version of QA Test Case Generator is available!',
      detail: `Version ${version} is now available (current version is ${app.getVersion()}).\n\nWould you like to download this update now?`,
      buttons: ['Download Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });

    if (choice.response === 0) {
      isDownloading = true;
      userDeclinedDownload = false;
      setState({ status: 'downloading', version, percent: 0, message: `Downloading version ${version}…` });
      try {
        await updater.downloadUpdate();
      } catch (dlErr) {
        isDownloading = false;
        setState({ status: 'error', message: `The update could not be downloaded: ${dlErr.message}`, percent: 0 });
        dialog.showMessageBox(targetWin, {
          type: 'warning',
          title: 'Download Failed',
          message: 'Could not download the update',
          detail: 'Please check your internet connection and try again later.',
          buttons: ['OK']
        });
      }
    } else {
      userDeclinedDownload = true;
    }
    isManualCheck = false;
  });

  // 4. Event: Update Not Available
  updater.on('update-not-available', (info) => {
    isChecking = false;
    setState({ status: 'up-to-date', version: info?.version || app.getVersion(), percent: 0, message: 'You are on the latest version.' });
    // Only inform user if they manually asked to check
    if (isManualCheck) {
      dialog.showMessageBox(getTargetWindow(), {
        type: 'info',
        title: 'Up to Date',
        message: 'QA Test Case Generator is up to date',
        detail: `You are running the latest version (${app.getVersion()}).`,
        buttons: ['OK']
      });
    }
    isManualCheck = false;
  });

  // 5. Event: Download Progress
  updater.on('download-progress', (progressObj) => {
    const percent = Math.round(progressObj?.percent || 0);
    setState({ status: 'downloading', version: lastDownloadedVersion || '', percent, message: `Downloading the update… ${percent}%` });
    const win = getTargetWindow();
    if (win && !win.isDestroyed()) {
      win.setTitle(`QA Test Case Generator (Downloading update: ${percent}%)`);
    }
  });

  // 6. Event: Update Downloaded (Prompt user to restart or postpone)
  updater.on('update-downloaded', async (info) => {
    isDownloading = false;
    updateDownloaded = true;
    lastDownloadedVersion = info?.version || 'latest';

    const win = getTargetWindow();
    if (win && !win.isDestroyed()) {
      win.setTitle('QA Test Case Generator');
    }
    setState({ status: 'downloaded', version: lastDownloadedVersion, percent: 100, message: `Version ${lastDownloadedVersion} is downloaded and ready to install.` });

    const choice = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Update Ready to Install',
      message: `Version ${lastDownloadedVersion} has been downloaded`,
      detail: 'The update is ready to install. Would you like to restart the application now to apply this update?',
      buttons: ['Restart & Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });

    if (choice.response === 0) {
      updater.quitAndInstall(false, true);
    }
    // If choice.response === 1 ('Later'), do nothing; downloaded update stays ready on disk.
  });

  // 7. Event: Error
  updater.on('error', (err) => {
    isChecking = false;
    isDownloading = false;

    const win = getTargetWindow();
    if (win && !win.isDestroyed()) {
      win.setTitle('QA Test Case Generator');
    }
    const message = err?.message ? `The update failed: ${err.message}` : 'The update failed.';
    setState({ status: 'error', message, percent: 0 });

    // Only show popup for manual checks; background failures log quietly
    if (isManualCheck) {
      dialog.showMessageBox(win, {
        type: 'warning',
        title: 'Update Check Failed',
        message: 'Unable to check for updates',
        detail: `${message}\n\nAn update check needs a reachable releases repository (${REPO_OWNER}/${REPO_NAME}).`,
        buttons: ['OK']
      });
    } else {
      console.warn('[AutoUpdater] Background update check failed:', err?.message || err);
    }
    isManualCheck = false;
  });

  return updater;
}

async function checkForUpdates({ manual = false, window = null, customUpdater = null } = {}) {
  if (window) activeWindow = window;
  const updater = customUpdater || getAutoUpdaterInstance();

  // Development build: electron-updater has no app-update.yml to read, so the release feed of the
  // repository is read directly. Installing is done by the packaged app.
  if (!app.isPackaged) {
    if (isChecking) return { ...state };
    isChecking = true;
    isManualCheck = Boolean(manual);
    setState({ status: 'checking', message: 'Checking for updates…', percent: 0, version: '' });
    const result = await checkFeed();
    isChecking = false;
    isManualCheck = false;
    setState(result);
    if (manual) {
      if (result.status === 'available') {
        await dialog.showMessageBox(getTargetWindow(), {
          type: 'info',
          title: 'Update Available',
          message: `Version ${result.version} is available.`,
          detail: 'You are running a development build, so the update cannot be installed from here. Build the packaged app with "npm run dist" or install the new version from the releases page.',
          buttons: ['OK']
        });
      } else if (result.status === 'up-to-date') {
        await dialog.showMessageBox(getTargetWindow(), {
          type: 'info',
          title: 'Up to Date',
          message: 'QA Test Case Generator is up to date',
          detail: result.message,
          buttons: ['OK']
        });
      } else {
        await dialog.showMessageBox(getTargetWindow(), {
          type: 'warning',
          title: 'Update Check Failed',
          message: 'Unable to check for updates',
          detail: result.message,
          buttons: ['OK']
        });
      }
    }
    return { ...state };
  }

  // Packaged build: electron-updater downloads and installs the release.
  if (!updater) {
    const result = { status: 'error', message: 'The updater is not available in this build.', percent: 0, version: '' };
    setState(result);
    if (manual) {
      await dialog.showMessageBox(getTargetWindow(), {
        type: 'warning', title: 'Update Check Failed', message: 'Unable to check for updates', detail: result.message, buttons: ['OK']
      });
    }
    return { ...state };
  }

  // Guard: Download currently in progress
  if (isDownloading) {
    if (manual) {
      await dialog.showMessageBox(getTargetWindow(), {
        type: 'info',
        title: 'Download in Progress',
        message: 'An update is already downloading',
        detail: 'Please wait until the current download finishes.',
        buttons: ['OK']
      });
    }
    return { ...state };
  }

  // Guard: Update already downloaded and waiting for restart
  if (updateDownloaded) {
    if (manual) {
      await dialog.showMessageBox(getTargetWindow(), {
        type: 'question',
        title: 'Update Ready to Install',
        message: `Version ${lastDownloadedVersion || 'new'} is already downloaded`,
        detail: 'Would you like to restart the application now to apply this update?',
        buttons: ['Restart & Install', 'Later'],
        defaultId: 0,
        cancelId: 1
      }).then(choice => {
        if (choice.response === 0) updater.quitAndInstall(false, true);
      });
    }
    return { ...state };
  }

  // Guard: Check already in progress
  if (isChecking) {
    if (manual) {
      await dialog.showMessageBox(getTargetWindow(), {
        type: 'info',
        title: 'Check in Progress',
        message: 'Already checking for updates',
        detail: 'Please wait a moment.',
        buttons: ['OK']
      });
    }
    return { ...state };
  }

  isChecking = true;
  isManualCheck = Boolean(manual);
  setState({ status: 'checking', message: 'Checking for updates…', percent: 0, version: '' });

  try {
    await updater.checkForUpdates();
  } catch (err) {
    isChecking = false;
    isManualCheck = false;
    const result = { status: 'error', message: `The update check failed: ${err?.message || err}`, percent: 0, version: '' };
    setState(result);
    if (manual) {
      await dialog.showMessageBox(getTargetWindow(), {
        type: 'warning',
        title: 'Update Check Failed',
        message: 'Unable to check for updates',
        detail: result.message,
        buttons: ['OK']
      });
    }
  }
  return { ...state };
}

function getUpdaterState() {
  return {
    ...state,
    isChecking,
    isDownloading,
    updateDownloaded,
    userDeclinedDownload,
    isManualCheck,
    lastDownloadedVersion,
    repoOwner: REPO_OWNER,
    repoName: REPO_NAME,
    currentVersion: app.getVersion(),
    packaged: app.isPackaged
  };
}

function resetUpdaterState() {
  isChecking = false;
  isDownloading = false;
  updateDownloaded = false;
  userDeclinedDownload = false;
  isManualCheck = false;
  lastDownloadedVersion = null;
  setState({ status: 'idle', message: '', version: '', percent: 0 });
}

module.exports = {
  initUpdater,
  checkForUpdates,
  getUpdaterState,
  resetUpdaterState,
  onState,
  compareVersions,
  checkFeed,
  app,
  dialog,
  REPO_OWNER,
  REPO_NAME
};
