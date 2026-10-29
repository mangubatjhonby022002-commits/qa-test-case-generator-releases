# BRD → Test Case Generator

Paste BRD links or upload a folder of BRDs → pick **Smoke** or **Comprehensive** → get one Excel file per BRD,
already filled into **your own TC template** (formatting preserved).

## Step-by-step setup (VS Code)

1. **Install Node.js 18+** (https://nodejs.org) and VS Code. Check: `node -v`
2. **Open this folder in VS Code**: File → Open Folder → `brd-tc-generator`
3. **Open the terminal** (Ctrl+`) and run: `npm install`
4. **Get a Gemini API key**: https://aistudio.google.com/apikey
5. **Add your key**: either in the app (`Settings` → `Gemini API key`, encrypted per Windows user) or in `.env`:
   copy `.env.example` to `.env` and paste your key into `GEMINI_API_KEY=`
6. **Add your template**: save your TC template as `templates/TC_Template.xlsx`
   (or upload it in the web page each time).
7. **Start**: `npm start` (the desktop app) or `npm run server` → open http://localhost:3000

## Settings (Gemini API key)
- **⚙ Settings** in the app (or `File` → `Settings...`): paste a key, **Show**/**Hide** it, **Save key**, **Clear**, and **Test connection**.
- The key is encrypted with the Windows key store (Electron `safeStorage`, DPAPI) and stored in the app data folder
  of the current Windows user - every user has their own key, and it is never written to the repo, logged, or sent back to the page.
- If the OS key store is not available the key is **not** saved and the app says so - there is no plain text fallback.
- **Test connection** sends one small request (the model list) with the key in the `x-goog-api-key` header - no BRD data.
- Every generation uses the saved key automatically. Without a key the run is refused and you are sent to Settings.
- `GEMINI_API_KEY` in `.env` is the fallback for people who run the app without the desktop shell.

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
  Sheets cloned from `1.0` when the template's 1.0-5.0 are not enough; unused module slots of the template
  (2.0-5.0) are removed. Other sheets of your template (a RAID Log, a leftover project sheet) stay untouched.
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
main.js                Electron desktop app: window, menu, key settings, auto-update
preload.js             The only bridge to the page (a few named operations, no key access)
server.js              Express server, job queue, parallel processing
src/parsers.js         Read .docx/.pdf/.txt/.md and BRD links
src/sections.js        Split a BRD into its heading sections (module texts)
src/generator.js       QA-analyst prompt + Gemini call
src/keyStore.js        The user's own API key, encrypted with the OS key store
src/gemini.js          Minimal Gemini request (connection test)
src/updater.js         Auto-update: release feed check, download and install
scripts/verify-updater-feed.cjs  Offline end-to-end check of the real update download
scripts/stage-release-assets.cjs  Copies the release files into dist/release-assets with the names GitHub needs
scripts/check-live-updates.cjs   Reads the live release feed and prints the state the app would show
src/consolidate.js     Merge all inputs into modules / portal sheets, remove duplicates
src/templateWriter.js  Fill the .xlsx template (module sheets, Summary, Automation sheet) - keeps charts
public/index.html      Web UI (inputs, settings, results)
```

## Updates
- `Help` → `Check for Updates...` (also in the app: `Settings` → `Updates`) runs a real check and shows the state:
  checking, up to date, update available, downloading, ready to install, or the error.
- The feed is the GitHub repository `mangubatjhonby022002-commits/qa-test-case-generator-releases`
  (a **public** releases repository - your source-code repository stays private and is never published).
  The build (`npm run dist`) writes the repository into `app-update.yml`, and `src/updater.js` reads the same
  repository. If the repository is missing or private the check ends in the error state with the reason
  (404 / 403) instead of pretending to be up to date; if the repository exists but has no release yet, it
  says exactly that.
- A development build (`npm start`) has no `app-update.yml`, so it checks the release feed directly and reports
  the result - installing is done by the packaged app.
- Nothing is downloaded or installed without the confirmation dialog. A failed check is reported as an error,
  never as "up to date". For a private releases repository set `GH_TOKEN` in `.env`.

### Publishing an update (what you have to do)
1. Raise `version` in `package.json` (e.g. `1.0.1`).
2. `npm run dist` - builds the installer, `latest.yml` and the `.exe.blockmap` into `dist/`.
3. `npm run release:assets` - copies the three files into `dist/release-assets/` under the exact names the
   updater asks GitHub for, and checks that the checksum in `latest.yml` belongs to that installer.
4. In `mangubatjhonby022002-commits/qa-test-case-generator-releases` create a release with the tag `v<version>`
   (e.g. `v1.0.1`) and upload **all three** files from `dist/release-assets/`:
   - `QA-Test-Case-Generator-Setup-<version>.exe`
   - `QA-Test-Case-Generator-Setup-<version>.exe.blockmap`
   - `latest.yml`

   The file names have no spaces - that is what `latest.yml` and the updater request. `npm run release:assets`
   already renames them for you.
5. Publish the release (not a draft). Installed apps then find it with `Help` → `Check for Updates...`.
   A draft release is not visible to the updater.
6. `npm run release:check` - reads the live feed and prints the state the app would show.

### Verifying the update path yourself
- `npm test` covers the update states (checking, up to date, available, downloading, downloaded, error) with a
  mocked updater - it never needs a network.
- `npm run test:updater:feed` is the real end-to-end check: it starts a local server that mimics the GitHub
  releases layout, points the real electron-updater GitHub provider at it and lets it check, download and
  checksum-verify the **real** build artifacts from `dist/`. It downloads nothing from the internet and installs
  nothing. Run `npm run dist` first - it needs the installer and `latest.yml` in `dist/`.
- What this cannot cover: the live feed. It only works once a release really exists in the repository.

## Ending a session & data handling
- **End session** (button under the results) deletes this session's uploaded BRDs, template copy, generated workbooks, notes file and in-memory data, then resets the page. Download your workbook(s) first.
- Nothing is kept permanently: uploads are deleted right after they are read, generated files are deleted when you end the session,
  runs nobody ended are deleted after `SESSION_TTL_MINUTES` (default 60), and `tmp/` and `output/` are emptied when the app starts.
  `templates/` is never touched.
- Not removed by End session: copies you downloaded, the terminal log (it can contain input names, error messages and short snippets of
  an AI reply when something fails), your output-format/account-name preference in the browser, and anything already sent to Google's Gemini API
  (check Google's data retention terms for your API plan). Restart the app to clear data still held in its memory.

## Publishing to GitHub
- Two different repositories: the **source code** repository stays private (or is not pushed at all), the
  **releases** repository `mangubatjhonby022002-commits/qa-test-case-generator-releases` is public and holds
  only the installer, `latest.yml` and the `.exe.blockmap`. No code, no keys, no templates are uploaded there.
- Safe to commit: the code. Not committed (see `.gitignore`): `.env` (your API key), `tmp/`, `output/`, `node_modules/` and any `.xlsx` file, including your template in `templates/`.
- Before the first push run `git status` and check that none of those appear. If one was already committed: `git rm --cached <file>` and commit, and if it was `.env`, create a new API key (deleting a file does not remove it from Git history).
- Each person who clones the repo uses their own `.env`, their own Gemini key and their own template.
  A key entered in the app is stored encrypted outside the repo (in the app data folder of the Windows user) and is never committed.
- This app has no login. Run it locally; do not host it on a public address with your API key.

## Screenshots and screen recordings
- Upload PNG/JPG/WebP/HEIC screenshots or MP4/WebM/MOV/MPEG/WMV/FLV/3GP recordings with the other files. Screenshots are analysed as a set: the AI finds the modules and portal of each screen, then writes test cases per module from only the screens that show it. Every recording is analysed on its own.
- Test cases come only from what is visible. Anything that cannot be seen is marked `[Needs confirmation]` and listed in the results under "to clarify". Optional Module / Portal boxes force the module or portal for the screens you upload.
- Recordings over `VIDEO_INLINE_MAX_MB` (default 12 MB) and AVI/MKV/GIF/M4V are converted to up to `MAX_VIDEO_FRAMES` frames, which needs **ffmpeg** on the PATH. Without ffmpeg the app says so and asks for a smaller MP4/WebM or screenshots. BMP/TIFF and screenshots over 7 MB also need ffmpeg. SVG, PSD and audio files are rejected with a message.
- A recording is re-sent once per module it contains (the cost of one analysis plus one request per module).

## Supported and unsupported inputs
- Read: `.docx`, `.pdf` (text, no OCR), `.txt`, `.md`, public Google Doc / web page links, pasted text, PNG/JPG/WebP/HEIC screenshots, MP4/WebM/MOV/MPEG/WMV/FLV/3GP recordings. AVI/MKV/M4V/GIF/BMP/TIFF and large recordings need ffmpeg.
- Reported as unsupported (shown in the results, not silently skipped): `.doc`, `.rtf`, `.odt`, `.ppt(x)`, `.xls(x)`, `.svg`, `.psd`, `.ico`, audio files. Other unknown file types in a folder are ignored.
- Not read: pictures inside a BRD (flow diagrams, screenshots embedded in a .docx/.pdf) and scanned PDFs without text.
