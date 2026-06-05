const {
  PROBATIONARY_OFFICER_ROLE_ID,
  MEMBER_ROSTER_ROLE_IDS,
  CADET_DISCORD_ROLE_ID,
  CADET_ENROLL_ROLE_IDS,
} = require("./constants");
const { ranksMatch } = require("./rank-matching");
const { isCadetSheetRank } = require("./google-sheets/roster-ranks");
const { mergeRoleIds } = require("./member-roster");

/** Cadet rank role only — removed when promoting off the cadet track */
const CADET_ROLE_IDS = [CADET_DISCORD_ROLE_ID];

/** Discord role + sheet rank label pairs used by Quiz and /rosteradd */
const RANK_OPTIONS = [
  {
    id: "cadet",
    label: "Cadet",
    discordRoleIds: CADET_ENROLL_ROLE_IDS,
    useCadetCallsign: true,
  },
  {
    id: "probationary",
    label: "Probationary Officer",
    discordRoleIds: [PROBATIONARY_OFFICER_ROLE_ID],
  },
  {
    id: "officer_one",
    label: "Officer I",
    discordRoleIds: ["1484950896864530442"],
  },
  {
    id: "officer_two",
    label: "Officer II",
    discordRoleIds: ["1484950861716263004"],
  },
  {
    id: "officer_three",
    label: "Officer III",
    discordRoleIds: ["1484950728647774408"],
  },
];

function getRankOptionById(id) {
  return RANK_OPTIONS.find((rank) => rank.id === id) ?? null;
}

function getRankOptionByLabel(label) {
  return RANK_OPTIONS.find((rank) => ranksMatch(rank.label, label)) ?? null;
}

function findDiscordRoleIdsForSheetRank(guild, sheetRank) {
  const preset = getRankOptionByLabel(sheetRank);
  if (preset) {
    return preset.discordRoleIds;
  }

  if (!guild) return [];

  return guild.roles.cache
    .filter((role) => role.id !== guild.id && ranksMatch(sheetRank, role.name))
    .map((role) => role.id);
}

function resolveRankForRosterAdd(guild, rankValue) {
  const preset = getRankOptionById(rankValue) ?? getRankOptionByLabel(rankValue);
  const sheetRank = preset?.label ?? rankValue;
  const useCadetCallsign = preset?.useCadetCallsign ?? isCadetSheetRank(sheetRank);

  return {
    sheetRank,
    discordRoleIds: preset?.discordRoleIds ?? findDiscordRoleIdsForSheetRank(guild, sheetRank),
    useCadetCallsign,
  };
}

function guildRoleIdsMatchingRank(guild, sheetRank) {
  if (!guild) return [];

  return guild.roles.cache
    .filter(
      (role) =>
        role.id !== guild.id &&
        !MEMBER_ROSTER_ROLE_IDS.includes(role.id) &&
        ranksMatch(sheetRank, role.name),
    )
    .map((role) => role.id);
}

function configuredRolesMatchLabel(guild, discordRoleIds, sheetRank) {
  if (!guild || discordRoleIds.length === 0) return false;

  return discordRoleIds.every((roleId) => {
    const role = guild.roles.cache.get(roleId);
    if (!role) return false;
    return ranksMatch(sheetRank, role.name);
  });
}

/** Rank Discord roles for accept flows; falls back to guild role names when IDs are stale. */
async function resolveAssignmentRoleIds(guild, rankValue) {
  if (guild?.roles?.cache?.size <= 1) {
    await guild.roles.fetch().catch(() => null);
  }

  const { sheetRank, discordRoleIds, useCadetCallsign } = resolveRankForRosterAdd(guild, rankValue);
  const nameMatched = guildRoleIdsMatchingRank(guild, sheetRank);

  if (nameMatched.length > 0 && !configuredRolesMatchLabel(guild, discordRoleIds, sheetRank)) {
    return { sheetRank, discordRoleIds: nameMatched, useCadetCallsign };
  }

  return { sheetRank, discordRoleIds, useCadetCallsign };
}

async function assignRankRolesToMember(member, rankValue, reason = "Rank assignment") {
  if (!member) {
    return { added: [], failed: [], skipped: true };
  }

  const guild = member.guild;
  const { discordRoleIds, useCadetCallsign } = await resolveAssignmentRoleIds(guild, rankValue);

  if (!useCadetCallsign) {
    const cadetRolesToRemove = CADET_ROLE_IDS.filter((roleId) => member.roles.cache.has(roleId));
    if (cadetRolesToRemove.length > 0) {
      await member.roles.remove(cadetRolesToRemove, reason).catch((error) => {
        console.error("Failed to remove cadet roles:", error);
      });
    }
  }

  const roleIds = useCadetCallsign
    ? mergeRoleIds(discordRoleIds)
    : mergeRoleIds(discordRoleIds, MEMBER_ROSTER_ROLE_IDS);
  const toAdd = roleIds.filter((roleId) => !member.roles.cache.has(roleId));
  if (toAdd.length === 0) {
    return { added: [], failed: [] };
  }

  try {
    await member.roles.add(toAdd, reason);
    return { added: toAdd, failed: [] };
  } catch (error) {
    console.error("Rank role assignment failed:", error);
    return { added: [], failed: toAdd, error: error.message };
  }
}

module.exports = {
  CADET_ROLE_IDS,
  CADET_ENROLL_ROLE_IDS,
  RANK_OPTIONS,
  getRankOptionById,
  getRankOptionByLabel,
  findDiscordRoleIdsForSheetRank,
  resolveRankForRosterAdd,
  resolveAssignmentRoleIds,
  assignRankRolesToMember,
};
