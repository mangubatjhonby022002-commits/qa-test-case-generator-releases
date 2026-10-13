// Creates a basic templates/TC_Template.xlsx so you can test before using your own.
const ExcelJS = require('exceljs');
const path = require('path');
(async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Test Cases');
  ws.addRow(['TC ID', 'Module', 'Requirement', 'Test Case Title', 'Type', 'Priority', 'Preconditions', 'Steps', 'Test Data', 'Expected Result', 'Actual Result', 'Status']);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  [12, 18, 16, 40, 12, 10, 28, 50, 24, 40, 20, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  await wb.xlsx.writeFile(path.join(__dirname, '..', 'templates', 'TC_Template.xlsx'));
  console.log('Created templates/TC_Template.xlsx');
})();
