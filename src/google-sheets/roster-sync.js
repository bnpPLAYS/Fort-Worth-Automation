const { getProbationaryRankName, getRosterRows } = require("./client");
const {
  assignMemberToOpenRank,
  findRosterEntriesForName,
} = require("./roster-assign");
const { getNamedRosterEntries, findRosterEntryForMember } = require("./roster-lookup");
const { isCadetRosterEntry } = require("./roster-ranks");
const { ranksMatch } = require("../rank-matching");
const {
  getRoleplayNameFromMember,
  updateMemberCallsign,
  formatCallsignForDisplay,
  extractCallsignFromDisplayName,
} = require("../discord-callsign");
const {
  getRosterCallsignForMember,
  getLinkedRoleplayName,
  normalizeName,
  callsignsMatch,
} = require("./roster-match");
const { getRosterLink } = require("../roster-links-store");
const { recordMemberRosterLink } = require("../roster-member-link");
const { getErrorMessage } = require("../embed-utils");
const { sendCallsignDm } = require("../member-roster");
const {
  PROBATIONARY_OFFICER_ROLE_ID,
  ROSTER_SYNC_ROLE_ID,
  MEMBER_ROSTER_ROLE_IDS,
} = require("../constants");

const EXCLUDED_RANK_ROLE_IDS = new Set([
  ROSTER_SYNC_ROLE_ID,
  ...MEMBER_ROSTER_ROLE_IDS,
]);

function needsProbationaryRosterMove(entries, probationaryRank) {
  if (entries.length === 0) return false;

  const onProbationary = entries.some(
    (entry) => ranksMatch(probationaryRank, entry.rank) && !isCadetRosterEntry(entry),
  );

  const onCadet = entries.some((entry) => isCadetRosterEntry(entry));

  return onCadet || !onProbationary;
}

async function resolveRoleplayNameForMember(member, fallbackName = "") {
  const linkedName = getLinkedRoleplayName(member);
  if (linkedName) {
    return linkedName;
  }

  const namedEntries = await getNamedRosterEntries();
  const matchedEntry = findRosterEntryForMember(namedEntries, member);
  if (matchedEntry) {
    return matchedEntry.name;
  }

  const fromNickname = getRoleplayNameFromMember(member);
  const callsign = getRosterCallsignForMember(member);
  const candidates = [fromNickname, fallbackName].filter(Boolean);

  for (const name of candidates) {
    const entries = await findRosterEntriesForName(name, { callsign });
    if (entries.length === 1) {
      return entries[0].name;
    }
  }

  return fromNickname || fallbackName;
}

async function safeFetchGuildMembers(guild) {
  try {
    await guild.members.fetch();
  } catch (error) {
    console.warn(
      "Guild member fetch returned errors; continuing with cached members:",
      getErrorMessage(error),
    );
  }
}

async function linkRosterAccountsFromCallsigns(guild) {
  await safeFetchGuildMembers(guild);

  const namedEntries = await getNamedRosterEntries();
  const members = guild.members.cache.filter((member) =>
    member.roles.cache.has(ROSTER_SYNC_ROLE_ID),
  );

  const linked = [];
  const unchanged = [];
  const noCallsign = [];
  const notOnSheet = [];
  const ambiguous = [];

  for (const member of members.values()) {
    const callsign = extractCallsignFromDisplayName(member.displayName);
    if (!callsign) {
      noCallsign.push(member.displayName);
      continue;
    }

    const byCallsign = namedEntries.filter((entry) => callsignsMatch(entry.callsign, callsign));

    if (byCallsign.length === 0) {
      notOnSheet.push(member.displayName);
      continue;
    }

    let entry = byCallsign.length === 1 ? byCallsign[0] : null;
    if (!entry) {
      const roleplayName = normalizeName(getRoleplayNameFromMember(member));
      const narrowed = byCallsign.filter(
        (sheetEntry) => normalizeName(sheetEntry.name) === roleplayName,
      );
      if (narrowed.length === 1) {
        entry = narrowed[0];
      } else {
        ambiguous.push(member.displayName);
        continue;
      }
    }

    const previous = getRosterLink(member.id);
    recordMemberRosterLink(member, entry);

    const label = `${member.displayName} → **${entry.name}** (${formatCallsignForDisplay(entry.callsign)})`;
    const sameLink =
      previous &&
      previous.rowNumber === entry.rowNumber &&
      normalizeName(previous.roleplayName) === normalizeName(entry.name) &&
      callsignsMatch(previous.callsign, entry.callsign);

    if (sameLink) {
      unchanged.push(label);
    } else {
      linked.push(label);
    }
  }

  return {
    linked,
    unchanged,
    noCallsign,
    notOnSheet,
    ambiguous,
    checked: members.size,
  };
}

async function promoteToProbationaryOnRoster(roleplayName, { currentCallsign } = {}) {
  const probationaryRank = getProbationaryRankName();
  return assignMemberToOpenRank(roleplayName, probationaryRank, { currentCallsign });
}

async function syncMemberCallsignFromEntry(member, entry, { dmOnChange = true } = {}) {
  const callsign = formatCallsignForDisplay(entry.callsign);
  const previousCallsign = extractCallsignFromDisplayName(member.displayName);
  const nicknameResult = await updateMemberCallsign(member, callsign, entry.name);
  const callsignChanged =
    previousCallsign !== callsign || Boolean(nicknameResult.changed);

  let dmSent = false;
  if (dmOnChange && callsignChanged && nicknameResult.ok) {
    dmSent = await sendCallsignDm(member.user, {
      callsign,
      roleplayName: entry.name,
      rank: entry.rank,
      isCadet: /^C-/i.test(callsign),
      title: "Your callsign has been updated on the department roster.",
      extraLines:
        nicknameResult.changed && nicknameResult.nickname
          ? [`Your Discord nickname is now \`${nicknameResult.nickname}\`.`]
          : [],
    });
  }

  recordMemberRosterLink(member, entry);

  return {
    callsign,
    callsignChanged,
    nicknameResult,
    dmSent,
  };
}

async function fixProbationaryRosterForGuild(guild) {
  const probationaryRank = getProbationaryRankName();
  await safeFetchGuildMembers(guild);

  const members = guild.members.cache.filter((member) =>
    member.roles.cache.has(PROBATIONARY_OFFICER_ROLE_ID),
  );

  const moved = [];
  const skipped = [];
  const failed = [];

  for (const member of members.values()) {
    try {
      const roleplayName = await resolveRoleplayNameForMember(member);
      if (!roleplayName) {
        skipped.push(`${member.displayName} (no RP name)`);
        continue;
      }

      const callsign = getRosterCallsignForMember(member);
      const entries = await findRosterEntriesForName(roleplayName, { callsign, member });
      if (!needsProbationaryRosterMove(entries, probationaryRank)) {
        skipped.push(`${member.displayName} (already on PO row)`);
        continue;
      }

      const rosterResult = await promoteToProbationaryOnRoster(roleplayName, {
        currentCallsign: getRosterCallsignForMember(member),
      });
      const syncResult = await syncMemberCallsignFromEntry(
        member,
        {
          name: roleplayName,
          callsign: rosterResult.newCallsign,
          rank: rosterResult.newRank,
          rowNumber: rosterResult.rowNumber,
        },
        { dmOnChange: true },
      );

      moved.push(
        `${member.displayName}: **${rosterResult.previousCallsign ?? "cadet"}** → **${rosterResult.newCallsign}**` +
          (syncResult.dmSent ? "" : " (DM failed)"),
      );
    } catch (error) {
      console.error(`PO roster fix failed for ${member.id}:`, error);
      failed.push(`${member.displayName}: ${error.message}`);
    }
  }

  return { moved, skipped, failed, checked: members.size };
}

async function refreshCallsignsForGuild(guild) {
  await linkRosterAccountsFromCallsigns(guild);
  const entries = await getNamedRosterEntries();

  const members = guild.members.cache.filter((member) =>
    member.roles.cache.has(ROSTER_SYNC_ROLE_ID),
  );

  const updated = [];
  const unchanged = [];
  const notOnSheet = [];
  const failed = [];

  for (const member of members.values()) {
    const entry = findRosterEntryForMember(entries, member);

    if (!entry) {
      notOnSheet.push(member.displayName);
      continue;
    }

    try {
      const syncResult = await syncMemberCallsignFromEntry(member, entry, { dmOnChange: true });

      if (!syncResult.nicknameResult.ok) {
        failed.push(`${member.displayName}: ${syncResult.nicknameResult.reason}`);
        continue;
      }

      const label = `${member.displayName} → **${syncResult.callsign}** | ${entry.name}`;

      if (syncResult.callsignChanged) {
        updated.push(`${label}${syncResult.dmSent ? "" : " (DM failed)"}`);
      } else {
        unchanged.push(label);
      }
    } catch (error) {
      console.error(`Callsign refresh failed for ${member.id}:`, error);
      failed.push(`${member.displayName}: ${error.message}`);
    }
  }

  return { updated, unchanged, notOnSheet, failed, checked: members.size };
}

function getOrderedRanksFromEntries(entries) {
  const ordered = [];
  const seen = new Set();

  for (const entry of entries) {
    const rank = String(entry.rank ?? "").trim();
    if (!rank) continue;

    const key = rank.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    ordered.push(rank);
  }

  return ordered;
}

function inferMemberRankFromDiscord(member, orderedSheetRanks) {
  if (!member || orderedSheetRanks.length === 0) return null;

  for (const sheetRank of orderedSheetRanks) {
    const hasMatchingRole = member.roles.cache.some((role) => {
      if (role.id === member.guild.id) return false;
      if (EXCLUDED_RANK_ROLE_IDS.has(role.id)) return false;
      return ranksMatch(sheetRank, role.name);
    });

    if (hasMatchingRole) {
      return sheetRank;
    }
  }

  return null;
}

async function syncPromotionsFromDiscordForGuild(guild) {
  const links = await linkRosterAccountsFromCallsigns(guild);

  const { entries } = await getRosterRows();
  const orderedRanks = getOrderedRanksFromEntries(entries);

  const members = guild.members.cache.filter((member) =>
    member.roles.cache.has(ROSTER_SYNC_ROLE_ID),
  );

  const updated = [];
  const unchanged = [];
  const noRankRole = [];
  const notOnSheet = [];
  const failed = [];

  for (const member of members.values()) {
    try {
      const discordRank = inferMemberRankFromDiscord(member, orderedRanks);

      if (!discordRank) {
        noRankRole.push(member.displayName);
        continue;
      }

      const roleplayName = await resolveRoleplayNameForMember(member);
      if (!roleplayName) {
        notOnSheet.push(`${member.displayName} (no RP name)`);
        continue;
      }

      const callsign = getRosterCallsignForMember(member);
      const sheetEntries = await findRosterEntriesForName(roleplayName, { callsign, member });
      const sheetEntry =
        sheetEntries.length === 1
          ? sheetEntries[0]
          : findRosterEntryForMember(await getNamedRosterEntries(), member);

      if (sheetEntry && ranksMatch(sheetEntry.rank, discordRank)) {
        const syncResult = await syncMemberCallsignFromEntry(member, sheetEntry, {
          dmOnChange: true,
        });
        const label = `${member.displayName} — **${discordRank}** / ${sheetEntry.callsign}`;
        if (syncResult.callsignChanged) {
          updated.push(`${label} (callsign synced)`);
        } else {
          unchanged.push(label);
        }
        continue;
      }

      const rosterResult = await assignMemberToOpenRank(roleplayName, discordRank, {
        currentCallsign: getRosterCallsignForMember(member),
      });
      const syncResult = await syncMemberCallsignFromEntry(
        member,
        {
          name: roleplayName,
          callsign: rosterResult.newCallsign,
          rank: rosterResult.newRank,
          rowNumber: rosterResult.rowNumber,
        },
        { dmOnChange: true },
      );

      updated.push(
        `${member.displayName}: **${rosterResult.previousRank ?? "none"}** / ${rosterResult.previousCallsign ?? "—"} → **${rosterResult.newRank}** / **${rosterResult.newCallsign}**` +
          (syncResult.dmSent ? "" : " (DM failed)"),
      );
    } catch (error) {
      console.error(`Promotion sync failed for ${member.id}:`, error);
      failed.push(`${member.displayName}: ${error.message}`);
    }
  }

  return {
    updated,
    unchanged,
    noRankRole,
    notOnSheet,
    failed,
    checked: members.size,
    links,
  };
}

module.exports = {
  resolveRoleplayNameForMember,
  needsProbationaryRosterMove,
  promoteToProbationaryOnRoster,
  syncMemberCallsignFromEntry,
  safeFetchGuildMembers,
  linkRosterAccountsFromCallsigns,
  fixProbationaryRosterForGuild,
  refreshCallsignsForGuild,
  getOrderedRanksFromEntries,
  inferMemberRankFromDiscord,
  syncPromotionsFromDiscordForGuild,
};
