# BRD → Test Case Generator

Paste BRD links or upload a folder of BRDs → pick **Smoke** or **Comprehensive** → get one Excel file per BRD,
already filled into **your own TC template** (formatting preserved).

## Step-by-step setup (VS Code)

1. **Install Node.js 18+** (https://nodejs.org) and VS Code. Check: `node -v`
2. **Open this folder in VS Code**: File → Open Folder → `brd-tc-generator`
3. **Open the terminal** (Ctrl+`) and run: `npm install`
4. **Get a Gemini API key**: https://aistudio.google.com/apikey
5. **Create `.env`**: copy `.env.example` to `.env` and paste your key into `GEMINI_API_KEY=`
6. **Add your template**: save your TC template as `templates/TC_Template.xlsx`
   (or upload it in the web page each time).
7. **Start**: `npm start` → open http://localhost:3000

## Using it
(Full BRDs use the classic, compact test case style. Short pasted items - issue, feature, CRF - use the QA-analyst style.)
1. **Inputs** (mix freely): BRD links, files (.docx .pdf .txt .md), a whole folder, **or pasted text** - issue summary,
   bug description, feature description, CRF summary, requirement summary. A full BRD is not required: a two-line
   issue is enough, the AI works out the scenarios like a QA analyst. For pasted items you can set a module name and portal.
2. Choose **Smoke** (positive happy path) or **Comprehensive** (positive, negative, boundary, validation, regression).
3. Optionally upload your template. Click **Generate**.
4. Download **one workbook** (+ an Assumptions & notes .txt when the AI had to assume something).

## What the workbook contains
- **Module sheets**: module 1 -> `1.0` (Admin Portal) and `1.1` (Resident Portal, only if it has cases), module 2 -> `2.0` / `2.1` ...
  No limit. Inputs about the same module (several BRDs + pasted issues) land on the same sheet, duplicates are skipped.
  Sheets cloned from `1.0` when the template's 1.0-5.0 are not enough; unused template sheets are removed.
- **Login test case** (template rows 12-13) is kept on every sheet, with the Tenant Portal URL from `.env` (`ADMIN_PORTAL_URL`).
  Resident sheets use `RESIDENT_PORTAL_URL`, or the placeholder `<RESIDENT_PORTAL_URL>` if it is empty.
- **Summary sheets**: one row per module sheet in every cycle block (rows are inserted when there are more than 5),
  charts and totals extended, same columns and the same % Completed formula. Counts update live from the sheets' status dropdowns.
- **Automation Test Scripts** sheet (only when `AUTOMATION_SHEET=on` in `.env`): Module Number, Module Name, Portal, Test Case ID, Test Case Title, Step No., Automation Command,
  Configuration Notes, Source Input. Only the supported commands (click, text, dropdown, link, Login, sleep, calendar, checkbox, icon, upload).
  Each script starts with the login workflow; credentials/values that are unknown stay as `<PLACEHOLDERS>` and are flagged.
- Unspecified expected behaviour is marked `[Needs clarification]` in the Expected Result and listed in the notes file.

On each module sheet: Test Case ID `TC_<MODULE>_001`..., Test Scenario (merged), Test Case, Test Steps (pre-condition and test data
inside the cell), Expected Result one per row, status columns NOT EXECUTED with your dropdowns. Layout settings: top of `src/templateWriter.js`.

## Notes & limits
- Google Doc links must be shared as **Anyone with the link can view**. Private tools (Confluence/SharePoint
  behind login) can't be fetched, so export to PDF/DOCX and upload instead.
- BRDs longer than ~150,000 characters are truncated.
- Review generated cases before use. AI output can miss or misread requirements.
- Don't commit `.env` (it's in `.gitignore`).

## Project layout
```
server.js              Express server, job queue, parallel processing
src/parsers.js         Read .docx/.pdf/.txt/.md and BRD links
src/generator.js       QA-analyst prompt + Gemini call
src/consolidate.js     Merge all inputs into modules / portal sheets, remove duplicates
src/templateWriter.js  Fill the .xlsx template (module sheets, Summary, Automation sheet) - keeps charts
public/index.html      Web UI
```

## Ending a session & data handling
- **End session** (button under the results) deletes this session's uploaded BRDs, template copy, generated workbooks, notes file and in-memory data, then resets the page. Download your workbook(s) first.
- Nothing is kept permanently: uploads are deleted right after they are read, generated files are deleted when you end the session,
  runs nobody ended are deleted after `SESSION_TTL_MINUTES` (default 60), and `tmp/` and `output/` are emptied when the app starts.
  `templates/` is never touched.
- Not removed by End session: copies you downloaded, the terminal log (it can contain input names, error messages and short snippets of
  an AI reply when something fails), your output-format/account-name preference in the browser, and anything already sent to Google's Gemini API
  (check Google's data retention terms for your API plan). Restart the app to clear data still held in its memory.

## Publishing to GitHub
- Safe to commit: the code. Not committed (see `.gitignore`): `.env` (your API key), `tmp/`, `output/`, `node_modules/` and any `.xlsx` file, including your template in `templates/`.
- Before the first push run `git status` and check that none of those appear. If one was already committed: `git rm --cached <file>` and commit, and if it was `.env`, create a new API key (deleting a file does not remove it from Git history).
- Each person who clones the repo uses their own `.env`, their own Gemini key and their own template.
- This app has no login. Run it locally; do not host it on a public address with your API key.
