const { getRosterRows } = require("./client");
const {
  formatCallsignForDisplay,
  extractCallsignFromDisplayName,
  getRoleplayNameFromMember,
} = require("../discord-callsign");

function normalizeName(value) {
  return String(value).trim().toLowerCase();
}

function callsignsMatch(sheetCallsign, memberCallsign) {
  const formattedSheet = formatCallsignForDisplay(sheetCallsign);
  const formattedMember = formatCallsignForDisplay(memberCallsign);

  if (/^C-/i.test(formattedSheet)) {
    return formattedSheet.toUpperCase() === formattedMember.toUpperCase();
  }

  return (
    String(formattedSheet).replace(/\D/g, "") === String(formattedMember).replace(/\D/g, "")
  );
}

function findRosterEntryForMember(entries, member) {
  const namedEntries = entries.filter((entry) => entry.name.length > 0);
  if (namedEntries.length === 0) return null;

  const roleplayName = normalizeName(getRoleplayNameFromMember(member));
  const byName = namedEntries.filter((entry) => normalizeName(entry.name) === roleplayName);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return byName[0];

  const memberCallsign = extractCallsignFromDisplayName(member.displayName);
  if (!memberCallsign) return null;

  const byCallsign = namedEntries.filter((entry) =>
    callsignsMatch(entry.callsign, memberCallsign),
  );
  if (byCallsign.length === 1) return byCallsign[0];

  return null;
}

async function getNamedRosterEntries() {
  const { entries } = await getRosterRows();
  return entries.filter((entry) => entry.name.length > 0 && entry.callsign.length > 0);
}

module.exports = {
  findRosterEntryForMember,
  getNamedRosterEntries,
};
