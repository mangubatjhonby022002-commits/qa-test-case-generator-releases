import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { outline, sectionText } = require('../src/sections.js');

console.log('--- Starting BRD Sections Test Suite ---');

// A .docx-like BRD: headings kept as markdown, with nested sub-sections.
const markdownBrd = `# BRD: Property Management Platform

# 1. Introduction
The platform serves admins and residents.

# 2. Equipment Module Overview
The equipment module manages the equipment of a property.

## 2.1 Functional Requirements
REQ-01 The user can add equipment.
REQ-02 The user can search equipment.

## 2.2 Data Dictionary
| Field | Type |
| Name | Text |

# 3. Dashboard
The dashboard shows occupancy numbers.

## 3.1 Widgets
Widget list.

# 4. Permissions
The property manager can edit equipment.
`;

// Test 1: the outline shows every heading, indented by its level
{
  const o = outline(markdownBrd);
  assert.ok(o.includes('2. Equipment Module Overview'), 'Test 1 Failed: outline must list the module heading');
  assert.ok(o.includes('2.1 Functional Requirements'), 'Test 1 Failed: outline must list the sub-section');
  assert.ok(o.includes('4. Permissions'), 'Test 1 Failed: outline must list the shared section');

  const lines = o.split('\n');
  const eq = lines.find(l => l.includes('2. Equipment Module Overview'));
  const func = lines.find(l => l.includes('2.1 Functional Requirements'));
  const dash = lines.find(l => l.includes('3. Dashboard'));
  assert.ok(func.startsWith('  '), 'Test 1 Failed: a sub-section must be indented');
  assert.ok(!dash.startsWith(' '), 'Test 1 Failed: a chapter must not be indented');
  assert.ok(!eq.startsWith(' '), 'Test 1 Failed: a chapter must not be indented');
  console.log('✓ Test 1: outline lists all headings with their hierarchy');
}

// Test 2: a section holds its own text and its sub-sections, but not the next chapter
{
  const s = sectionText(markdownBrd, ['2. Equipment Module Overview']);
  assert.ok(s.includes('manages the equipment'), 'Test 2 Failed: the section must keep its own text');
  assert.ok(s.includes('REQ-01'), 'Test 2 Failed: the section must keep its sub-sections');
  assert.ok(s.includes('Data Dictionary'), 'Test 2 Failed: the section must keep its sub-sections');
  assert.ok(!s.includes('occupancy numbers'), 'Test 2 Failed: the section must not contain the next chapter');
  assert.ok(!s.includes('REQ-01'.replace('REQ-01', 'The platform serves')), 'Test 2 Failed: the section must not contain earlier text');
  console.log('✓ Test 2: a section contains its nested sub-sections but not its siblings');
}

// Test 3: a sub-section is only its own part
{
  const s = sectionText(markdownBrd, ['2.1 Functional Requirements']);
  assert.ok(s.includes('REQ-01'), 'Test 3 Failed: the sub-section must keep its text');
  assert.ok(s.includes('REQ-02'), 'Test 3 Failed: the sub-section must keep its text');
  assert.ok(!s.includes('Data Dictionary'), 'Test 3 Failed: the sub-section must not contain its sibling');
  assert.ok(!s.includes('manages the equipment'), 'Test 3 Failed: the sub-section must not contain its parent');
  console.log('✓ Test 3: a sub-section contains only its own text');
}

// Test 4: several sections at once, in document order
{
  const s = sectionText(markdownBrd, ['3. Dashboard', '4. Permissions']);
  assert.ok(s.includes('occupancy numbers'), 'Test 4 Failed: the first section must be there');
  assert.ok(s.includes('property manager can edit'), 'Test 4 Failed: the second section must be there');
  assert.ok(!s.includes('REQ-01'), 'Test 4 Failed: other sections must not leak in');
  assert.ok(s.indexOf('occupancy numbers') < s.indexOf('property manager can edit'), 'Test 4 Failed: sections must keep the document order');
  console.log('✓ Test 4: several sections are returned in document order');
}

// Test 5: a shared section is only its own text
{
  const s = sectionText(markdownBrd, ['4. Permissions']);
  assert.ok(s.includes('property manager can edit'), 'Test 5 Failed: the shared section must keep its text');
  assert.ok(!s.includes('occupancy numbers'), 'Test 5 Failed: the shared section must not contain other sections');
  console.log('✓ Test 5: a shared section contains only its own text');
}

// Test 6: unknown or missing headings return nothing (the generator then sends the whole BRD)
{
  assert.strictEqual(sectionText(markdownBrd, ['No Such Section']), '', 'Test 6 Failed: an unknown heading must return nothing');
  assert.strictEqual(sectionText(markdownBrd, []), '', 'Test 6 Failed: no heading must return nothing');
  assert.strictEqual(sectionText(markdownBrd, ''), '', 'Test 6 Failed: no heading must return nothing');
  assert.strictEqual(sectionText('text without any structure', ['Anything']), '', 'Test 6 Failed: a text without headings must return nothing');
  assert.strictEqual(outline('text without any structure'), '', 'Test 6 Failed: a text without headings must have no outline');
  console.log('✓ Test 6: unknown headings and texts without structure return nothing');
}

// Test 7: the number of a heading may be left out when a section is asked for
{
  const s = sectionText(markdownBrd, ['Equipment Module Overview']);
  assert.ok(s.includes('REQ-01'), 'Test 7 Failed: the section must be found without its number');
  assert.ok(!s.includes('occupancy numbers'), 'Test 7 Failed: the section must not contain the next chapter');
  console.log('✓ Test 7: a section is found with or without its number');
}

// Test 8: two modules never get the same text
{
  const equipment = sectionText(markdownBrd, ['2. Equipment Module Overview']);
  const dashboard = sectionText(markdownBrd, ['3. Dashboard']);
  assert.notStrictEqual(equipment, dashboard, 'Test 8 Failed: both modules must get their own text');
  assert.ok(!equipment.includes('occupancy numbers'), 'Test 8 Failed: the modules must not overlap');
  assert.ok(!dashboard.includes('REQ-01'), 'Test 8 Failed: the modules must not overlap');
  console.log('✓ Test 8: every module gets its own text');
}

// A plain text BRD (a PDF): the numbering is the only structure there is.
const plainBrd = `1. Introduction
Some text.

2. Equipment Module Overview
Equipment text.

2.1 Functional Requirements
REQ-01 The user can add equipment.

2.2 Data Dictionary
Field list.

3. Dashboard
Dashboard text.
`;

// Test 9: numbered headings of a plain text document
{
  const o = outline(plainBrd);
  assert.ok(o.includes('2. Equipment Module Overview'), 'Test 9 Failed: the outline must list the numbered heading');
  assert.ok(o.includes('2.1 Functional Requirements'), 'Test 9 Failed: the outline must list the sub-section');

  const s = sectionText(plainBrd, ['2. Equipment Module Overview']);
  assert.ok(s.includes('Equipment text.'), 'Test 9 Failed: the section must keep its own text');
  assert.ok(s.includes('REQ-01'), 'Test 9 Failed: the section must keep its sub-sections');
  assert.ok(s.includes('Field list.'), 'Test 9 Failed: the section must keep its sub-sections');
  assert.ok(!s.includes('Dashboard text.'), 'Test 9 Failed: the section must not contain the next chapter');
  console.log('✓ Test 9: numbered headings of a plain text document are found with their hierarchy');
}

// Test 10: a numbered list inside the text is not a heading
{
  const withList = `1. Introduction
Some text.

2. Equipment Module Overview
Equipment text.

Steps:
1. Open the equipment list.
2. Click Add.
`;
  const s = sectionText(withList, ['2. Equipment Module Overview']);
  assert.ok(s.includes('Equipment text.'), 'Test 10 Failed: the section must keep its own text');
  assert.ok(s.includes('Click Add.'), 'Test 10 Failed: the list must stay inside the section');
  console.log('✓ Test 10: a numbered list inside a section does not end the section');
}

// A .docx where every heading uses the same style: the numbering has to carry the hierarchy.
const flatBrd = `# 1. Introduction
Some text.

# 2. Equipment Module Overview
Equipment text.

# 2.1 Functional Requirements
REQ-01 The user can add equipment.

# 3. Dashboard
Dashboard text.
`;

// Test 11: the numbering is used when the styles do not show the hierarchy
{
  const o = outline(flatBrd);
  const lines = o.split('\n');
  const eq = lines.findIndex(l => l.includes('2. Equipment Module Overview'));
  const func = lines.findIndex(l => l.includes('2.1 Functional Requirements'));
  assert.ok(func > eq, 'Test 11 Failed: the sub-section must come after its parent');
  assert.ok(lines[func].startsWith('  '), 'Test 11 Failed: the sub-section must be indented under its parent');

  const s = sectionText(flatBrd, ['2. Equipment Module Overview']);
  assert.ok(s.includes('REQ-01'), 'Test 11 Failed: the section must keep its sub-section');
  assert.ok(!s.includes('Dashboard text.'), 'Test 11 Failed: the section must not contain the next chapter');
  console.log('✓ Test 11: the numbering shows the hierarchy when the document styles do not');
}

// Test 12: plain text with ALL CAPS titles
{
  const capsBrd = `EQUIPMENT MODULE OVERVIEW
Equipment text.

FUNCTIONAL REQUIREMENTS
REQ-01 The user can add equipment.

DASHBOARD
Dashboard text.
`;
  const o = outline(capsBrd);
  assert.ok(o.includes('EQUIPMENT MODULE OVERVIEW'), 'Test 12 Failed: the outline must list the caps title');
  assert.ok(o.includes('FUNCTIONAL REQUIREMENTS'), 'Test 12 Failed: the outline must list the caps title');
  assert.ok(o.includes('DASHBOARD'), 'Test 12 Failed: the outline must list the caps title');

  const s = sectionText(capsBrd, ['EQUIPMENT MODULE OVERVIEW']);
  assert.ok(s.includes('Equipment text.'), 'Test 12 Failed: the section must keep its text');
  assert.ok(!s.includes('Dashboard text.'), 'Test 12 Failed: the section must not contain the next title');

  const sub = sectionText(capsBrd, ['FUNCTIONAL REQUIREMENTS']);
  assert.ok(sub.includes('REQ-01'), 'Test 12 Failed: the section must keep its text');
  assert.ok(!sub.includes('Dashboard text.'), 'Test 12 Failed: the section must not contain the next title');
  console.log('✓ Test 12: ALL CAPS titles of a plain text document are found');
}

// Test 13: the text of a document is never changed
{
  const original = '1. Overview\r\nLine one\r\nLine two\r\n';
  const s = sectionText(original, ['1. Overview']);
  assert.ok(s.includes('Line one'), 'Test 13 Failed: the text must be kept');
  assert.ok(s.includes('Line two'), 'Test 13 Failed: the text must be kept');
  console.log('✓ Test 13: the text of a document is returned unchanged');
}

// Test 14: the generator sends every module only its own section (and the shared sections)
{
  const { analyzeInput } = require('../src/generator.js');
  const filler = 'The platform serves admins and residents. '.repeat(60);
  const brd = `# 1. Introduction
${filler}

# 2. Equipment Module Overview
The equipment module manages the equipment of a property.

## 2.1 Functional Requirements
REQ-01 The user can add equipment.

# 3. Dashboard
The dashboard shows occupancy numbers.

# 4. Permissions
The property manager can edit equipment.
${filler}
`;

  const prompts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    prompts.push(body.contents[0].parts[0].text);
    const answer = prompts.length === 1
      ? { modules: [{ moduleName: 'Equipment', portals: ['Admin Portal'], sections: ['2. Equipment Module Overview'], summary: 'Equipment', dependsOn: [] }], sharedSections: ['4. Permissions'] }
      : { testCases: [{ requirementRef: 'REQ-01', module: 'Add Equipment', title: 'Add equipment', type: 'Positive', priority: 'High', steps: '1. Add', expectedResult: '1. Saved' }] };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'TEST_KEY';
  try {
    const analysis = await analyzeInput({ text: brd, inputType: 'BRD document', sourceName: 'BRD.txt', mode: 'comprehensive' });

    assert.ok(prompts.length >= 2, 'Test 14 Failed: the generator must plan the modules and then generate them');
    assert.ok(prompts[0].includes('HEADING OUTLINE'), 'Test 14 Failed: the plan step must get the heading outline');
    assert.ok(prompts[0].includes('2. Equipment Module Overview'), 'Test 14 Failed: the outline must list the section of the module');
    assert.ok(prompts[0].includes('2.1 Functional Requirements'), 'Test 14 Failed: the outline must list the sub-section');

    const modulePrompt = prompts[1];
    assert.ok(modulePrompt.includes('REQ-01'), 'Test 14 Failed: the module must get the text of its own section');
    assert.ok(modulePrompt.includes('The property manager can edit equipment.'), 'Test 14 Failed: the module must get the shared sections');
    assert.ok(!modulePrompt.includes('occupancy numbers'), 'Test 14 Failed: the module must not get the text of another module');

    assert.strictEqual(analysis.modules.length, 1, 'Test 14 Failed: the result must have the module');
    assert.strictEqual(analysis.modules[0].moduleName, 'Equipment', 'Test 14 Failed: the result must have the module');
    assert.strictEqual(analysis.modules[0].testCases.length, 1, 'Test 14 Failed: the result must have the test case');
  } finally {
    globalThis.fetch = originalFetch;
  }
  console.log('✓ Test 14: the generator sends every module only its own section and the shared sections');
}

console.log('--- ALL 14 SECTIONS TESTS PASSED SUCCESSFULLY ---');
