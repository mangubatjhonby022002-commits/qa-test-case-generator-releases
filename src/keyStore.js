// Stores the QA user's own Gemini API key, encrypted with the operating system key store
// (Electron safeStorage = DPAPI on Windows). The key never leaves the main process in plain text:
// it is decrypted here, handed to the generator through the environment, and never sent back to the page.
//
// The file lives in the per-user app data folder, so every Windows user has their own key.
const fs = require('fs');
const path = require('path');

const KEY_FILE = 'gemini-key.bin';
const KEY_RE = /^[A-Za-z0-9_\-.]{10,200}$/;      // Gemini keys: no spaces, no control characters

function electronPart(name) {
  try {
    const e = require('electron');
    if (e && typeof e === 'object' && e[name]) return e[name];
  } catch (_) {}
  return null;
}

// A key store for one Windows user.
// safeStorage: Electron's safeStorage (null in plain Node / when the OS key store is unavailable).
// dir:         the per-user data folder the encrypted key is written to.
function createKeyStore({ safeStorage = electronPart('safeStorage'), dir = null, env = process.env, log = console } = {}) {
  // The user data folder is only read when it is needed, so the store can be created before the app is ready.
  const resolveDir = () => dir || (electronPart('app') ? electronPart('app').getPath('userData') : null);
  const resolveFile = () => { const d = resolveDir(); return d ? path.join(d, KEY_FILE) : null; };
  const envKeyAtStart = typeof env.GEMINI_API_KEY === 'string' ? env.GEMINI_API_KEY.trim() : '';

  const encryptionAvailable = () => Boolean(safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable());

  // The key that is currently in use: the one saved in the app first, the one from .env as fallback.
  function get() {
    const filePath = resolveFile();
    if (filePath && encryptionAvailable() && fs.existsSync(filePath)) {
      try {
        const key = safeStorage.decryptString(fs.readFileSync(filePath));
        if (key) return key.trim();
      } catch (err) {
        log.warn('[Settings] The saved API key could not be read:', err.message);
      }
    }
    return envKeyAtStart || '';
  }

  // Where the key in use comes from - never the key itself.
  function status() {
    const filePath = resolveFile();
    const saved = Boolean(filePath && encryptionAvailable() && fs.existsSync(filePath));
    const key = get();
    return {
      configured: Boolean(key),
      source: saved ? 'app' : (key ? 'env' : 'none'),
      secureStorage: encryptionAvailable(),
      storagePath: filePath,
      model: env.GEMINI_MODEL || 'gemini-3.8-flash'
    };
  }

  // Saves the key encrypted. Without a working OS key store nothing is written - a plain text
  // fallback would put the key on disk unprotected, so it is refused with an explanation.
  function save(key) {
    const value = String(key == null ? '' : key).trim();
    if (!value) return { ok: false, error: 'Enter your Gemini API key first.' };
    if (!KEY_RE.test(value)) return { ok: false, error: 'That does not look like a Gemini API key (letters, digits, - and _ only).' };
    if (!encryptionAvailable()) {
      return { ok: false, error: 'Secure key storage is not available on this system, so the key was not saved. Windows key storage (DPAPI) is needed - it works for signed-in Windows users.' };
    }
    const filePath = resolveFile();
    if (!filePath) return { ok: false, error: 'No user data folder available to store the key.' };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, safeStorage.encryptString(value));
      env.GEMINI_API_KEY = value;                 // the generator reads the key from the environment
      return { ok: true, status: status() };
    } catch (err) {
      return { ok: false, error: `The key could not be saved: ${err.message}` };
    }
  }

  // Removes the saved key. The key from .env (if any) stays, because that file belongs to the user.
  function clear() {
    const filePath = resolveFile();
    if (filePath && fs.existsSync(filePath)) {
      try { fs.rmSync(filePath); }
      catch (err) { return { ok: false, error: `The key could not be removed: ${err.message}` }; }
    }
    if (env.GEMINI_API_KEY === envKeyAtStart) delete env.GEMINI_API_KEY;
    else env.GEMINI_API_KEY = envKeyAtStart;        // back to the .env key, if there is one
    return { ok: true, status: status() };
  }

  // Makes the key that is in use available to the generator.
  function applyToEnv() {
    const key = get();
    if (key) env.GEMINI_API_KEY = key;
    else delete env.GEMINI_API_KEY;
    return key;
  }

  return { get, status, save, clear, applyToEnv, storagePath: resolveFile() };
}

let instance = null;
// The store used by the running app.
function getKeyStore() {
  if (!instance) instance = createKeyStore();
  return instance;
}

module.exports = { createKeyStore, getKeyStore, KEY_FILE, KEY_RE };
