const { getRosterRows, getCadetRankName } = require("./client");
const { ranksMatch } = require("../rank-matching");

function isOpenSlot(entry) {
  return entry.callsign.length > 0 && entry.name.length === 0;
}

async function getRosterRanksWithOpenSlots() {
  const { entries } = await getRosterRows();
  const openByRank = new Map();

  for (const entry of entries) {
    if (!isOpenSlot(entry)) continue;

    const existing = openByRank.get(entry.rank);
    if (existing) {
      existing.openCount += 1;
    } else {
      openByRank.set(entry.rank, { rank: entry.rank, openCount: 1 });
    }
  }

  return [...openByRank.values()].sort((left, right) =>
    left.rank.localeCompare(right.rank, undefined, { sensitivity: "base" }),
  );
}

function isCadetSheetRank(rankName) {
  return ranksMatch(getCadetRankName(), rankName);
}

function isCadetRosterEntry(entry) {
  return isCadetSheetRank(entry.rank) || /^C-\d{1,3}$/i.test(String(entry.callsign).trim());
}

module.exports = {
  getRosterRanksWithOpenSlots,
  isCadetSheetRank,
  isCadetRosterEntry,
};
