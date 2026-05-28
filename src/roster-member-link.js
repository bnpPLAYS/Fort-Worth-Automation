const { setRosterLink, clearRosterLink, purgeRosterLinks } = require("./roster-links-store");
const { hasRosterSyncRole } = require("./member-roster");

function toUserId(memberOrId) {
  if (!memberOrId) return null;
  if (typeof memberOrId === "string") return memberOrId;
  return memberOrId.id ?? memberOrId.user?.id ?? null;
}

function recordMemberRosterLink(memberOrId, entry) {
  const userId = toUserId(memberOrId);
  if (!userId || !entry?.name) return null;

  return setRosterLink(userId, {
    roleplayName: entry.name,
    callsign: entry.callsign,
    rank: entry.rank,
    rowNumber: entry.rowNumber,
  });
}

function recordMemberRosterLinkFromResult(memberOrId, rosterResult) {
  if (!rosterResult) return null;

  return recordMemberRosterLink(memberOrId, {
    name: rosterResult.roleplayName,
    callsign: rosterResult.newCallsign ?? rosterResult.callsign,
    rank: rosterResult.newRank ?? rosterResult.rank,
    rowNumber: rosterResult.rowNumber,
  });
}

function removeMemberRosterLink(memberOrId) {
  return clearRosterLink(toUserId(memberOrId));
}

function purgeRosterLinksWithoutSyncRole(guild) {
  return purgeRosterLinks(guild, (member) => hasRosterSyncRole(member));
}

module.exports = {
  recordMemberRosterLink,
  recordMemberRosterLinkFromResult,
  removeMemberRosterLink,
  purgeRosterLinksWithoutSyncRole,
};
