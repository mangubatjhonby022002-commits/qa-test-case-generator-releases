const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_CHARS = 150000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MODE_RULES = {
  smoke: `MODE = SMOKE
- Only POSITIVE happy-path scenarios that prove the core functionality works end to end.
- Roughly one test case per main requirement or issue, 15 maximum. No negative, boundary or regression cases.`,
  comprehensive: `MODE = COMPREHENSIVE
- Positive, negative, boundary/edge, field validation, mandatory fields, dropdown behaviour, permissions/roles,
  data consistency, UI, integration where relevant, and REGRESSION cases for existing functionality that may be affected.
- Enough cases for meaningful coverage (about 6-25 for a short input, more for a detailed BRD) without duplicates
  or unrelated scenarios.`
};

function buildPrompt({ text, inputType, sourceName, moduleHint, portalHint, mode }) {
  return `You are a senior QA analyst for a property-management web platform that has an Admin Portal and a Resident (Tenant) Portal.
Turn the INPUT into manual test cases plus automation commands. You are a QA analyst, not a document converter.

INPUT TYPE: ${inputType}
SOURCE: ${sourceName}
MODULE HINT: ${moduleHint || '(none - determine it from the input)'}
PORTAL HINT: ${portalHint && portalHint !== 'Auto' ? portalHint : '(none - determine it from the input)'}

The input can be a full BRD or only a short issue summary, bug description, feature overview or change request (CRF) summary.
Its length must not stop you: use your QA knowledge of the described functionality.
Do NOT turn each sentence into one test case. Analyse the purpose, expected behaviour, possible failure points and test conditions.

Process:
1. Identify the affected module, feature, portal and functionality.
2. Find the main requirement or issue to validate and the expected behaviour stated in the input.
3. Write positive scenarios (valid input, successful operation) and, where applicable, negative, boundary, validation,
   dropdown, permission, data-consistency, UI, integration and regression scenarios (see MODE).
4. Write detailed manual test cases: specific, independent, verifiable, no duplicates.

Missing or ambiguous information:
- Work with what is given. Cover behaviour that can reasonably be determined from the input.
- List every assumption you made in "assumptions".
- If the expected behaviour is not specified, start that expected result with "[Needs clarification]" and also list it in "clarifications".
  Never invent a definite business rule, an exact dropdown option list, credentials, account names, URLs, file paths or production data.
- Use placeholders in angle brackets for missing test data, e.g. <VALID_ITEM_DESCRIPTION>, <SKU_NUMBER>.
- Do not write login test cases: a standard Login test case already exists on every sheet. Assume the user is logged in and say so in preconditions.

${MODE_RULES[mode]}

Automation commands - use ONLY this syntax, in execution order, derived from the test steps:
  click: <button/link/element label>        text: <field label>, <value>        dropdown: <field label>, <option>
  link: <url>                                calendar: <field label>, MM/DD/YYYY  checkbox: <label>, ON  (or OFF)
  icon: <icon name>                          upload: <field label>, <file path>   sleep: <seconds>
  Login: <field>, <value>   (only for username/email/password - the login workflow is added automatically, do not include it)
- Use real labels from the input when known; otherwise a placeholder like <SEARCH_BUTTON>. Never invent values.
- Steps that cannot be expressed with these commands: leave them out and describe the limitation in "automationNotes". No other syntax.

Return ONLY JSON in exactly this shape:
{"moduleName":"","portals":["Admin Portal"],"assumptions":[""],"clarifications":[""],
 "testCases":[{"portal":"Admin Portal","scenario":"","title":"","category":"Positive","priority":"High","requirementRef":"",
   "preconditions":"","steps":"1. ...\\n2. ...","testData":"","expectedResult":"1. ...\\n2. ...",
   "automation":["click: ..."],"automationNotes":""}]}
Field rules: "portal" is "Admin Portal" or "Resident Portal" (one per test case; if the input applies to both portals and the workflow differs, write separate cases).
"scenario" groups related test cases (same text for the same scenario). "title" is the specific test case name.
"category" is Positive, Negative, Boundary, Validation, Regression, UI or Integration.
"steps" and "expectedResult" are numbered lists, each item on its own line.

INPUT:
"""
${text}
"""`;
}


// ---- Classic prompt: full BRDs. Short, clean, one module per BRD. ----
const CLASSIC_RULES = {
  smoke: `MODE = SMOKE
- Only POSITIVE happy-path scenarios that prove each core functional requirement works end to end.
- Roughly 1 test case per functional requirement, 15 maximum in total.
- No negative, boundary or edge cases. Every "type" must be "Positive".`,
  comprehensive: `MODE = COMPREHENSIVE
- Cover EVERY functional requirement with both POSITIVE and NEGATIVE scenarios.
- Include where the BRD supports them: field validations, mandatory fields, boundary values, invalid input,
  role/permission checks, error messages, state/status transitions, search/filter/sort behaviour, and integration points.
- "type" must be "Positive" or "Negative".`
};

const AUTOMATION_RULES = `
Automation commands - for EVERY test case add "automation": the commands that perform its steps, in the same order, using ONLY this syntax:
  click: <button/link/element label>        text: <field label>, <value>        dropdown: <field label>, <option>
  link: <url>                                calendar: <field label>, MM/DD/YYYY  checkbox: <label>, ON  (or OFF)
  icon: <icon name>                          upload: <field label>, <file path>   sleep: <seconds>
- Do NOT include the login steps (added automatically). Start from the first step after login.
- Use the real field/button labels from the test steps. If a value is unknown use a placeholder like <SEARCH_TEXT>. Never invent URLs, credentials, dropdown options or file paths.
- A step that cannot be written with these commands is left out; describe it briefly in "automationNotes". No other syntax.`;

function buildClassicPrompt({ text, mode, automation = false }) {
  return `You are a senior QA engineer writing test cases from a Business Requirements Document (BRD).

${CLASSIC_RULES[mode]}

Rules:
- Base test cases ONLY on the functional requirements stated in the BRD. Do not invent features.
- Ignore pure non-functional content (performance, hosting) unless it describes visible behaviour.
- Each test case must be specific, independent and verifiable. No duplicates.
- "steps" is a numbered list as one string, with each step on its own line ("1. ...\\n2. ...").
- "expectedResult" is also a numbered list as one string: one verifiable outcome per line ("1. ...\\n2. ..."), matching the steps.
- "requirementRef" is the requirement ID/section from the BRD (or a short requirement name if there is no ID).
- "module" is the TEST SCENARIO (feature or function group, e.g. "Add Checklist"). Test cases of the same scenario must use the exact same text.
- "title" is the specific test case name (e.g. "Add checklist with all required fields").
- "priority" is High, Medium or Low.
${automation ? AUTOMATION_RULES : ''}
Return ONLY JSON in this exact shape:
{"testCases":[{"requirementRef":"","module":"","title":"","type":"Positive","priority":"High","preconditions":"","steps":"","testData":"","expectedResult":""${automation ? ',"automation":["click: ..."],"automationNotes":""' : ''}}]}

BRD:
"""
${text}
"""`;
}

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is missing. Add it to your .env file.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(300000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 32768),
          ...(process.env.GEMINI_THINKING_LEVEL
            ? { thinkingConfig: { thinkingLevel: process.env.GEMINI_THINKING_LEVEL } }
            : {})
        }
      })
    });
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Gemini busy (HTTP ${res.status})`);
      await sleep(2500 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    const cand = data.candidates?.[0];
    return { text: (cand?.content?.parts || []).map(p => p.text || '').join(''), finish: cand?.finishReason || data.promptFeedback?.blockReason || '' };
  }
  throw lastErr;
}

// Parse the model's JSON. Handles code fences, text around the JSON, and output that was cut off
// (keeps every complete test case that arrived).
function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = t.search(/[\[{]/);
  if (start > 0) t = t.slice(start);
  try { return { value: JSON.parse(t), repaired: false }; } catch (_) {}
  const close = t.startsWith('[') ? ']' : ']}';
  let pos = t.length;
  for (let i = 0; i < 80; i++) {
    pos = t.lastIndexOf('},', pos - 1);
    if (pos < 0) break;
    try { return { value: JSON.parse(t.slice(0, pos + 1) + close), repaired: true }; } catch (_) {}
  }
  throw new Error('invalid json');
}

// One retry, clear error message, and the raw reply start/end in the terminal for debugging.
async function generateJson(prompt, label) {
  let last = {};
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text, finish } = await callGemini(prompt);
    try {
      const r = parseJson(text);
      return { ...r, truncated: r.repaired || finish === 'MAX_TOKENS' };
    } catch (_) {
      last = { finish, len: text.length };
      console.error(`[${label}] attempt ${attempt}: invalid JSON (finishReason=${finish || '?'}, ${text.length} chars). Start: ${text.slice(0, 160)} ... End: ${text.slice(-160)}`);
    }
  }
  const tooLong = last.finish === 'MAX_TOKENS' || last.len === 0;
  throw new Error(`AI response was not valid JSON (finish reason: ${last.finish || 'unknown'}). ` + (tooLong
    ? 'The answer ran out of space. Try Smoke mode, split the BRD, set AUTOMATION_SHEET=off, or set GEMINI_THINKING_LEVEL=low in .env.'
    : 'Try again.'));
}

const str = v => Array.isArray(v)
  ? v.map((s, i) => (/^\d+[.)]/.test(String(s).trim()) ? String(s).trim() : `${i + 1}. ${s}`)).join('\n')
  : String(v ?? '').trim();
const list = v => (Array.isArray(v) ? v : v ? [v] : []).map(s => String(s).trim()).filter(Boolean);
const normPortal = (p, fallback) => (/resident|tenant/i.test(String(p)) ? 'Resident Portal' : /admin/i.test(String(p)) ? 'Admin Portal' : fallback);

// Full BRDs (files, links, "BRD text") use the classic prompt. Short pasted items (issue summary, feature
// description, CRF ...) use the QA-analyst prompt. Returns { moduleName, assumptions, clarifications, testCases[] }.
const CLASSIC_TYPES = new Set(['BRD document', 'BRD text']);

async function analyzeInput({ text, inputType = 'BRD document', sourceName = '', moduleHint = '', portalHint = 'Auto', mode = 'comprehensive', automation = false }) {
  const classic = CLASSIC_TYPES.has(inputType);
  const body = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const prompt = classic
    ? buildClassicPrompt({ text: body, mode, automation })
    : buildPrompt({ text: body, inputType, sourceName, moduleHint, portalHint, mode });
  const { value: parsed, truncated } = await generateJson(prompt, sourceName || 'input');
  const hinted = /resident|tenant/i.test(portalHint) ? 'Resident Portal' : /admin/i.test(portalHint) ? 'Admin Portal' : null;
  const fallback = hinted || normPortal((parsed.portals || [])[0], 'Admin Portal');
  const cases = (Array.isArray(parsed) ? parsed : parsed.testCases || []).map(t => ({
    portal: hinted || (classic ? 'Admin Portal' : normPortal(t.portal, fallback)),
    scenario: str(classic ? t.module : t.scenario) || 'General',
    title: str(t.title),
    category: mode === 'smoke' ? 'Positive' : str(classic ? t.type : t.category) || 'Positive',
    priority: str(t.priority) || 'Medium',
    requirementRef: str(t.requirementRef),
    preconditions: str(t.preconditions),
    steps: str(t.steps),
    testData: str(t.testData),
    expectedResult: str(t.expectedResult),
    automation: list(t.automation),
    automationNotes: str(t.automationNotes)
  })).filter(t => t.title);
  return {
    moduleName: str(moduleHint) || (classic ? '' : str(parsed.moduleName)) || sourceName || 'Module',
    assumptions: classic ? [] : list(parsed.assumptions),
    clarifications: [...(classic ? [] : list(parsed.clarifications)),
      ...(truncated ? ['The AI answer was cut off, so some test cases may be missing. Try Smoke mode or split this BRD into smaller parts.'] : [])],
    testCases: cases
  };
}

module.exports = { analyzeInput };
