const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const MAX_CHARS = 150000;
const { outline, sectionText } = require('./sections');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Never more than N Gemini requests at the same time (all inputs and modules share this limit).
let active = 0;
const waiters = [];
async function limited(fn) {
  const max = Number(process.env.AI_CONCURRENCY || process.env.CONCURRENCY || 3);
  while (active >= max) await new Promise(r => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; const w = waiters.shift(); if (w) w(); }
}

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

// ---- Step 1 of a BRD: find the modules (each becomes its own tab) ----
function buildPlanPrompt({ text, outlineText, sourceName }) {
  return `You are a senior QA analyst. Read the BRD and split it into TESTABLE MODULES, because every module gets its own tab in a test case workbook.

A module is a distinct feature area with its own screens and requirements, for example "Equipment", "Dashboard", "Equipment Configuration", "Settings - Equipment Type".
Do not merge different modules into one and do not split one module into several. Use the BRD's own wording for names (drop words like "Overview" or "Module"; keep prefixes such as "Settings - " when the BRD uses them).

For each module return:
- moduleName
- portals: the portals the module is used in ("Admin Portal" and/or "Resident Portal"). Only portals the BRD describes (SBS/Admin portal = "Admin Portal"; resident/tenant app = "Resident Portal"). If the BRD does not say, use ["Admin Portal"].
- sections: the EXACT heading titles from the HEADING OUTLINE that hold this module's content - the highest-level heading of the module (for example "Equipment Module Overview"). Never list repeated sub-headings such as "Functional Requirements" or "Data Dictionary".
- summary: one sentence.
- dependsOn: names of other modules in this BRD that it interacts with (may be empty).
Also return sharedSections: heading titles that apply to ALL modules but are not modules themselves (for example "Permissions"). Do NOT include document admin sections (title page, revision history, table of contents, sign-off) or headings that merely contain all the modules.

Return ONLY JSON: {"modules":[{"moduleName":"","portals":["Admin Portal"],"sections":[""],"summary":"","dependsOn":[""]}],"sharedSections":[""]}

SOURCE: ${sourceName}
HEADING OUTLINE:
${outlineText || '(no headings were detected - decide by reading the text)'}

BRD:
"""
${text}
"""`;
}

// ---- Step 2: test cases for ONE module ----
function buildModulePrompt({ module, moduleText, sharedText, others, mode, automation, whole }) {
  const multi = module.portals.length > 1;
  return `You are a senior QA engineer writing test cases from a Business Requirements Document (BRD).
You are testing ONE module of a larger BRD.

MODULE TO TEST: ${module.moduleName}
PORTAL(S): ${module.portals.join(', ')}
MODULE SUMMARY: ${module.summary || '-'}
OTHER MODULES IN THIS BRD (do not write test cases for them): ${others.join('; ') || '-'}
${module.dependsOn.length ? `THIS MODULE INTERACTS WITH: ${module.dependsOn.join('; ')}\n` : ''}
${CLASSIC_RULES[mode]}

Rules:
- Write test cases ONLY for "${module.moduleName}". ${whole ? 'The whole BRD is given below: ignore the parts that belong to other modules.' : 'Only this module\'s section of the BRD is given below.'}
- Base test cases ONLY on requirements stated in the BRD. Do not invent features, rules, values or messages.
- Use the field names, formats, lengths and mandatory/optional flags from the data dictionary, and use the BRD's exact error/validation messages as expected results.
- Respect the pre-conditions, post-conditions and exclusions: do not test behaviour listed under exclusions.
- Where this module's text refers to another module (a link, a dropdown fed by another module, a dashboard that opens a list), add integration test cases for that interaction.
- If SHARED CONTEXT lists permissions for this module, add a permission test case for each listed permission (the user without it cannot see or use that action) - in Comprehensive mode only.
- Ignore pure non-functional content (performance, hosting) unless it describes visible behaviour.
- Each test case must be specific, independent and verifiable. No duplicates.
- "steps" is a numbered list as one string, with each step on its own line ("1. ...\\n2. ...").
- "expectedResult" is also a numbered list as one string: one verifiable outcome per line ("1. ...\\n2. ..."), matching the steps.
- "requirementRef" is the requirement ID/section from the BRD (or a short requirement name if there is no ID).
- "module" is the TEST SCENARIO (feature or function group inside this module, e.g. "Add Equipment"). Test cases of the same scenario must use the exact same text.
- "title" is the specific test case name.
- "priority" is High, Medium or Low.
${multi ? '- "portal" is "Admin Portal" or "Resident Portal": the portal where that test case is performed (one per test case).\n' : ''}${automation ? AUTOMATION_RULES : ''}
Return ONLY JSON in this exact shape:
{"testCases":[{${multi ? '"portal":"Admin Portal",' : ''}"requirementRef":"","module":"","title":"","type":"Positive","priority":"High","preconditions":"","steps":"","testData":"","expectedResult":""${automation ? ',"automation":["click: ..."],"automationNotes":""' : ''}}]}
${sharedText ? `\nSHARED CONTEXT (applies to every module):\n"""\n${sharedText}\n"""\n` : ''}
${whole ? 'BRD' : `BRD SECTION FOR "${module.moduleName}"`}:
"""
${moduleText}
"""`;
}

// ---- Screenshots and screen recordings ----
const VISUAL_MODE = {
  smoke: `MODE = SMOKE
- Only POSITIVE happy-path scenarios for actions that are visible (open the list, search, filter, add, save, view details, download ...).
- About one test case per visible workflow, 15 maximum. "type" must be "Positive".`,
  comprehensive: `MODE = COMPREHENSIVE
- Positive scenarios for every visible action (list, search, each filter, sorting, pagination, add/edit/save/cancel, view details, download/export, toggles, links, navigation).
- Negative, validation or boundary scenarios ONLY where the screen shows the rule. "type" is "Positive" or "Negative".`
};

function buildVisualPlanPrompt({ sourceName }) {
  return `You are a senior QA analyst. The attached screenshots and/or screen recording frames show a property-management web platform. Every item is labelled [#n].

Work out which MODULES are visible (each module gets its own tab in a test case workbook) and which PORTAL each belongs to.
- "Admin Portal" = the SBS/Admin back-office. "Resident Portal" = the tenant/resident app.
- Decide the portal ONLY from what is visible (logo, page title, menu, layout, address bar). If you cannot tell, use "Admin Portal" and say so in notes.
- A module is a distinct feature area (for example "Equipment", "Service Requests", "Settings - Brand"). Use the name shown in the menu or page title. Do not merge different modules and do not split one module into several.
- Never mix portals: if the same module appears in both portals, return two entries (one per portal).

For each module return: moduleName, portals (exactly one portal), summary (one sentence), mediaRefs (the [#n] numbers of the items that show it), observed (short list of what is VISIBLE: fields, buttons, filters, table columns, actions).
Also return notes: anything unclear or not visible that a tester would need confirmed.

Return ONLY JSON: {"modules":[{"moduleName":"","portals":["Admin Portal"],"summary":"","mediaRefs":[1],"observed":[""]}],"notes":[""]}

SOURCE: ${sourceName}`;
}

function buildVisualModulePrompt({ module, mode, automation }) {
  return `You are a senior QA engineer writing manual test cases from SCREENSHOTS / SCREEN RECORDING FRAMES of a property-management web platform.

MODULE TO TEST: ${module.moduleName}
PORTAL: ${module.portals[0]}
VISIBLE ACCORDING TO THE EARLIER ANALYSIS: ${module.observed.join('; ') || '-'}
Only the items for this module are attached, each labelled [#n].

${VISUAL_MODE[mode]}

Evidence rules:
- Base every test case ONLY on what is visible: exact field names, buttons, filters, column headings, tabs, actions and messages shown on screen. Do not assume hidden functionality.
- Do NOT invent business rules, validation rules, limits, formulas, permissions, error messages, dropdown options or sample values that are not visible. Use placeholders such as <VALID_NAME> for test data.
- If the result of an action cannot be seen, start that expected result with "[Needs confirmation]" and add the question to "clarifications".
- Write negative or validation cases only when the screen shows the rule (required-field marker, disabled button, character counter). Otherwise put the question under "clarifications" instead of inventing it.
- For recordings follow the order in which the actions happen; each distinct workflow is one test case.
- Do not write login steps unless the test case itself is about login: a standard Login test case already exists on the sheet. Assume the user is logged in.
- Each test case must be specific, independent and verifiable. No duplicates.
- "steps" is a numbered list as one string, each step on its own line ("1. ...\\n2. ..."). "expectedResult" is also numbered, matching the steps.
- "requirementRef" is the screen the case comes from, e.g. "[#2] Add Equipment form".
- "module" is the TEST SCENARIO inside this module (e.g. "Search Equipment"); the same scenario uses the exact same text. "title" is the specific test case name. "priority" is High, Medium or Low.
${automation ? AUTOMATION_RULES : ''}
Return ONLY JSON in this exact shape:
{"clarifications":[""],"testCases":[{"requirementRef":"","module":"","title":"","type":"Positive","priority":"High","preconditions":"","steps":"","testData":"","expectedResult":""${automation ? ',"automation":["click: ..."],"automationNotes":""' : ''}}]}`;
}

async function callGemini(prompt, media = []) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('No Gemini API key configured. Add it in the app under Settings, or set GEMINI_API_KEY in .env.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  // A long BRD with a slow connection can need more than five minutes.
  const timeout = Number(process.env.GEMINI_TIMEOUT_MS || 600000);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          ...media.flatMap((m, i) => [{ text: `[#${m.idx || i + 1}] ${m.label}` }, { inlineData: { mimeType: m.mimeType, data: m.data } }]),
          { text: prompt }
        ] }],
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
async function generateJson(prompt, label, media = []) {
  let last = {};
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { text, finish } = await limited(() => callGemini(prompt, media));
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

const CLASSIC_TYPES = new Set(['BRD document', 'BRD text']);
const MIN_SPLIT_CHARS = 2500;          // shorter BRDs are treated as one module

function mapTestCases(raw, { classic, mode, hinted, fallback }) {
  return (Array.isArray(raw) ? raw : []).map(t => ({
    portal: hinted || normPortal(t.portal, fallback),
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
}
const portalFromHint = h => (/resident|tenant/i.test(h) ? 'Resident Portal' : /admin/i.test(h) ? 'Admin Portal' : null);
const CUT_NOTE = 'The AI answer was cut off, so some test cases may be missing. Try Smoke mode or split this BRD into smaller parts.';

// One input -> ONE module (short pasted items, short BRDs, or when the module is given). Old behaviour.
async function generateSingle({ text, inputType = 'BRD document', sourceName = '', moduleHint = '', portalHint = 'Auto', mode = 'comprehensive', automation = false }) {
  const classic = CLASSIC_TYPES.has(inputType);
  const body = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const prompt = classic
    ? buildClassicPrompt({ text: body, mode, automation })
    : buildPrompt({ text: body, inputType, sourceName, moduleHint, portalHint, mode });
  const { value: parsed, truncated } = await generateJson(prompt, sourceName || 'input');
  const hinted = portalFromHint(portalHint);
  const fallback = hinted || normPortal((parsed.portals || [])[0], 'Admin Portal');
  const cases = mapTestCases(Array.isArray(parsed) ? parsed : parsed.testCases, { classic, mode, hinted: hinted || (classic ? 'Admin Portal' : null), fallback });
  return {
    moduleName: str(moduleHint) || (classic ? '' : str(parsed.moduleName)) || '',
    assumptions: classic ? [] : list(parsed.assumptions),
    clarifications: [...(classic ? [] : list(parsed.clarifications)), ...(truncated ? [CUT_NOTE] : [])],
    testCases: cases
  };
}

// Step 1: which modules does this BRD contain?
async function planModules(body, sourceName) {
  const { value } = await generateJson(buildPlanPrompt({ text: body, outlineText: outline(body), sourceName }), `${sourceName} (module analysis)`);
  const seen = new Set();
  const modules = (Array.isArray(value.modules) ? value.modules : []).map(m => ({
    moduleName: str(m.moduleName),
    portals: [...new Set(list(m.portals).map(p => normPortal(p, 'Admin Portal')))],
    sections: list(m.sections),
    summary: str(m.summary),
    dependsOn: list(m.dependsOn)
  })).filter(m => {
    const k = m.moduleName.toLowerCase();
    if (!m.moduleName || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 200);
  modules.forEach(m => { if (!m.portals.length) m.portals = ['Admin Portal']; });
  return { modules, sharedSections: list(value.sharedSections) };
}

const MAX_VISUAL_MB = Number(process.env.MAX_VISUAL_MB || 14);

// Screenshots / screen recording: find the modules and portals that are visible, then one generation per module
// using only the items that show it. Returns the same shape as analyzeInput.
async function analyzeMedia({ media, sourceName = '', moduleHint = '', portalHint = 'Auto', mode = 'comprehensive', automation = false, onProgress = () => {} }) {
  if (!media || !media.length) throw new Error('No readable screenshots or recording in this input.');
  const bytes = media.reduce((n, m) => n + m.data.length * 0.75, 0);
  if (bytes > MAX_VISUAL_MB * 1024 * 1024) throw new Error(`Too much visual data for one request (${(bytes / 1048576).toFixed(1)} MB, limit ${MAX_VISUAL_MB} MB). Use fewer or smaller files.`);
  media.forEach((m, i) => { m.idx = i + 1; });
  const hinted = portalFromHint(portalHint);
  const notes = [];
  let modules;

  if (moduleHint) {                                    // module given by the user: no analysis step
    modules = [{ moduleName: moduleHint, portals: [hinted || 'Admin Portal'], refs: [], observed: [] }];
    if (!hinted) notes.push('Portal was not specified, so the Admin Portal was assumed.');
  } else {
    onProgress('analysing screens');
    const { value } = await generateJson(buildVisualPlanPrompt({ sourceName }), `${sourceName} (screen analysis)`, media);
    const seen = new Set();
    modules = (Array.isArray(value.modules) ? value.modules : []).map(m => ({
      moduleName: str(m.moduleName),
      portals: [hinted || normPortal(list(m.portals)[0], 'Admin Portal')],
      refs: (Array.isArray(m.mediaRefs) ? m.mediaRefs : []).map(Number).filter(n => n >= 1 && n <= media.length),
      observed: list(m.observed)
    })).filter(m => {
      const k = `${m.moduleName.toLowerCase()}|${m.portals[0]}`;
      if (!m.moduleName || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 200);
    if (!modules.length) throw new Error('No module could be identified from these screens. Add a module name in the Module box and try again.');
    notes.push(...list(value.notes));
  }

  let done = 0;
  onProgress(`${modules.length} module(s) found, generating`);
  const results = await Promise.all(modules.map(async (m, i) => {
    const own = media.filter(x => m.refs.includes(x.idx));
    try {
      const { value, truncated } = await generateJson(buildVisualModulePrompt({ module: m, mode, automation }), `${sourceName} > ${m.moduleName}`, own.length ? own : media);
      const cases = mapTestCases(Array.isArray(value) ? value : value.testCases, { classic: true, mode, hinted: m.portals[0], fallback: m.portals[0] });
      const unsure = cases.filter(t => /needs confirmation/i.test(t.expectedResult)).map(t => `${t.title}: expected behaviour is not visible and needs confirmation`);
      onProgress(`${++done}/${modules.length} done`);
      return {
        moduleName: m.moduleName, assumptions: [],
        clarifications: [...(i === 0 ? notes : []), ...list(value.clarifications), ...unsure, ...(truncated ? [`${m.moduleName}: ${CUT_NOTE}`] : [])],
        testCases: cases
      };
    } catch (e) {
      console.error(`[${sourceName} > ${m.moduleName}] failed: ${e.message}`);
      onProgress(`${++done}/${modules.length} done`);
      return { moduleName: m.moduleName, assumptions: [], clarifications: [`${m.moduleName}: no test cases were generated (${e.message})`], testCases: [] };
    }
  }));
  if (!results.some(r => r.testCases.length)) throw new Error(results[0].clarifications[0] || 'No test cases were generated.');
  return { modules: results, assumptions: [], clarifications: results.flatMap(r => r.clarifications) };
}

// Entry point. Returns { modules:[{ moduleName, assumptions, clarifications, testCases[] }], assumptions[], clarifications[] }.
//   BRD (file / link / BRD text): analyse the whole document -> modules -> one generation per module (own tab each)
//   short pasted items (issue, feature, CRF ...): one module, QA-analyst style
async function analyzeInput(opts) {
  if (opts.inputType === 'Screenshots' || opts.inputType === 'Screen recording') return analyzeMedia(opts);
  const { text, inputType = 'BRD document', sourceName = '', moduleHint = '', mode = 'comprehensive', automation = false, onProgress = () => {} } = opts;
  const wrap = (r, notes = []) => {
    const mod = { moduleName: r.moduleName, assumptions: r.assumptions, clarifications: [...r.clarifications, ...notes], testCases: r.testCases };
    return { modules: [mod], assumptions: mod.assumptions, clarifications: mod.clarifications };
  };
  const split = CLASSIC_TYPES.has(inputType) && !moduleHint && text.length >= MIN_SPLIT_CHARS;
  if (!split) return wrap(await generateSingle(opts));

  const body = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  onProgress('analysing modules');
  let plan = null;
  try { plan = await planModules(body, sourceName); }
  catch (e) { console.error(`[${sourceName}] module analysis failed: ${e.message}`); }
  if (!plan || !plan.modules.length) {
    return wrap(await generateSingle(opts), ['Could not split this BRD into modules automatically, so it was generated as one module.']);
  }

  const names = plan.modules.map(m => m.moduleName);
  let shared = sectionText(body, plan.sharedSections);
  if (shared.length > 20000) shared = shared.slice(0, 20000);
  let done = 0;
  onProgress(`${names.length} modules found, generating`);

  const results = await Promise.all(plan.modules.map(async m => {
    const own = sectionText(body, m.sections);
    const whole = !own;                                   // section not found (e.g. PDF without headings): give the whole BRD
    const prompt = buildModulePrompt({
      module: m, moduleText: own || body, sharedText: whole ? '' : shared,
      others: names.filter(n => n !== m.moduleName), mode, automation, whole
    });
    try {
      const { value, truncated } = await generateJson(prompt, `${sourceName} > ${m.moduleName}`);
      const fallback = m.portals[0];
      const cases = mapTestCases(Array.isArray(value) ? value : value.testCases, { classic: true, mode, hinted: m.portals.length === 1 ? m.portals[0] : null, fallback });
      onProgress(`${++done}/${names.length} modules done`);
      return { moduleName: m.moduleName, assumptions: [], clarifications: truncated ? [`${m.moduleName}: ${CUT_NOTE}`] : [], testCases: cases };
    } catch (e) {
      console.error(`[${sourceName} > ${m.moduleName}] failed: ${e.message}`);
      onProgress(`${++done}/${names.length} modules done`);
      return { moduleName: m.moduleName, assumptions: [], clarifications: [`${m.moduleName}: no test cases were generated (${e.message})`], testCases: [] };
    }
  }));

  if (!results.some(r => r.testCases.length)) throw new Error(results[0].clarifications[0] || 'No test cases were generated.');
  return {
    modules: results,
    assumptions: results.flatMap(r => r.assumptions),
    clarifications: results.flatMap(r => r.clarifications)
  };
}

module.exports = { analyzeInput };
