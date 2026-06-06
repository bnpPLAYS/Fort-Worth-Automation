const { getRosterCallsignForMember } = require("./google-sheets/roster-match");
const { clearRosterForName, isSheetsConfigured } = require("./google-sheets/roster-assign");
const { resolveRoleplayNameForMember } = require("./google-sheets/roster-sync");
const { removeMemberRosterLink } = require("./roster-member-link");
const { getRosterLink } = require("./roster-links-store");
const { clearCadetInactivityRecord } = require("./cadet-inactivity");
const { clearMemberNicknameCallsign } = require("./internal-affairs");
const { pauseRoleSyncForMember, isRoleSyncPaused } = require("./role-sync-guard");
const { logRosterAudit } = require("./roster-audit-log");
const { getErrorMessage } = require("./embed-utils");

async function processMemberRosterRemoval(
  client,
  member,
  { reason = "role_removal", entries, identityMember = member } = {},
) {
  if (!member?.guild) {
    return { status: "skipped", reason: "missing_member" };
  }

  if (isRoleSyncPaused(member)) {
    return { status: "skipped", reason: "paused" };
  }

  if (!isSheetsConfigured()) {
    return { status: "skipped", reason: "sheets_not_configured" };
  }

  pauseRoleSyncForMember(member, 120_000);

  const fallbackName = member.user?.username ?? identityMember.user?.username ?? "";
  const roleplayName = await resolveRoleplayNameForMember(identityMember, fallbackName, { entries });
  const link = getRosterLink(member.id);
  const currentCallsign =
    getRosterCallsignForMember(identityMember) ||
    getRosterCallsignForMember(member) ||
    link?.callsign;

  let clearedCount = 0;

  try {
    clearedCount = await clearRosterForName(roleplayName || link?.roleplayName, {
      currentCallsign,
      member,
    });
  } catch (error) {
    console.error(`[roster-removal] Sheet clear failed for ${member.id}:`, error);
    return { status: "failed", error: getErrorMessage(error) };
  }

  removeMemberRosterLink(member);
  clearCadetInactivityRecord(member.id);

  const nicknameResult = await clearMemberNicknameCallsign(
    member,
    roleplayName || link?.roleplayName,
  );

  console.log(
    `[roster-removal] ${member.displayName}: cleared ${clearedCount} row(s), reason=${reason}`,
  );

  await logRosterAudit(client, member.guild.id, {
    title: "Roster removal — department roles removed",
    target: member,
    roleplayName: roleplayName || link?.roleplayName,
    callsign: currentCallsign || undefined,
    trigger: reason,
    notes: [
      `Cleared ${clearedCount} roster row(s).`,
      nicknameResult.changed ? `Nickname set to \`${nicknameResult.nickname}\`.` : null,
      nicknameResult.ok ? null : `Nickname not updated: ${nicknameResult.reason}`,
    ]
      .filter(Boolean)
      .join("\n"),
  }).catch(() => null);

  return {
    status: "removed",
    clearedCount,
    nicknameResult,
    roleplayName: roleplayName || link?.roleplayName,
  };
}

module.exports = {
  processMemberRosterRemoval,
};
