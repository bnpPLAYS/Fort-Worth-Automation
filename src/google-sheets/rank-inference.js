const { getCadetRankName } = require("./client");
const { isCadetSheetRank } = require("./roster-ranks");
const { ranksMatch } = require("../rank-matching");

const EXCLUDED_RANK_ROLE_IDS = new Set();

function setExcludedRankRoleIds(roleIds) {
  EXCLUDED_RANK_ROLE_IDS.clear();
  for (const roleId of roleIds) {
    EXCLUDED_RANK_ROLE_IDS.add(roleId);
  }
}

function memberHasSheetRankRole(member, sheetRank) {
  if (!member) return false;

  return member.roles.cache.some((role) => {
    if (role.id === member.guild.id) return false;
    if (EXCLUDED_RANK_ROLE_IDS.has(role.id)) return false;
    return ranksMatch(sheetRank, role.name);
  });
}

function isCadetLikeRank(sheetRank) {
  return ranksMatch(getCadetRankName(), sheetRank) || isCadetSheetRank(sheetRank);
}

/**
 * Pick the member's highest department rank on the sheet (top-to-bottom order).
 * Cadet is only used when the member has no other matching rank roles.
 */
function inferMemberRankFromDiscord(member, orderedSheetRanks) {
  if (!member || orderedSheetRanks.length === 0) return null;

  const matches = orderedSheetRanks.filter((sheetRank) => memberHasSheetRankRole(member, sheetRank));
  if (matches.length === 0) return null;

  const nonCadetMatches = matches.filter((sheetRank) => !isCadetLikeRank(sheetRank));
  if (nonCadetMatches.length > 0) {
    return nonCadetMatches[0];
  }

  return matches[0];
}

module.exports = {
  setExcludedRankRoleIds,
  memberHasSheetRankRole,
  isCadetLikeRank,
  inferMemberRankFromDiscord,
};
