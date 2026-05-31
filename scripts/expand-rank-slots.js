require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const {
  isSheetsConfigured,
  getSheetsConfigHelpMessage,
  getRosterRows,
} = require("../src/google-sheets/client");
const { expandRankSlots, DEFAULT_EXPAND_COUNT } = require("../src/google-sheets/roster-expand");
const { findOpenSlotInRank } = require("../src/google-sheets/roster-assign");

async function main() {
  const rank = process.argv[2] || "Officer One";
  const countArg = Number.parseInt(process.argv[3] || "", 10);
  const count = Number.isFinite(countArg) && countArg > 0 ? countArg : DEFAULT_EXPAND_COUNT;

  if (!isSheetsConfigured()) {
    console.error(getSheetsConfigHelpMessage());
    process.exit(1);
  }

  const before = await getRosterRows();
  const openBefore = findOpenSlotInRank(before.entries, rank);

  console.log(`Expanding **${rank}** by ${count} vacant slot(s)...`);
  console.log(`Open slot before expand: ${openBefore ? openBefore.callsign : "none"}`);

  const result = await expandRankSlots(rank, count);

  const after = await getRosterRows();
  const openAfter = findOpenSlotInRank(after.entries, rank);

  console.log("\nDone.");
  console.log(`Sheet rank label: ${result.rank}`);
  console.log(`Added rows ${result.firstRow}-${result.lastRow}`);
  console.log(`Callsigns ${result.firstCallsign}-${result.lastCallsign}`);
  console.log(`Next open slot: ${openAfter?.callsign ?? "none"}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
