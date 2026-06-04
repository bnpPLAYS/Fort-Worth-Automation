const {
  getRosterRows,
  batchUpdateCells,
  getRosterSheetName,
  isSheetsConfigured,
  getCadetRankName,
} = require("./client");
const { expandRankSlots } = require("./roster-expand");
const { ranksMatch } = require("../rank-matching");
const { findUserIdByCallsign } = require("../roster-links-store");
const {
  findEntriesToClearForAssignment,
  findNamedEntriesByCallsign,
  isCallsignOccupiedOnSheet,
  getRosterCallsignForMember,
  filterEntriesByName,
  resolveEntriesByNameAndCallsign,
} = require("./roster-match");
const { formatCallsignForDisplay } = require("../discord-callsign");

function findOpenSlotInRank(entries, newRank) {
  return entries.find((entry) => {
    if (!ranksMatch(newRank, entry.rank)) return false;
    if (!entry.callsign.length || entry.name.length > 0) return false;
    if (isCallsignOccupiedOnSheet(entries, entry.callsign)) return false;
    return true;
  });
}

function findOpenCadetSlot(entries) {
  const cadetRank = getCadetRankName();

  return entries
    .filter((entry) => {
      if (!ranksMatch(cadetRank, entry.rank)) return false;
      if (!/^C-\d{1,3}$/i.test(entry.callsign)) return false;
      if (entry.name.length > 0) return false;
      if (isCallsignOccupiedOnSheet(entries, entry.callsign)) return false;
      return true;
    })
    .map((entry) => ({
      ...entry,
      cadetNumber: Number.parseInt(entry.callsign.replace(/^C-/i, ""), 10),
    }))
    .filter((entry) => entry.cadetNumber >= 1 && entry.cadetNumber <= 100)
    .sort((left, right) => left.cadetNumber - right.cadetNumber)[0];
}

function validateOpenSlotAssignment(entries, slot, { member, roleplayName } = {}) {
  const owners = findNamedEntriesByCallsign(entries, slot.callsign);
  if (owners.length > 0) {
    throw new Error(
      `Callsign **${formatCallsignForDisplay(slot.callsign)}** is already assigned to **${owners[0].name}** on the roster.`,
    );
  }

  const linkedUserId = findUserIdByCallsign(slot.callsign);
  if (linkedUserId && linkedUserId !== member?.id) {
    throw new Error(
      `Callsign **${formatCallsignForDisplay(slot.callsign)}** is linked to another Discord account. Pick a different open slot or clear the existing link first.`,
    );
  }
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

async function assignMemberToOpenRank(
  roleplayName,
  newRank,
  { currentCallsign, expandCount, member } = {},
) {
  let { entries, sheetName } = await getRosterRows();
  let openSlot = findOpenSlotInRank(entries, newRank);

  if (!openSlot) {
    const expansion = await expandRankSlots(newRank, expandCount);
    console.log(
      `Expanded roster rank ${expansion.rank} by ${expansion.count} rows (${expansion.firstCallsign}-${expansion.lastCallsign})`,
    );
    ({ entries, sheetName } = await getRosterRows({ fresh: true }));
    openSlot = findOpenSlotInRank(entries, newRank);
  }

  if (!openSlot) {
    throw new Error(
      `No open callsign slot found for rank **${newRank}** after expanding the roster.`,
    );
  }

  validateOpenSlotAssignment(entries, openSlot, { member, roleplayName });

  const existingEntries = findEntriesToClearForAssignment(entries, roleplayName, {
    currentCallsign,
    member,
  });

  if (existingEntries.some((entry) => entry.rowNumber === openSlot.rowNumber)) {
    throw new Error(
      `Refusing to overwrite roster row **${openSlot.rowNumber}** — it already belongs to **${roleplayName}**.`,
    );
  }

  await clearNameFromEntries(sheetName, existingEntries);
  await assignNameToSlot(sheetName, openSlot, roleplayName);

  return {
    roleplayName,
    previousRank: existingEntries[0]?.rank ?? null,
    previousCallsign: existingEntries[0]?.callsign ?? null,
    newRank: openSlot.rank,
    newCallsign: openSlot.callsign,
    rolls: openSlot.rolls,
    rowNumber: openSlot.rowNumber,
  };
}

async function assignCadetCallsign(roleplayName, { currentCallsign, member } = {}) {
  const { entries, sheetName } = await getRosterRows();
  const openSlot = findOpenCadetSlot(entries);

  if (!openSlot) {
    throw new Error(
      "No open cadet callsign slots (C-1 through C-100). Add CADET rows with callsigns C-1 to C-100 and empty RP NAME cells.",
    );
  }

  validateOpenSlotAssignment(entries, openSlot, { member, roleplayName });

  const existingEntries = findEntriesToClearForAssignment(entries, roleplayName, {
    currentCallsign,
    member,
  });

  await clearNameFromEntries(sheetName, existingEntries);
  await assignNameToSlot(sheetName, openSlot, roleplayName);

  return {
    roleplayName,
    rank: openSlot.rank,
    callsign: openSlot.callsign.toUpperCase(),
    rowNumber: openSlot.rowNumber,
  };
}

async function clearRosterForName(roleplayName, { currentCallsign, member } = {}) {
  const { entries, sheetName } = await getRosterRows();
  const existingEntries = findEntriesToClearForAssignment(entries, roleplayName, {
    currentCallsign,
    member,
  });
  await clearNameFromEntries(sheetName, existingEntries);
  return existingEntries.length;
}

async function findRosterEntriesForName(roleplayName, { callsign, member, entries: cachedEntries } = {}) {
  const entries = cachedEntries ?? (await getRosterRows()).entries;
  const resolvedCallsign = callsign || (member ? getRosterCallsignForMember(member) : null);

  if (resolvedCallsign) {
    return resolveEntriesByNameAndCallsign(entries, roleplayName, resolvedCallsign, {
      requireUnique: false,
    });
  }

  return filterEntriesByName(entries, roleplayName);
}

module.exports = {
  isSheetsConfigured,
  findOpenSlotInRank,
  assignMemberToOpenRank,
  assignCadetCallsign,
  clearRosterForName,
  findRosterEntriesForName,
};
