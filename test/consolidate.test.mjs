import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { consolidate } = require('../src/consolidate.js');
const { writeWorkbook } = require('../src/templateWriter.js');

console.log('--- Starting Module Sheets / Excel Export Test Suite ---');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tcgen-excel-'));
const tc = (title, portal = 'Admin Portal') => ({
  portal, scenario: 'General', title, category: 'Positive', priority: 'High', requirementRef: 'REQ-1',
  preconditions: 'User is logged in', steps: '1. Do it', testData: '', expectedResult: '1. Done',
  automation: [], automationNotes: ''
});

// Test 1: the modules of a BRD become their own sheets
{
  const items = [{
    id: 0,
    name: 'brd.md',
    analysis: {
      modules: [
        { moduleName: 'Equipment', assumptions: [], clarifications: [], testCases: [tc('Add equipment'), tc('Search equipment')] },
        { moduleName: 'Dashboard', assumptions: [], clarifications: ['Occupancy rule is not stated.'], testCases: [tc('Occupancy rate')] },
        { moduleName: 'Permissions', assumptions: [], clarifications: [], testCases: [tc('Role change', 'Resident Portal')] }
      ],
      assumptions: [],
      clarifications: ['Occupancy rule is not stated.']
    }
  }];

  const { specs, notes } = consolidate(items);
  assert.strictEqual(specs.length, 3, 'Test 1 Failed: every module needs its own sheet');
  // .0 = Admin Portal, .1 = Resident Portal (the third module only has resident cases)
  assert.deepStrictEqual(specs.map(s => s.name), ['1.0', '2.0', '3.1'], 'Test 1 Failed: the sheets must be numbered per module and portal');
  assert.strictEqual(specs[0].moduleName, 'Equipment', 'Test 1 Failed: the module name must be kept');
  assert.strictEqual(specs[0].testCases.length, 2, 'Test 1 Failed: the test cases of the module must be kept');
  assert.strictEqual(specs[2].portal, 'Resident Portal', 'Test 1 Failed: the portal must be kept');
  assert.ok(notes.includes('Permissions') || notes.includes('clarification'), 'Test 1 Failed: the notes must be written');
  console.log('✓ Test 1: The modules of a BRD become their own numbered sheets');
}

// Test 2: the same module in two inputs lands on one sheet, duplicates are skipped
{
  const items = [
    { id: 0, name: 'a.md', analysis: { modules: [{ moduleName: 'Equipment', assumptions: [], clarifications: [], testCases: [tc('Add equipment')] }] } },
    { id: 1, name: 'b.md', analysis: { modules: [{ moduleName: 'Equipment', assumptions: [], clarifications: [], testCases: [tc('Add equipment'), tc('Edit equipment')] }] } }
  ];
  const { specs, removed } = consolidate(items);
  assert.strictEqual(specs.length, 1, 'Test 2 Failed: the same module must be one sheet');
  assert.strictEqual(specs[0].testCases.length, 2, 'Test 2 Failed: the different test cases must both be kept');
  assert.strictEqual(removed, 1, 'Test 2 Failed: the duplicate must be counted');
  console.log('✓ Test 2: The same module of two inputs shares one sheet and duplicates are skipped');
}

// Test 3: a module with two portals gets both sheets
{
  const items = [{
    id: 0, name: 'a.md', analysis: {
      modules: [{ moduleName: 'Equipment', assumptions: [], clarifications: [], testCases: [tc('Add equipment'), tc('View equipment', 'Resident Portal')] }]
    }
  }];
  const { specs } = consolidate(items);
  assert.deepStrictEqual(specs.map(s => s.name), ['1.0', '1.1'], 'Test 3 Failed: a module with two portals needs 1.0 and 1.1');
  console.log('✓ Test 3: A module used in two portals gets both sheets');
}

// Test 4: the Excel workbook is written with one sheet per module
{
  const items = [{
    id: 0, name: 'brd.md', analysis: {
      modules: [
        { moduleName: 'Equipment', assumptions: [], clarifications: [], testCases: [tc('Add equipment'), tc('Search equipment')] },
        { moduleName: 'Dashboard', assumptions: [], clarifications: [], testCases: [tc('Occupancy rate')] }
      ]
    }
  }];
  const { specs } = consolidate(items);
  const outPath = path.join(tmp, 'TestCases.xlsx');
  const result = await writeWorkbook({
    templatePath: path.join(process.cwd(), 'templates', 'TC_Template.xlsx'),
    outPath,
    specs,
    urls: { admin: 'https://admin.example.test', resident: 'https://resident.example.test' }
  });
  assert.ok(fs.existsSync(outPath), 'Test 4 Failed: the workbook file must exist');
  const buf = fs.readFileSync(outPath);
  assert.strictEqual(buf[0], 0x50, 'Test 4 Failed: the workbook must be a zip file');
  assert.strictEqual(buf[1], 0x4b, 'Test 4 Failed: the workbook must be a zip file');
  assert.ok(buf.length > 5000, 'Test 4 Failed: the workbook must have content');

  // The sheet names of the workbook
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buf);
  const workbookXml = await zip.file('xl/workbook.xml').async('string');
  assert.ok(/name="1\.0"/.test(workbookXml), 'Test 4 Failed: the workbook must contain the sheet of the first module');
  assert.ok(/name="2\.0"/.test(workbookXml), 'Test 4 Failed: the workbook must contain the sheet of the second module');

  // The module name and the test case must be written into the module sheet
  const sheets = Object.keys(zip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
  let moduleSheet = '';
  for (const f of sheets) {
    const xml = await zip.file(f).async('string');
    if (xml.includes('Add equipment') && xml.includes('Equipment')) moduleSheet = f;
  }
  assert.ok(moduleSheet, 'Test 4 Failed: the module sheet must contain the module name and the test case');
  console.log('✓ Test 4: The Excel workbook is written with a sheet per module');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('--- ALL 4 MODULE SHEET TESTS PASSED SUCCESSFULLY ---');
