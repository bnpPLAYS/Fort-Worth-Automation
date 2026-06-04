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
  extractDepartmentCallsignFromDisplayName,
} = require("../discord-callsign");
const {
  getRosterCallsignForMember,
  getLinkedRoleplayName,
  normalizeName,
  callsignsMatch,
  getMemberRosterIdentity,
  entryMatchesMemberIdentity,
} = require("./roster-match");
const { getRosterLink } = require("../roster-links-store");
const {
  recordMemberRosterLink,
  purgeRosterLinksWithoutSyncRole,
  removeMemberRosterLink,
} = require("../roster-member-link");
const { getErrorMessage } = require("../embed-utils");
const { sendCallsignDm, hasRosterSyncRole } = require("../member-roster");
const {
  PROBATIONARY_OFFICER_ROLE_ID,
  ROSTER_SYNC_ROLE_ID,
  MEMBER_ROSTER_ROLE_IDS,
} = require("../constants");
const {
  inferMemberRankFromDiscord,
  setExcludedRankRoleIds,
} = require("./rank-inference");

setExcludedRankRoleIds([ROSTER_SYNC_ROLE_ID, ...MEMBER_ROSTER_ROLE_IDS]);

function needsProbationaryRosterMove(entries, probationaryRank) {
  if (entries.length === 0) return false;

  const onProbationary = entries.some(
    (entry) => ranksMatch(probationaryRank, entry.rank) && !isCadetRosterEntry(entry),
  );

  const onCadet = entries.some((entry) => isCadetRosterEntry(entry));

  return onCadet || !onProbationary;
}

async function resolveRoleplayNameForMember(member, fallbackName = "") {
  const fromNickname = getRoleplayNameFromMember(member);
  const linkedName = getLinkedRoleplayName(member);

  if (linkedName && fromNickname && normalizeName(linkedName) === normalizeName(fromNickname)) {
    return linkedName;
  }

  if (fromNickname) {
    return fromNickname;
  }

  if (linkedName) {
    return linkedName;
  }

  const namedEntries = await getNamedRosterEntries();
  const matchedEntry = findRosterEntryForMember(namedEntries, member);
  if (matchedEntry) {
    return matchedEntry.name;
  }

  const callsign = getRosterCallsignForMember(member);
  const candidates = [fallbackName].filter(Boolean);

  for (const name of candidates) {
    const entries = await findRosterEntriesForName(name, { callsign });
    if (entries.length === 1) {
      return entries[0].name;
    }
  }

  return fallbackName;
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

function getRosterSyncMembers(guild) {
  return guild.members.cache.filter((member) => hasRosterSyncRole(member));
}

async function linkRosterAccountsFromCallsigns(guild) {
  await safeFetchGuildMembers(guild);
  const purged = purgeRosterLinksWithoutSyncRole(guild);

  const namedEntries = await getNamedRosterEntries();
  const members = getRosterSyncMembers(guild);

  const linked = [];
  const unchanged = [];
  const noCallsign = [];
  const notOnSheet = [];
  const ambiguous = [];
  const wrongNicknameFormat = [];
  const nameMismatch = [];

  for (const member of members.values()) {
    const displayName = String(member.displayName ?? "");
    if (!displayName.includes("|")) {
      wrongNicknameFormat.push(member.displayName);
      continue;
    }

    const identity = getMemberRosterIdentity(member);
    if (!identity.callsign) {
      noCallsign.push(member.displayName);
      continue;
    }

    if (!identity.roleplayName || identity.roleplayName.length < 2) {
      wrongNicknameFormat.push(member.displayName);
      continue;
    }

    const byCallsign = namedEntries.filter((entry) =>
      callsignsMatch(entry.callsign, identity.callsign),
    );

    if (byCallsign.length === 0) {
      notOnSheet.push(member.displayName);
      continue;
    }

    const matches = byCallsign.filter((entry) => entryMatchesMemberIdentity(entry, identity));

    if (matches.length === 0) {
      removeMemberRosterLink(member);
      const sheetNames = [...new Set(byCallsign.map((entry) => entry.name))].join(", ");
      nameMismatch.push(
        `${member.displayName} (callsign **${formatCallsignForDisplay(identity.callsign)}** is **${sheetNames}** on the sheet, not **${getRoleplayNameFromMember(member)}**)`,
      );
      continue;
    }

    if (matches.length > 1) {
      ambiguous.push(member.displayName);
      continue;
    }

    const entry = matches[0];

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
    wrongNicknameFormat,
    nameMismatch,
    purged,
    checked: members.size,
  };
}

async function promoteToProbationaryOnRoster(roleplayName, options = {}) {
  const probationaryRank = getProbationaryRankName();
  return assignMemberToOpenRank(roleplayName, probationaryRank, options);
}

async function syncMemberCallsignFromEntry(member, entry, { dmOnChange = true } = {}) {
  if (!hasRosterSyncRole(member)) {
    return {
      callsign: null,
      callsignChanged: false,
      nicknameResult: { ok: false, reason: "Member does not have the department roster role." },
      dmSent: false,
      skipped: true,
    };
  }

  const callsign = formatCallsignForDisplay(entry.callsign);
  const previousCallsign = extractDepartmentCallsignFromDisplayName(member.displayName);
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
        member,
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

  const members = getRosterSyncMembers(guild);

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

async function syncMemberRankFromDiscord(member, { dmOnChange = true } = {}) {
  const { isRoleSyncPaused } = require("../role-sync-guard");
  if (isRoleSyncPaused(member)) {
    return { status: "paused" };
  }

  if (!hasRosterSyncRole(member)) {
    return { status: "skipped", reason: "Member does not have the department roster role." };
  }

  const { entries } = await getRosterRows();
  const orderedRanks = getOrderedRanksFromEntries(entries);
  const discordRank = inferMemberRankFromDiscord(member, orderedRanks);

  if (!discordRank) {
    return { status: "no_rank_role" };
  }

  const namedEntries = await getNamedRosterEntries();
  let sheetEntry = findRosterEntryForMember(namedEntries, member);

  if (!sheetEntry) {
    const roleplayName = await resolveRoleplayNameForMember(member);
    if (!roleplayName) {
      return { status: "not_on_sheet", reason: "not on roster — use /rosteradd" };
    }

    const callsign = getRosterCallsignForMember(member);
    const sheetEntries = await findRosterEntriesForName(roleplayName, { callsign, member });
    if (sheetEntries.length === 1) {
      sheetEntry = sheetEntries[0];
      recordMemberRosterLink(member, sheetEntry);
    }
  }

  if (!sheetEntry) {
    return { status: "not_on_sheet", reason: "not on roster — use /rosteradd" };
  }

  const roleplayName = sheetEntry.name;

  if (ranksMatch(sheetEntry.rank, discordRank)) {
    const syncResult = await syncMemberCallsignFromEntry(member, sheetEntry, { dmOnChange });
    if (syncResult.skipped) {
      return { status: "failed", error: syncResult.nicknameResult.reason };
    }

    if (syncResult.callsignChanged) {
      return {
        status: "updated",
        summary: `callsign synced — **${discordRank}** / ${sheetEntry.callsign}`,
      };
    }

    return { status: "unchanged" };
  }

  const rosterResult = await assignMemberToOpenRank(roleplayName, discordRank, {
    currentCallsign: getRosterCallsignForMember(member),
    member,
  });
  const syncResult = await syncMemberCallsignFromEntry(
    member,
    {
      name: roleplayName,
      callsign: rosterResult.newCallsign,
      rank: rosterResult.newRank,
      rowNumber: rosterResult.rowNumber,
    },
    { dmOnChange },
  );

  if (syncResult.skipped) {
    return { status: "failed", error: syncResult.nicknameResult.reason };
  }

  return {
    status: "updated",
    summary:
      `**${rosterResult.previousRank ?? "none"}** / ${rosterResult.previousCallsign ?? "—"} → **${rosterResult.newRank}** / **${rosterResult.newCallsign}**` +
      (syncResult.dmSent ? "" : " (DM failed)"),
  };
}

async function syncPromotionsFromDiscordForGuild(guild) {
  const links = await linkRosterAccountsFromCallsigns(guild);

  const { entries } = await getRosterRows();
  const orderedRanks = getOrderedRanksFromEntries(entries);

  const members = getRosterSyncMembers(guild);

  const updated = [];
  const unchanged = [];
  const noRankRole = [];
  const notOnSheet = [];
  const failed = [];

  for (const member of members.values()) {
    try {
      if (!extractDepartmentCallsignFromDisplayName(member.displayName)) {
        notOnSheet.push(`${member.displayName} (nickname must be \`callsign | Name\`)`);
        continue;
      }

      const discordRank = inferMemberRankFromDiscord(member, orderedRanks);

      if (!discordRank) {
        noRankRole.push(member.displayName);
        continue;
      }

      const outcome = await syncMemberRankFromDiscord(member, { dmOnChange: true });

      if (outcome.status === "updated") {
        updated.push(`${member.displayName}: ${outcome.summary}`);
      } else if (outcome.status === "unchanged") {
        unchanged.push(`${member.displayName} — **${discordRank}**`);
      } else if (outcome.status === "not_on_sheet") {
        notOnSheet.push(`${member.displayName} (${outcome.reason})`);
      } else if (outcome.status === "failed") {
        failed.push(`${member.displayName}: ${outcome.error}`);
      } else if (outcome.status === "skipped") {
        failed.push(`${member.displayName}: ${outcome.reason}`);
      }
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
  syncMemberRankFromDiscord,
  safeFetchGuildMembers,
  linkRosterAccountsFromCallsigns,
  fixProbationaryRosterForGuild,
  refreshCallsignsForGuild,
  getOrderedRanksFromEntries,
  inferMemberRankFromDiscord,
  syncPromotionsFromDiscordForGuild,
};
