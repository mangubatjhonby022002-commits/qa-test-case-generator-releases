import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createKeyStore } = require('../src/keyStore.js');
const { testConnection } = require('../src/gemini.js');

console.log('--- Starting Settings (Gemini API key) Test Suite ---');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgen-settings-'));
const TEST_KEY = 'AIzaSyTestKey-1234567890abcdef';

// A stand-in for Electron's safeStorage (Windows DPAPI): the key must not be readable in the file.
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: s => Buffer.from([...String(s)].map(c => String.fromCharCode(c.charCodeAt(0) ^ 0x5a)).join(''), 'binary'),
  decryptString: b => [...b.toString('binary')].map(c => String.fromCharCode(c.charCodeAt(0) ^ 0x5a)).join('')
};

// Test 1: the key is saved encrypted, used by the generator and never written in plain text
{
  const env = {};
  const store = createKeyStore({ safeStorage: fakeSafeStorage, dir: path.join(tmp, 'user1'), env });

  assert.strictEqual(store.status().configured, false, 'Test 1 Failed: no key must be configured at the start');

  const saved = store.save(TEST_KEY);
  assert.ok(saved.ok, 'Test 1 Failed: the key must be saved');
  assert.strictEqual(store.status().configured, true, 'Test 1 Failed: the key must be configured');
  assert.strictEqual(store.status().source, 'app', 'Test 1 Failed: the key must come from the app');
  assert.strictEqual(store.get(), TEST_KEY, 'Test 1 Failed: the saved key must be readable');
  assert.strictEqual(env.GEMINI_API_KEY, TEST_KEY, 'Test 1 Failed: the generator must get the key from the environment');

  const onDisk = fs.readFileSync(store.storagePath);
  assert.ok(!onDisk.toString('utf8').includes(TEST_KEY), 'Test 1 Failed: the key must not be stored in plain text');
  assert.ok(onDisk.length > 0, 'Test 1 Failed: the encrypted key must be written');
  console.log('✓ Test 1: The API key is stored encrypted and handed to the generator');
}

// Test 2: the key is per Windows user - two users have two different keys
{
  const storeA = createKeyStore({ safeStorage: fakeSafeStorage, dir: path.join(tmp, 'user1'), env: {} });
  const storeB = createKeyStore({ safeStorage: fakeSafeStorage, dir: path.join(tmp, 'user2'), env: {} });
  storeB.save('AIzaSyAnotherKey-0987654321zzz');

  assert.notStrictEqual(storeA.storagePath, storeB.storagePath, 'Test 2 Failed: every user needs their own file');
  assert.strictEqual(storeA.get(), TEST_KEY, 'Test 2 Failed: the first user must keep their key');
  assert.strictEqual(storeB.get(), 'AIzaSyAnotherKey-0987654321zzz', 'Test 2 Failed: the second user must have their own key');
  console.log('✓ Test 2: Every Windows user has their own encrypted key');
}

// Test 3: clearing removes the saved key
{
  const env = {};
  const store = createKeyStore({ safeStorage: fakeSafeStorage, dir: path.join(tmp, 'user3'), env });
  store.save(TEST_KEY);
  assert.ok(fs.existsSync(store.storagePath), 'Test 3 Failed: the key file must exist');

  const cleared = store.clear();
  assert.ok(cleared.ok, 'Test 3 Failed: clearing must work');
  assert.strictEqual(store.status().configured, false, 'Test 3 Failed: no key must be left');
  assert.ok(!fs.existsSync(store.storagePath), 'Test 3 Failed: the key file must be removed');
  assert.ok(!env.GEMINI_API_KEY, 'Test 3 Failed: the generator must not get a key any more');
  console.log('✓ Test 3: Clearing the key removes the saved credential');
}

// Test 4: without a working key store nothing is written - no plain text fallback
{
  const dir = path.join(tmp, 'user4');
  const store = createKeyStore({ safeStorage: null, dir, env: {} });
  const saved = store.save(TEST_KEY);
  assert.strictEqual(saved.ok, false, 'Test 4 Failed: the key must not be saved without secure storage');
  assert.match(saved.error, /not available/i, 'Test 4 Failed: the user must get an explanation');
  assert.strictEqual(fs.existsSync(path.join(dir, 'gemini-key.bin')), false, 'Test 4 Failed: no file may be written');
  console.log('✓ Test 4: Without secure storage the key is refused instead of stored in plain text');
}

// Test 5: the key from .env is used as a fallback and survives clearing the saved key
{
  const env = { GEMINI_API_KEY: 'AIzaSyEnvKey-1111111111abc' };
  const store = createKeyStore({ safeStorage: fakeSafeStorage, dir: path.join(tmp, 'user5'), env });
  assert.strictEqual(store.status().source, 'env', 'Test 5 Failed: the key must come from .env');

  store.save(TEST_KEY);
  assert.strictEqual(store.status().source, 'app', 'Test 5 Failed: the saved key must win over .env');

  store.clear();
  assert.strictEqual(store.status().source, 'env', 'Test 5 Failed: the .env key must be used again');
  assert.strictEqual(store.get(), 'AIzaSyEnvKey-1111111111abc', 'Test 5 Failed: the .env key must stay');
  console.log('✓ Test 5: The .env key is the fallback and comes back when the saved key is cleared');
}

// Test 6: an invalid key is rejected
{
  const store = createKeyStore({ safeStorage: fakeSafeStorage, dir: path.join(tmp, 'user6'), env: {} });
  assert.strictEqual(store.save('').ok, false, 'Test 6 Failed: an empty key must be refused');
  assert.strictEqual(store.save('abc').ok, false, 'Test 6 Failed: a too short key must be refused');
  assert.strictEqual(store.save('key with spaces and $pecials').ok, false, 'Test 6 Failed: an invalid key must be refused');
  console.log('✓ Test 6: An invalid API key is refused with a message');
}

// Test 7: the connection test sends the key in a header, never in the URL, and never logs it
{
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers });
    return new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const result = await testConnection(TEST_KEY);
    assert.ok(result.ok, 'Test 7 Failed: a working key must be reported as working');
    assert.ok(result.message.length > 0, 'Test 7 Failed: there must be a message');
    assert.ok(!result.message.includes(TEST_KEY), 'Test 7 Failed: the message must not contain the key');
    assert.strictEqual(calls.length, 1, 'Test 7 Failed: exactly one request must be made');
    assert.strictEqual(calls[0].headers['x-goog-api-key'], TEST_KEY, 'Test 7 Failed: the key must be sent in the header');
    assert.ok(!calls[0].url.includes(TEST_KEY), 'Test 7 Failed: the key must not be sent in the URL');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('✓ Test 7: The connection test sends the key in a header and never in the URL');
}

// Test 8: a rejected key is reported as a failure
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 });
  try {
    const result = await testConnection(TEST_KEY);
    assert.strictEqual(result.ok, false, 'Test 8 Failed: a rejected key must be a failure');
    assert.match(result.message, /rejected/i);
    assert.ok(!result.message.includes(TEST_KEY), 'Test 8 Failed: the message must not contain the key');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('✓ Test 8: A rejected API key is reported as a failure without exposing the key');
}

// Test 9: no key at all - the server refuses the run and points to Settings
{
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgen-server-'));
  process.env.APP_TMP_DIR = path.join(dataDir, 'tmp');
  process.env.APP_OUT_DIR = path.join(dataDir, 'output');
  process.env.GEMINI_API_KEY = '';                 // no key for this user
  const { app } = require('../server.js');
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, { method: 'POST' });
    assert.strictEqual(res.status, 400, 'Test 9 Failed: the run must be refused without a key');
    const body = await res.json();
    assert.match(body.error, /API key/i, 'Test 9 Failed: the message must name the missing key');
    assert.match(body.error, /Settings/i, 'Test 9 Failed: the message must point to Settings');
  } finally {
    server.close();
  }
  console.log('✓ Test 9: Without a key the run is refused and the user is sent to Settings');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('--- ALL 9 SETTINGS TESTS PASSED SUCCESSFULLY ---');
