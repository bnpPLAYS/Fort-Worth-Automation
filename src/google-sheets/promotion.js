const { getRosterRows, batchUpdateCells, getRosterSheetName } = require("./client");
const {
  findOpenSlotInRank,
  assignMemberToOpenRank,
} = require("./roster-assign");

const PROMOTION_CHANNEL_ID = "1499207295895339048";

function normalize(value) {
  return String(value).trim().toLowerCase();
}

function normalizeCallsign(value) {
  return String(value).replace(/\D/g, "");
}

function parsePromotionMessage(content) {
  const block = content.trim();

  const labeledMatch =
    block.match(/(?:Roleplay Name|RP Name):\s*(.+?)\s*Current Callsign:\s*(.+?)\s*New Rank:\s*(.+)/is);

  if (labeledMatch) {
    return {
      roleplayName: labeledMatch[1].trim(),
      currentCallsign: normalizeCallsign(labeledMatch[2]),
      newRank: labeledMatch[3].trim(),
    };
  }

  const nameMatch =
    block.match(/Roleplay Name:\s*([\s\S]*?)(?=\r?\n\s*Current Callsign:|$)/i) ||
    block.match(/RP Name:\s*([\s\S]*?)(?=\r?\n\s*Current Callsign:|$)/i);
  const callsignMatch = block.match(/Current Callsign:\s*([\s\S]*?)(?=\r?\n\s*New Rank:|$)/i);
  const rankMatch = block.match(/New Rank:\s*([\s\S]*?)$/i);

  if (!nameMatch || !callsignMatch || !rankMatch) {
    return null;
  }

  return {
    roleplayName: nameMatch[1].trim(),
    currentCallsign: normalizeCallsign(callsignMatch[1]),
    newRank: rankMatch[1].trim(),
  };
}

function buildNotFoundError(entries, roleplayName, currentCallsign) {
  const normalizedName = normalize(roleplayName);
  const normalizedCallsign = normalizeCallsign(currentCallsign);
  const matchesForName = entries.filter(
    (entry) => entry.name.length > 0 && normalize(entry.name) === normalizedName,
  );

  if (matchesForName.length === 1) {
    const entry = matchesForName[0];
    return [
      `Could not find **${roleplayName}** at callsign **${currentCallsign}**.`,
      `That name is on the roster at callsign **${entry.callsign}** (${entry.rank}).`,
      "Use your **current** callsign from the sheet in the message.",
    ].join(" ");
  }

  if (matchesForName.length > 1) {
    const callsigns = matchesForName.map((entry) => entry.callsign).join(", ");
    return `Found multiple roster rows for **${roleplayName}** (callsigns: ${callsigns}). Contact staff.`;
  }

  return `Could not find **${roleplayName}** at callsign **${currentCallsign}**. Check the RP NAME and CALLSIGN in the sheet.`;
}

function findCurrentEntry(entries, roleplayName, currentCallsign) {
  const normalizedName = normalize(roleplayName);
  const normalizedCallsign = normalizeCallsign(currentCallsign);

  return entries.find(
    (entry) =>
      normalize(entry.name) === normalizedName &&
      normalizeCallsign(entry.callsign) === normalizedCallsign &&
      entry.name.length > 0,
  );
}

async function processPromotion({ roleplayName, currentCallsign, newRank }) {
  const { entries } = await getRosterRows();

  const currentEntry = findCurrentEntry(entries, roleplayName, currentCallsign);
  if (!currentEntry) {
    throw new Error(buildNotFoundError(entries, roleplayName, currentCallsign));
  }

  const openSlot = findOpenSlotInRank(entries, newRank);
  if (!openSlot) {
    throw new Error(
      `No open callsign slot found for rank **${newRank}**. Add a vacant row with that rank, a 4-digit callsign, and an empty RP NAME cell.`,
    );
  }

  const sheetName = getRosterSheetName();
  const nameColumn = currentEntry.nameColumnLetter;

  await batchUpdateCells([
    {
      range: `${sheetName}!${nameColumn}${currentEntry.rowNumber}`,
      values: [[""]],
    },
    {
      range: `${sheetName}!${openSlot.nameColumnLetter}${openSlot.rowNumber}`,
      values: [[roleplayName]],
    },
  ]);

  return {
    roleplayName,
    previousRank: currentEntry.rank,
    previousCallsign: currentEntry.callsign,
    newRank: openSlot.rank,
    newCallsign: openSlot.callsign,
    rolls: openSlot.rolls,
    rowNumber: openSlot.rowNumber,
  };
}

module.exports = {
  PROMOTION_CHANNEL_ID,
  parsePromotionMessage,
  processPromotion,
  assignMemberToOpenRank,
};
