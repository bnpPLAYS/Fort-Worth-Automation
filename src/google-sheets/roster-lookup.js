const { getRosterRows } = require("./client");
const { findRosterEntryForMember } = require("./roster-match");

async function getNamedRosterEntries() {
  const { entries } = await getRosterRows();
  return entries.filter((entry) => entry.name.length > 0 && entry.callsign.length > 0);
}

module.exports = {
  findRosterEntryForMember,
  getNamedRosterEntries,
};
