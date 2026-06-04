const { getRosterRows } = require("./client");
const { findRosterEntryForMember } = require("./roster-match");

function filterNamedRosterEntries(entries) {
  return entries.filter((entry) => entry.name.length > 0 && entry.callsign.length > 0);
}

async function getNamedRosterEntries({ entries: cachedEntries } = {}) {
  const entries = cachedEntries ?? (await getRosterRows()).entries;
  return filterNamedRosterEntries(entries);
}

module.exports = {
  findRosterEntryForMember,
  getNamedRosterEntries,
};
