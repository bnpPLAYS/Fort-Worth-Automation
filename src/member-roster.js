const { MEMBER_ROSTER_ROLE_IDS } = require("./constants");
const { formatCallsignForDisplay } = require("./discord-callsign");

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

module.exports = {
  assignMemberRosterRoles,
  sendCallsignDm,
  mergeRoleIds,
};
