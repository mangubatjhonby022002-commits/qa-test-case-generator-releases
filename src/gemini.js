// Minimal Gemini API calls that are used to check the API key.
// The key is only ever sent in the x-goog-api-key header - never in a URL, never logged.
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

// Checks the key with the smallest possible request: list the models the key can reach.
// No BRD text, no user data - only the key itself.
async function testConnection(key, { fetchImpl = globalThis.fetch, model = process.env.GEMINI_MODEL || 'gemini-3.8-flash' } = {}) {
  if (!key || !String(key).trim()) return { ok: false, message: 'No API key configured yet.' };
  if (typeof fetchImpl !== 'function') return { ok: false, message: 'No network access available.' };

  let res;
  try {
    res = await fetchImpl(MODELS_URL, { method: 'GET', headers: { 'x-goog-api-key': String(key).trim() } });
  } catch (err) {
    return { ok: false, message: `Could not reach Google's Gemini API: ${err.message}` };
  }

  if (res.status === 200) {
    let names = [];
    try {
      const data = await res.json();
      names = (data?.models || []).map(m => String(m?.name || '').replace(/^models\//, ''));
    } catch (_) {}
    const hasModel = names.length ? names.includes(model) : null;
    return {
      ok: true,
      message: names.length
        ? `Connection successful. The key can reach ${names.length} model(s)${hasModel === false ? `, but "${model}" is not among them` : ''}.`
        : 'Connection successful. The key was accepted by the Gemini API.'
    };
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    return { ok: false, message: `Google rejected the API key (HTTP ${res.status}). Check the key and try again.` };
  }
  if (res.status === 429) {
    return { ok: false, message: 'The Gemini API is rate limited right now (HTTP 429). The key may be fine - try again in a minute.' };
  }
  return { ok: false, message: `The connection test failed (HTTP ${res.status}).` };
}

module.exports = { testConnection, MODELS_URL };
