const {
  MEMBER_ROSTER_ROLE_IDS,
  ROSTER_SYNC_ROLE_ID,
  PROBATIONARY_OFFICER_ROLE_ID,
  CADET_DISCORD_ROLE_ID,
} = require("./constants");

const DEPARTMENT_PERSONNEL_ROLE_ID = MEMBER_ROSTER_ROLE_IDS.find(
  (roleId) => roleId !== ROSTER_SYNC_ROLE_ID,
);
const { formatCallsignForDisplay } = require("./discord-callsign");
const { getRosterCallsignForMember } = require("./google-sheets/roster-match");

async function assignMemberRosterRoles(member, reason = "Roster member setup") {
  if (!member) {
    return { added: [], failed: [], skipped: true };
  }

  const toAdd = MEMBER_ROSTER_ROLE_IDS.filter((roleId) => !member.roles.cache.has(roleId));
  if (toAdd.length === 0) {
    return { added: [], failed: [] };
  }

  try {
    await member.roles.add(toAdd, reason);
    return { added: toAdd, failed: [] };
  } catch (error) {
    console.error("Failed to assign member roster roles:", error);
    return { added: [], failed: toAdd, error: error.message };
  }
}

async function sendCallsignDm(user, options) {
  const {
    callsign,
    roleplayName,
    rank,
    isCadet = false,
    title,
    extraLines = [],
  } = options;

  if (!user || !callsign) return false;

  const formattedCallsign = formatCallsignForDisplay(callsign);
  const lines = [
    title ?? "Your roster callsign has been updated.",
    "",
    `**Callsign:** ${formattedCallsign}`,
  ];

  if (roleplayName) {
    lines.push(`**Roster name:** ${roleplayName}`);
  }
  if (rank) {
    lines.push(`**Rank:** ${rank}`);
  }

  if (isCadet) {
    lines.push(
      "",
      "This is your **cadet** callsign. **Do not use it in-game** until you are promoted and receive a department callsign.",
    );
  } else {
    lines.push("", "You may use this callsign in-game.");
  }

  if (extraLines.length > 0) {
    lines.push("", ...extraLines);
  }

  try {
    await user.send(lines.join("\n"));
    return true;
  } catch {
    return false;
  }
}

function mergeRoleIds(...roleIdLists) {
  return [...new Set(roleIdLists.flat().filter(Boolean))];
}

/** Department roster members eligible for /sync-promotions and /refresh-callsign */
function hasRosterSyncRole(member) {
  if (!member || member.user?.bot) return false;
  return member.roles?.cache?.has(ROSTER_SYNC_ROLE_ID) ?? false;
}

const RECRUITMENT_BLOCKED_MESSAGE =
  "You are already on the department roster and cannot use **Become Cadet**, **Quiz**, or **Voice Interview**.";

/** Full department members — not cadet-track applicants with only a roster-sync role. */
function isDepartmentMember(member) {
  if (!member || member.user?.bot) return false;
  if (member.roles?.cache?.has(PROBATIONARY_OFFICER_ROLE_ID)) return true;
  if (
    hasRosterSyncRole(member) &&
    DEPARTMENT_PERSONNEL_ROLE_ID &&
    member.roles?.cache?.has(DEPARTMENT_PERSONNEL_ROLE_ID)
  ) {
    return true;
  }
  return false;
}

/** Quiz and voice interview are for applicants who are not already department members. */
function isBlockedFromRecruitmentFlows(member) {
  return isDepartmentMember(member);
}

function isCadetTrackMember(member) {
  if (!member || member.user?.bot || isDepartmentMember(member)) return false;
  if (member.roles?.cache?.has(CADET_DISCORD_ROLE_ID)) return true;
  if (!hasRosterSyncRole(member)) return false;

  const callsign = getRosterCallsignForMember(member);
  return /^C-/i.test(String(callsign ?? ""));
}

function getCadetEnrollBlockReason(member) {
  if (!member) return null;
  if (isDepartmentMember(member)) {
    return RECRUITMENT_BLOCKED_MESSAGE;
  }
  if (member.roles?.cache?.has(CADET_DISCORD_ROLE_ID) || isCadetTrackMember(member)) {
    return "You are already enrolled as a **Cadet**.";
  }
  return null;
}

module.exports = {
  assignMemberRosterRoles,
  sendCallsignDm,
  mergeRoleIds,
  hasRosterSyncRole,
  isDepartmentMember,
  isCadetTrackMember,
  isBlockedFromRecruitmentFlows,
  getCadetEnrollBlockReason,
  RECRUITMENT_BLOCKED_MESSAGE,
};
