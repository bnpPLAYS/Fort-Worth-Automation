const { extractDepartmentCallsignFromDisplayName } = require("./discord-callsign");
const { canBypassRankEligibility } = require("./rank-eligibility");

function normalizeName(value) {
  return String(value).trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeCallsign(value) {
  return String(value).replace(/\D/g, "");
}

function roleplayNameMatchesMember(roleplayName, member) {
  const target = normalizeName(roleplayName);
  if (!target || target.length < 2) {
    return false;
  }

  const displayName = member.displayName ?? "";
  const nameParts = [
    displayName,
    displayName.split("|").pop(),
    member.user?.username ?? "",
    member.user?.globalName ?? "",
  ]
    .map((part) => normalizeName(part))
    .filter(Boolean);

  return nameParts.some(
    (part) => part.includes(target) || target.includes(part),
  );
}

function validatePromotionRequester(authorMember, parsed, { staffBypass = false } = {}) {
  if (staffBypass) {
    return { ok: true, targetMember: null };
  }

  if (!authorMember) {
    return {
      ok: false,
      message: "Could not verify your server membership for this request.",
    };
  }

  if (!roleplayNameMatchesMember(parsed.roleplayName, authorMember)) {
    return {
      ok: false,
      message: [
        "You can only update **your own** roster entry.",
        `Roleplay Name must appear in your Discord nickname or username.`,
        `You entered: **${parsed.roleplayName.trim()}**`,
        `Your nickname: \`${authorMember.displayName}\``,
      ].join("\n"),
    };
  }

  const nicknameCallsign = extractDepartmentCallsignFromDisplayName(authorMember.displayName);
  if (
    nicknameCallsign &&
    normalizeCallsign(parsed.currentCallsign) !== nicknameCallsign
  ) {
    return {
      ok: false,
      message: [
        "Current Callsign must match the callsign in your nickname.",
        `You entered: **${parsed.currentCallsign}**`,
        `Your nickname callsign: **${nicknameCallsign}**`,
      ].join("\n"),
    };
  }

  return { ok: true, targetMember: authorMember };
}

module.exports = {
  roleplayNameMatchesMember,
  validatePromotionRequester,
  canBypassRankEligibility,
};
