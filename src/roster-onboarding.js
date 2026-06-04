const {
  isSheetsConfigured,
} = require("./google-sheets/client");
const {
  assignMemberToOpenRank,
  assignCadetCallsign,
} = require("./google-sheets/roster-assign");
const { syncMemberCallsignFromEntry } = require("./google-sheets/roster-sync");
const { getRosterCallsignForMember } = require("./google-sheets/roster-match");
const { recordMemberRosterLinkFromResult } = require("./roster-member-link");
const { assignMemberRosterRoles, sendCallsignDm } = require("./member-roster");
const { updateMemberCallsign } = require("./discord-callsign");

const { pauseRoleSyncForMember, pauseRoleSyncGlobally } = require("./role-sync-guard");
const { logRosterResultAudit } = require("./roster-audit-log");

async function refreshMemberAfterRoles(member, reason) {
  await assignMemberRosterRoles(member, reason);

  if (!member.guild) {
    return member;
  }

  try {
    return await member.guild.members.fetch({ user: member.id, force: true });
  } catch (error) {
    console.warn(`Could not refetch member ${member.id} after roster roles:`, error.message);
    return member;
  }
}

async function completeMemberRosterSetup(member, options) {
  const {
    roleplayName,
    sheetRank,
    useCadetCallsign = false,
    reason = "Roster setup",
    dmTitle,
    dmExtraLines = [],
    isCadet = false,
  } = options;

  if (!member || !roleplayName) {
    throw new Error("Member and roleplay name are required for roster setup.");
  }

  if (!isSheetsConfigured()) {
    throw new Error("Google Sheets is not configured on this bot.");
  }

  pauseRoleSyncGlobally(45_000);
  pauseRoleSyncForMember(member, 120_000);

  const rosterMember = await refreshMemberAfterRoles(member, reason);
  const currentCallsign = getRosterCallsignForMember(rosterMember);

  const rosterResult = useCadetCallsign
    ? await assignCadetCallsign(roleplayName, { currentCallsign, member: rosterMember })
    : await assignMemberToOpenRank(roleplayName, sheetRank, {
        currentCallsign,
        member: rosterMember,
      });

  const callsign = rosterResult.newCallsign ?? rosterResult.callsign;
  const rank = rosterResult.newRank ?? rosterResult.rank;

  const syncResult = await syncMemberCallsignFromEntry(
    rosterMember,
    {
      name: roleplayName,
      callsign,
      rank,
      rowNumber: rosterResult.rowNumber,
    },
    { dmOnChange: true },
  );

  if (!syncResult.nicknameResult?.ok) {
    await updateMemberCallsign(rosterMember, callsign, roleplayName);
  }

  let dmSent = syncResult.dmSent;
  if (!dmSent) {
    dmSent = await sendCallsignDm(rosterMember.user, {
      callsign,
      roleplayName,
      rank,
      isCadet: isCadet || /^C-/i.test(String(callsign)),
      title: dmTitle,
      extraLines: dmExtraLines,
    });
  }

  recordMemberRosterLinkFromResult(rosterMember, rosterResult);

  if (options.audit?.client) {
    await logRosterResultAudit(options.audit.client, rosterMember.guild.id, {
      trigger: options.audit.trigger ?? reason,
      actor: options.audit.actor,
      target: rosterMember,
      roleplayName,
      rosterResult,
      notes: options.audit.notes,
    }).catch(() => null);
  }

  return {
    member: rosterMember,
    rosterResult,
    syncResult,
    callsign,
    rank,
    dmSent,
  };
}

module.exports = {
  refreshMemberAfterRoles,
  completeMemberRosterSetup,
};
