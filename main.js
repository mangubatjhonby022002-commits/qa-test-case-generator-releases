const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// 1. Setup paths based on environment (development vs packaged)
const isPackaged = app.isPackaged;
const userDataPath = app.getPath('userData');
const appDataTmp = path.join(userDataPath, 'tmp');
const appDataOut = path.join(userDataPath, 'output');

// Ensure tmp and output folders exist in writable user data directory
[appDataTmp, appDataOut].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Configure environment paths for server.js
process.env.APP_TMP_DIR = appDataTmp;
process.env.APP_OUT_DIR = appDataOut;

// Resolve default template location
const bundledTemplate = isPackaged
  ? path.join(process.resourcesPath, 'templates', 'TC_Template.xlsx')
  : path.join(__dirname, 'templates', 'TC_Template.xlsx');

if (fs.existsSync(bundledTemplate)) {
  process.env.APP_TEMPLATE_PATH = bundledTemplate;
}

// 2. Load .env securely without bundling keys into app.asar
function loadEnvironment() {
  if (!isPackaged) {
    dotenv.config({ path: path.join(__dirname, '.env') });
    return;
  }

  const envInUserData = path.join(userDataPath, '.env');
  const envNextToExe = path.join(path.dirname(process.execPath), '.env');

  if (fs.existsSync(envInUserData)) {
    dotenv.config({ path: envInUserData });
  } else if (fs.existsSync(envNextToExe)) {
    dotenv.config({ path: envNextToExe });
  } else {
    const sampleEnv = [
      '# Gemini Service Configuration',
      '# Every QA user can also enter the key in the app: Settings -> Gemini API key.',
      '# It is then stored encrypted with the Windows key store (per Windows user).',
      '# GEMINI_API_KEY=',
      '',
      'GEMINI_MODEL=gemini-3.8-flash',
      'CONCURRENCY=3',
      'AUTOMATION_SHEET=off',
      ''
    ].join('\n');
    try {
      fs.writeFileSync(envInUserData, sampleEnv, 'utf8');
    } catch (_) {}
    dotenv.config({ path: envInUserData });
  }
}

loadEnvironment();

// Import server after environment variables and paths are set
const { startServer, cleaner } = require('./server');
const { initUpdater, checkForUpdates, getUpdaterState, onState } = require('./src/updater');
const { getKeyStore } = require('./src/keyStore');
const { testConnection } = require('./src/gemini');

const keyStore = getKeyStore();

let mainWindow = null;
let serverInstance = null;

// The only bridge to the page: the Gemini key and the update state.
// The key itself is never sent back to the page - only whether one is configured.
function registerIpcHandlers() {
  const fromAppWindow = event => Boolean(mainWindow) && event.sender === mainWindow.webContents;

  ipcMain.handle('gemini:status', event => {
    if (!fromAppWindow(event)) return { configured: false, source: 'none', secureStorage: false, storagePath: null, model: '' };
    return keyStore.status();
  });

  ipcMain.handle('gemini:save', (event, key) => {
    if (!fromAppWindow(event)) return { ok: false, error: 'Unknown sender.' };
    return keyStore.save(key);
  });

  ipcMain.handle('gemini:clear', event => {
    if (!fromAppWindow(event)) return { ok: false, error: 'Unknown sender.' };
    return keyStore.clear();
  });

  ipcMain.handle('gemini:test', async (event, key) => {
    if (!fromAppWindow(event)) return { ok: false, message: 'Unknown sender.' };
    const candidate = typeof key === 'string' && key.trim() ? key.trim() : keyStore.get();
    if (!candidate) return { ok: false, message: 'No API key configured yet - enter one first.' };
    return testConnection(candidate);
  });

  ipcMain.handle('updater:check', () => checkForUpdates({ manual: true, window: mainWindow }));
  ipcMain.handle('updater:state', () => getUpdaterState());
}

async function launchApp() {
  let port = Number(process.env.PORT) || 3000;
  const host = '127.0.0.1';

  registerIpcHandlers();

  // The key of this Windows user (encrypted in the app data folder) is used by the generator.
  keyStore.applyToEnv();

  try {
    serverInstance = await startServer({ port, host });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${port} in use, picking random available port...`);
      serverInstance = await startServer({ port: 0, host });
    } else {
      throw err;
    }
  }

  const activePort = serverInstance.port;

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 850,
    minHeight: 620,
    title: 'QA Test Case Generator',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Open external links (Google docs, api keys, etc.) in user default web browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://${host}:${activePort}`)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://${host}:${activePort}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Provide an application menu with access to Config and Output folders
  const templateMenu = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Settings...',
          click: () => {
            if (!mainWindow) return;
            mainWindow.show();
            mainWindow.focus();
            mainWindow.webContents.send('open-settings');
          }
        },
        {
          label: 'Open Config Folder (.env)',
          click: () => shell.openPath(userDataPath)
        },
        {
          label: 'Open Output Folder',
          click: () => shell.openPath(appDataOut)
        },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: () => checkForUpdates({ manual: true, window: mainWindow })
        },
        { type: 'separator' },
        {
          label: 'Get Gemini API Key',
          click: () => shell.openExternal('https://aistudio.google.com/apikey')
        },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About QA Test Case Generator',
              message: 'QA Test Case Generator',
              detail: `Desktop Edition (Version ${app.getVersion()})\nBuilt with Electron and Express.`
            });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(templateMenu));
  await mainWindow.loadURL(`http://${host}:${activePort}`);

  // Every QA user needs their own Gemini API key - it is entered in the app (Settings).
  const keyState = keyStore.status();
  if (!keyState.configured) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Configuration Required',
      message: 'Gemini service is not configured',
      detail: 'To generate test cases, each QA user enters their own Gemini API key in the app:\n\nSettings -> Gemini API key\n\nGet a key at https://aistudio.google.com/apikey',
      buttons: ['OK']
    });
  }

  // Push every update state change to the page
  onState(state => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('updater:event', state);
  });

  // Initialize auto-updater and run silent background check 5 seconds after startup
  initUpdater({ window: mainWindow });
  setTimeout(() => {
    checkForUpdates({ manual: false, window: mainWindow });
  }, 5000);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function cleanupAndQuit() {
  try {
    if (cleaner) cleaner.clearAppDirs();
  } catch (e) {
    console.error('Exit cleanup failed:', e.message);
  }
  if (serverInstance && serverInstance.server) {
    serverInstance.server.close();
  }
}

app.whenReady().then(launchApp);

app.on('window-all-closed', () => {
  cleanupAndQuit();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  cleanupAndQuit();
});
