const {
  extractCallsignFromDisplayName,
  extractDepartmentCallsignFromDisplayName,
  formatCallsignForDisplay,
  getRoleplayNameFromMember,
  callsignsMatch,
} = require("../discord-callsign");
const { getRosterLink } = require("../roster-links-store");
const { hasRosterSyncRole } = require("../member-roster");

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

function findEntryByStoredLink(namedEntries, link) {
  if (!link?.roleplayName) return null;

  const normalizedLinkName = normalizeName(link.roleplayName);

  if (link.rowNumber) {
    const byRow = namedEntries.find((entry) => entry.rowNumber === link.rowNumber);
    if (byRow && normalizeName(byRow.name) === normalizedLinkName) {
      return byRow;
    }
  }

  const byNameAndCallsign = namedEntries.filter(
    (entry) =>
      normalizeName(entry.name) === normalizedLinkName &&
      link.callsign &&
      callsignsMatch(entry.callsign, link.callsign),
  );

  if (byNameAndCallsign.length === 1) {
    return byNameAndCallsign[0];
  }

  if (link.rowNumber) {
    const byRow = namedEntries.find((entry) => entry.rowNumber === link.rowNumber);
    if (byRow && normalizeName(byRow.name) === normalizedLinkName) {
      return byRow;
    }
  }

  return null;
}

function getMemberRosterIdentity(member) {
  const displayName = String(member?.displayName ?? "").trim();
  const callsign = extractDepartmentCallsignFromDisplayName(displayName);
  const roleplayName = normalizeName(getRoleplayNameFromMember(member));
  return { displayName, callsign, roleplayName };
}

function entryMatchesMemberIdentity(entry, { callsign, roleplayName }) {
  if (!callsign || !callsignsMatch(entry.callsign, callsign)) {
    return false;
  }

  if (roleplayName && roleplayName.length >= 2) {
    return normalizeName(entry.name) === roleplayName;
  }

  return true;
}

function findRosterEntryForMember(entries, member) {
  const namedEntries = entries.filter((entry) => entry.name.length > 0);
  if (namedEntries.length === 0 || !member || !hasRosterSyncRole(member)) return null;

  const identity = getMemberRosterIdentity(member);
  const { callsign, roleplayName } = identity;

  if (callsign && roleplayName) {
    const matches = namedEntries.filter((entry) => entryMatchesMemberIdentity(entry, identity));
    if (matches.length === 1) {
      return matches[0];
    }

    const callsignRows = namedEntries.filter((entry) => callsignsMatch(entry.callsign, callsign));
    if (callsignRows.length > 0) {
      return null;
    }
  }

  if (callsign && !roleplayName) {
    const byCallsign = namedEntries.filter((entry) => callsignsMatch(entry.callsign, callsign));
    if (byCallsign.length === 1) {
      return byCallsign[0];
    }
    return null;
  }

  if (roleplayName && !callsign) {
    const byName = namedEntries.filter((entry) => normalizeName(entry.name) === roleplayName);
    if (byName.length === 1) {
      return byName[0];
    }
  }

  return null;
}

function getCallsignFromMember(member) {
  const callsign = extractCallsignFromDisplayName(member?.displayName);
  return callsign || null;
}

/** Callsign from department nickname (`3000 | Name`), or from stored link. */
function getRosterCallsignForMember(member) {
  if (!hasRosterSyncRole(member)) return null;

  const fromNickname = extractDepartmentCallsignFromDisplayName(member?.displayName);
  if (fromNickname) return fromNickname;

  const link = member?.id ? getRosterLink(member.id) : null;
  return link?.callsign ? formatCallsignForDisplay(link.callsign) : null;
}

function getLinkedRoleplayName(member) {
  if (!hasRosterSyncRole(member)) return null;
  const link = member?.id ? getRosterLink(member.id) : null;
  return link?.roleplayName?.trim() || null;
}

module.exports = {
  normalizeName,
  callsignsMatch,
  filterEntriesByName,
  resolveEntriesByNameAndCallsign,
  getMemberRosterIdentity,
  entryMatchesMemberIdentity,
  findRosterEntryForMember,
  getCallsignFromMember,
  getRosterCallsignForMember,
  getLinkedRoleplayName,
};
