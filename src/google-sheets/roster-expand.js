const {
  getRosterRows,
  invalidateRosterCache,
  batchUpdateCells,
  getSheetsClient,
  getSpreadsheetId,
  getRosterSheetName,
  getSheetId,
  columnIndexToLetter,
} = require("./client");
const { ranksMatch } = require("../rank-matching");

const DEFAULT_EXPAND_COUNT = Number.parseInt(process.env.ROSTER_EXPAND_BATCH_SIZE || "20", 10);

function getRankBlockEntries(entries, rank) {
  return entries
    .filter((entry) => ranksMatch(rank, entry.rank))
    .sort((left, right) => left.rowNumber - right.rowNumber);
}

function formatNextCallsign(blockEntries, offset) {
  let maxNum = 0;
  let padWidth = 4;

  for (const entry of blockEntries) {
    const digits = String(entry.callsign).replace(/\D/g, "");
    if (!digits) continue;

    const num = Number.parseInt(digits, 10);
    if (Number.isFinite(num) && num > maxNum) {
      maxNum = num;
    }
    padWidth = Math.max(padWidth, digits.length);
  }

  return String(maxNum + 1 + offset).padStart(padWidth, "0");
}

async function expandRankSlots(rank, count = DEFAULT_EXPAND_COUNT) {
  const batchSize = Number.isFinite(count) && count > 0 ? count : DEFAULT_EXPAND_COUNT;
  const { entries, sheetName, rankIndex, nameIndex, callsignIndex, rollsIndex } = await getRosterRows();
  const block = getRankBlockEntries(entries, rank);

  if (block.length === 0) {
    throw new Error(
      `No existing roster rows found for rank **${rank}**. Add at least one row with that rank and a callsign on the sheet first.`,
    );
  }

  const template = block[block.length - 1];
  const lastRowNumber = template.rowNumber;
  const sheetId = await getSheetId(sheetName);
  const sheets = await getSheetsClient();
  const startIndex = lastRowNumber;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      requests: [
        {
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex,
              endIndex: startIndex + batchSize,
            },
            inheritFromBefore: true,
          },
        },
      ],
    },
  });

  invalidateRosterCache();

  const rankCol = columnIndexToLetter(rankIndex);
  const nameCol = columnIndexToLetter(nameIndex);
  const callsignCol = columnIndexToLetter(callsignIndex);
  const rollsCol = rollsIndex === -1 ? null : columnIndexToLetter(rollsIndex);
  const templateRolls = template.rolls ?? "";
  const updates = [];

  for (let i = 0; i < batchSize; i += 1) {
    const rowNumber = lastRowNumber + 1 + i;
    const callsign = formatNextCallsign(block, i);

    updates.push({ range: `${sheetName}!${rankCol}${rowNumber}`, values: [[template.rank]] });
    updates.push({ range: `${sheetName}!${nameCol}${rowNumber}`, values: [[""]] });
    updates.push({ range: `${sheetName}!${callsignCol}${rowNumber}`, values: [[callsign]] });

    if (rollsCol && templateRolls) {
      updates.push({ range: `${sheetName}!${rollsCol}${rowNumber}`, values: [[templateRolls]] });
    }
  }

  await batchUpdateCells(updates);

  return {
    rank: template.rank,
    count: batchSize,
    firstRow: lastRowNumber + 1,
    lastRow: lastRowNumber + batchSize,
    firstCallsign: formatNextCallsign(block, 0),
    lastCallsign: formatNextCallsign(block, batchSize - 1),
  };
}

module.exports = {
  expandRankSlots,
  DEFAULT_EXPAND_COUNT,
  getRankBlockEntries,
};
