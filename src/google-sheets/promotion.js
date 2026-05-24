const { getRosterRows, batchUpdateCells, getRosterSheetName } = require("./client");

const PROMOTION_CHANNEL_ID = "1499207295895339048";

function normalize(value) {
  return String(value).trim().toLowerCase();
}

function parsePromotionMessage(content) {
  const nameMatch = content.match(/Roleplay Name:\s*(.+)/i);
  const callsignMatch = content.match(/Current Callsign:\s*(.+)/i);
  const rankMatch = content.match(/New Rank:\s*(.+)/i);

  if (!nameMatch || !callsignMatch || !rankMatch) {
    return null;
  }

  return {
    roleplayName: nameMatch[1].trim(),
    currentCallsign: callsignMatch[1].trim(),
    newRank: rankMatch[1].trim(),
  };
}

function findCurrentEntry(entries, roleplayName, currentCallsign) {
  const normalizedName = normalize(roleplayName);
  const normalizedCallsign = normalize(currentCallsign);

  return entries.find(
    (entry) =>
      normalize(entry.name) === normalizedName &&
      normalize(entry.callsign) === normalizedCallsign &&
      entry.name.length > 0,
  );
}

function findOpenSlotInRank(entries, newRank) {
  const normalizedRank = normalize(newRank);

  return entries.find(
    (entry) =>
      normalize(entry.rank) === normalizedRank &&
      entry.callsign.length > 0 &&
      entry.name.length === 0,
  );
}

async function processPromotion({ roleplayName, currentCallsign, newRank }) {
  const { entries } = await getRosterRows();

  const currentEntry = findCurrentEntry(entries, roleplayName, currentCallsign);
  if (!currentEntry) {
    throw new Error(
      `Could not find **${roleplayName}** at callsign **${currentCallsign}**. Check the name and callsign in the sheet.`,
    );
  }

  const openSlot = findOpenSlotInRank(entries, newRank);
  if (!openSlot) {
    throw new Error(
      `No open callsign slot found for rank **${newRank}**. Add a vacant row (callsign filled, name empty) in the sheet.`,
    );
  }

  const sheetName = getRosterSheetName();

  await batchUpdateCells([
    {
      range: `${sheetName}!C${currentEntry.rowNumber}`,
      values: [[""]],
    },
    {
      range: `${sheetName}!C${openSlot.rowNumber}`,
      values: [[roleplayName]],
    },
  ]);

  return {
    previousRank: currentEntry.rank,
    previousCallsign: currentEntry.callsign,
    newRank: openSlot.rank,
    newCallsign: openSlot.callsign,
    division: openSlot.division,
  };
}

module.exports = {
  PROMOTION_CHANNEL_ID,
  parsePromotionMessage,
  processPromotion,
};
