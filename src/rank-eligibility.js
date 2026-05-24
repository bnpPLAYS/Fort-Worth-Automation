const { PermissionFlagsBits } = require("discord.js");
const { STAFF_PING_ROLE_ID } = require("./constants");

function normalizeRank(value) {
  return String(value).trim().toLowerCase();
}

function memberHasRankRole(member, rankName) {
  const target = normalizeRank(rankName);
  if (!target) return false;

  return member.roles.cache.some((role) => normalizeRank(role.name) === target);
}

function getMemberRankRoleNames(member) {
  return member.roles.cache
    .filter((role) => role.id !== member.guild.id)
    .map((role) => role.name)
    .sort((a, b) => a.localeCompare(b));
}

function canBypassRankEligibility(member) {
  if (!member) return false;

  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.roles.cache.has(STAFF_PING_ROLE_ID)
  );
}

function validatePromotionRank(member, newRank, { bypass = false } = {}) {
  if (!member) {
    return {
      ok: false,
      message:
        "Could not find a Discord member for this promotion. They need a matching callsign or RP name in their nickname.",
    };
  }

  if (bypass || canBypassRankEligibility(member)) {
    return { ok: true, member, bypassed: true };
  }

  if (memberHasRankRole(member, newRank)) {
    return { ok: true, member, bypassed: false };
  }

  const roleNames = getMemberRankRoleNames(member);
  const roleList = roleNames.length > 0 ? roleNames.join(", ") : "(no roles)";

  return {
    ok: false,
    member,
    message: [
      `You can only request a rank you **already have** as a Discord role.`,
      `Requested: **${newRank.trim()}**`,
      `Your roles: ${roleList}`,
      "",
      "Get the Discord role for that rank first, then post your promotion request again.",
    ].join("\n"),
  };
}

module.exports = {
  memberHasRankRole,
  canBypassRankEligibility,
  validatePromotionRank,
};
