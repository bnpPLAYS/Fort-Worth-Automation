const {
  getRosterRows,
  batchUpdateCells,
  getRosterSheetName,
  isSheetsConfigured,
  getCadetRankName,
} = require("./client");
const { ranksMatch } = require("../rank-matching");

function normalize(value) {
  return String(value).trim().toLowerCase();
}

function findOpenSlotInRank(entries, newRank) {
  return entries.find(
    (entry) =>
      ranksMatch(newRank, entry.rank) &&
      entry.callsign.length > 0 &&
      entry.name.length === 0,
  );
}

function findEntriesForName(entries, roleplayName) {
  const normalizedName = normalize(roleplayName);
  return entries.filter(
    (entry) => entry.name.length > 0 && normalize(entry.name) === normalizedName,
  );
}

function findOpenCadetSlot(entries) {
  const cadetRank = getCadetRankName();

  return entries
    .filter(
      (entry) =>
        ranksMatch(cadetRank, entry.rank) &&
        /^C-\d{1,3}$/i.test(entry.callsign) &&
        entry.name.length === 0,
    )
    .map((entry) => ({
      ...entry,
      cadetNumber: Number.parseInt(entry.callsign.replace(/^C-/i, ""), 10),
    }))
    .filter((entry) => entry.cadetNumber >= 1 && entry.cadetNumber <= 100)
    .sort((left, right) => left.cadetNumber - right.cadetNumber)[0];
}

async function clearNameFromEntries(sheetName, entries) {
  if (entries.length === 0) return;

  await batchUpdateCells(
    entries.map((entry) => ({
      range: `${sheetName}!${entry.nameColumnLetter}${entry.rowNumber}`,
      values: [[""]],
    })),
  );
}

async function assignNameToSlot(sheetName, slot, roleplayName) {
  await batchUpdateCells([
    {
      range: `${sheetName}!${slot.nameColumnLetter}${slot.rowNumber}`,
      values: [[roleplayName]],
    },
  ]);
}

async function assignMemberToOpenRank(roleplayName, newRank) {
  const { entries, sheetName } = await getRosterRows();
  const openSlot = findOpenSlotInRank(entries, newRank);

  if (!openSlot) {
    throw new Error(
      `No open callsign slot found for rank **${newRank}**. Add a vacant row with that rank, a callsign, and an empty RP NAME cell.`,
    );
  }

  const existingEntries = findEntriesForName(entries, roleplayName);
  await clearNameFromEntries(sheetName, existingEntries);
  await assignNameToSlot(sheetName, openSlot, roleplayName);

  return {
    roleplayName,
    previousRank: existingEntries[0]?.rank ?? null,
    previousCallsign: existingEntries[0]?.callsign ?? null,
    newRank: openSlot.rank,
    newCallsign: openSlot.callsign,
    rolls: openSlot.rolls,
  };
}

async function assignCadetCallsign(roleplayName) {
  const { entries, sheetName } = await getRosterRows();
  const openSlot = findOpenCadetSlot(entries);

  if (!openSlot) {
    throw new Error(
      "No open cadet callsign slots (C-1 through C-100). Add CADET rows with callsigns C-1 to C-100 and empty RP NAME cells.",
    );
  }

  const existingEntries = findEntriesForName(entries, roleplayName);
  await clearNameFromEntries(sheetName, existingEntries);
  await assignNameToSlot(sheetName, openSlot, roleplayName);

  return {
    roleplayName,
    rank: openSlot.rank,
    callsign: openSlot.callsign.toUpperCase(),
  };
}

async function clearRosterForName(roleplayName) {
  const { entries, sheetName } = await getRosterRows();
  const existingEntries = findEntriesForName(entries, roleplayName);
  await clearNameFromEntries(sheetName, existingEntries);
  return existingEntries.length;
}

async function findRosterEntriesForName(roleplayName) {
  const { entries } = await getRosterRows();
  return findEntriesForName(entries, roleplayName);
}

module.exports = {
  isSheetsConfigured,
  findOpenSlotInRank,
  assignMemberToOpenRank,
  assignCadetCallsign,
  clearRosterForName,
  findRosterEntriesForName,
};
