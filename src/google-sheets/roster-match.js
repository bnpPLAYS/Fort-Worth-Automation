const {
  extractCallsignFromDisplayName,
  formatCallsignForDisplay,
  getRoleplayNameFromMember,
  callsignsMatch,
} = require("../discord-callsign");

function normalizeName(value) {
  return String(value).trim().toLowerCase();
}

function filterEntriesByName(entries, roleplayName) {
  const normalizedName = normalizeName(roleplayName);
  return entries.filter(
    (entry) => entry.name.length > 0 && normalizeName(entry.name) === normalizedName,
  );
}

function resolveEntriesByNameAndCallsign(entries, roleplayName, callsign, { requireUnique = true } = {}) {
  const byName = filterEntriesByName(entries, roleplayName);

  if (byName.length === 0) {
    return [];
  }

  if (byName.length === 1) {
    return byName;
  }

  if (!callsign) {
    if (requireUnique) {
      throw new Error(
        `Multiple roster rows found for **${roleplayName}**. ` +
          `They must have their callsign in their Discord nickname (e.g. \`3005 | ${roleplayName}\`).`,
      );
    }
    return byName;
  }

  const byCallsign = byName.filter((entry) => callsignsMatch(entry.callsign, callsign));

  if (byCallsign.length === 0) {
    throw new Error(
      `No roster row for **${roleplayName}** at callsign **${formatCallsignForDisplay(callsign)}**.`,
    );
  }

  return byCallsign;
}

function findRosterEntryForMember(entries, member) {
  const namedEntries = entries.filter((entry) => entry.name.length > 0);
  if (namedEntries.length === 0) return null;

  const memberCallsign = extractCallsignFromDisplayName(member.displayName);
  const roleplayName = normalizeName(getRoleplayNameFromMember(member));

  if (memberCallsign) {
    const byCallsign = namedEntries.filter((entry) => callsignsMatch(entry.callsign, memberCallsign));
    if (byCallsign.length === 1) {
      return byCallsign[0];
    }
    if (byCallsign.length > 1) {
      const narrowed = byCallsign.filter((entry) => normalizeName(entry.name) === roleplayName);
      if (narrowed.length === 1) {
        return narrowed[0];
      }
    }
  }

  const byName = namedEntries.filter((entry) => normalizeName(entry.name) === roleplayName);
  if (byName.length === 1) {
    return byName[0];
  }

  return null;
}

function getCallsignFromMember(member) {
  const callsign = extractCallsignFromDisplayName(member?.displayName);
  return callsign || null;
}

module.exports = {
  normalizeName,
  callsignsMatch,
  filterEntriesByName,
  resolveEntriesByNameAndCallsign,
  findRosterEntryForMember,
  getCallsignFromMember,
};
