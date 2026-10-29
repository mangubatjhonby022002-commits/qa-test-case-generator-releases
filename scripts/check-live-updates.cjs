// Checks the real GitHub releases repository of the app - the same check the app does.
//
// Run with:  npm run release:check
const { checkFeed, REPO_OWNER, REPO_NAME } = require('../src/updater.js');

(async () => {
  const result = await checkFeed();
  console.log(`Feed: ${REPO_OWNER}/${REPO_NAME}`);
  console.log(`State: ${result.status}`);
  console.log(`Message: ${result.message}`);
  if (result.version) console.log(`Version: ${result.version}`);
  process.exit(result.status === 'error' ? 1 : 0);
})();
