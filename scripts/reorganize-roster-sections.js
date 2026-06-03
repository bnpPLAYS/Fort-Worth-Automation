require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const { isSheetsConfigured, getSheetsConfigHelpMessage } = require("../src/google-sheets/client");
const { reorganizeRosterStructure } = require("../src/google-sheets/roster-reorganize");

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");

  if (!isSheetsConfigured()) {
    console.error(getSheetsConfigHelpMessage());
    process.exit(1);
  }

  const result = await reorganizeRosterStructure({ dryRun, force });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
