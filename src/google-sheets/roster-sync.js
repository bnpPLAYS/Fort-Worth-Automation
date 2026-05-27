const { getProbationaryRankName } = require("./client");
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
  extractCallsignFromDisplayName,
  formatCallsignForDisplay,
} = require("../discord-callsign");
const { sendCallsignDm } = require("../member-roster");
const { PROBATIONARY_OFFICER_ROLE_ID, ROSTER_SYNC_ROLE_ID } = require("../constants");

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
  const candidates = [fromNickname, fallbackName].filter(Boolean);

  for (const name of candidates) {
    const entries = await findRosterEntriesForName(name);
    if (entries.length > 0) {
      return entries[0].name;
    }
  }

  const namedEntries = await getNamedRosterEntries();
  const matchedEntry = findRosterEntryForMember(namedEntries, member);
  if (matchedEntry) {
    return matchedEntry.name;
  }

  return fromNickname || fallbackName;
}

async function promoteToProbationaryOnRoster(roleplayName) {
  const probationaryRank = getProbationaryRankName();
  return assignMemberToOpenRank(roleplayName, probationaryRank);
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

  return {
    callsign,
    callsignChanged,
    nicknameResult,
    dmSent,
  };
}

async function fixProbationaryRosterForGuild(guild) {
  const probationaryRank = getProbationaryRankName();
  await guild.members.fetch().catch(() => null);

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

      const entries = await findRosterEntriesForName(roleplayName);
      if (!needsProbationaryRosterMove(entries, probationaryRank)) {
        skipped.push(`${member.displayName} (already on PO row)`);
        continue;
      }

      const rosterResult = await promoteToProbationaryOnRoster(roleplayName);
      const syncResult = await syncMemberCallsignFromEntry(
        member,
        {
          name: roleplayName,
          callsign: rosterResult.newCallsign,
          rank: rosterResult.newRank,
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
  const entries = await getNamedRosterEntries();
  await guild.members.fetch().catch(() => null);

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

module.exports = {
  resolveRoleplayNameForMember,
  needsProbationaryRosterMove,
  promoteToProbationaryOnRoster,
  syncMemberCallsignFromEntry,
  fixProbationaryRosterForGuild,
  refreshCallsignsForGuild,
};
