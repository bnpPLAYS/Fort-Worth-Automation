const { Events } = require("discord.js");
const { isSheetsConfigured } = require("./google-sheets/client");
const {
  syncMemberRankFromDiscord,
  revertCallsignDriftFromRoster,
  getOrderedRanksFromEntries,
  safeFetchGuildMembers,
} = require("./google-sheets/roster-sync");
const { getRosterRows } = require("./google-sheets/client");
const { hasRosterSyncRole } = require("./member-roster");
const { ranksMatch } = require("./rank-matching");
const {
  reorganizeRosterStructure,
  hasReorganizeMarker,
  REORGANIZE_VERSION,
} = require("./google-sheets/roster-reorganize");
const { pauseRoleSyncForMember, pauseRoleSyncGlobally, isRoleSyncPaused } = require("./role-sync-guard");
const { logRosterAudit } = require("./roster-audit-log");
const { processMemberRosterRemoval } = require("./roster-removal");

const ROLE_SYNC_INTERVAL_MS = Number.parseInt(process.env.ROLE_SYNC_INTERVAL_MS || "300000", 10);
const { MEMBER_ROSTER_ROLE_IDS, ROSTER_SYNC_ROLE_ID } = require("./constants");
const {
  setExcludedRankRoleIds,
} = require("./google-sheets/rank-inference");

setExcludedRankRoleIds([ROSTER_SYNC_ROLE_ID, ...MEMBER_ROSTER_ROLE_IDS]);

const EXCLUDED_ROLE_IDS = new Set([ROSTER_SYNC_ROLE_ID, ...MEMBER_ROSTER_ROLE_IDS]);
const memberRankFingerprints = new Map();
let roleSyncTimer = null;
let roleSyncRunning = false;

function getMemberRankFingerprint(member, orderedRanks) {
  const roleIds = member.roles.cache
    .filter((role) => {
      if (role.id === member.guild.id) return false;
      if (EXCLUDED_ROLE_IDS.has(role.id)) return false;
      return orderedRanks.some((sheetRank) => ranksMatch(sheetRank, role.name));
    })
    .map((role) => role.id)
    .sort();

  return roleIds.join(",");
}

async function auditCallsignRevert(client, member, outcome, reason) {
  if (!client || !member || outcome?.status !== "reverted") return;

  await logRosterAudit(client, member.guild.id, {
    title: "Callsign revert — nickname did not match roster",
    target: member,
    callsign: outcome.sheetCallsign,
    trigger: reason,
    notes: outcome.summary,
  }).catch(() => null);
}

async function guardMemberCallsignDrift(client, member, { reason = "callsign_drift", entries } = {}) {
  const outcome = await revertCallsignDriftFromRoster(member, { dmOnChange: false, entries });

  if (outcome.status === "reverted") {
    console.log(`[callsign-guard] ${member.displayName}: ${outcome.summary}`);
    await auditCallsignRevert(client, member, outcome, reason);
  }

  return outcome;
}

async function auditRoleSyncUpdate(client, member, outcome, reason) {
  if (!client || !member || outcome?.status !== "updated") return;

  await logRosterAudit(client, member.guild.id, {
    title: "Role sync — roster updated",
    target: member,
    trigger: reason,
    notes: outcome.summary,
  }).catch(() => null);
}

async function syncMemberIfRankChanged(
  client,
  member,
  orderedRanks,
  { reason = "scheduled", entries } = {},
) {
  if (isRoleSyncPaused(member)) {
    return { status: "paused" };
  }
  const fingerprint = getMemberRankFingerprint(member, orderedRanks);
  const previous = memberRankFingerprints.get(member.id);

  if (previous === fingerprint) {
    return { status: "unchanged" };
  }

  memberRankFingerprints.set(member.id, fingerprint);

  if (!fingerprint) {
    return { status: "no_rank_role" };
  }

  const result = await syncMemberRankFromDiscord(member, { dmOnChange: true, reason, entries });
  await auditRoleSyncUpdate(client, member, result, reason);
  return result;
}

async function runRoleSyncPass(client, { reason = "scheduled" } = {}) {
  if (!isSheetsConfigured() || roleSyncRunning) {
    return null;
  }

  roleSyncRunning = true;

  try {
    const { entries } = await getRosterRows();
    const orderedRanks = getOrderedRanksFromEntries(entries);
    let updated = 0;
    let checked = 0;

    for (const guild of client.guilds.cache.values()) {
      await safeFetchGuildMembers(guild);

      for (const member of guild.members.cache.values()) {
        if (!hasRosterSyncRole(member)) continue;

        checked += 1;

        const drift = await guardMemberCallsignDrift(client, member, {
          reason: "interval",
          entries,
        });
        if (drift.status === "reverted") {
          updated += 1;
        }

        const outcome = await syncMemberIfRankChanged(client, member, orderedRanks, {
          reason,
          entries,
        });

        if (outcome.status === "updated") {
          updated += 1;
          console.log(`[role-sync] ${member.displayName}: ${outcome.summary}`);
        } else if (outcome.status === "failed") {
          console.warn(`[role-sync] ${member.displayName}: ${outcome.error}`);
        }
      }
    }

    if (updated > 0) {
      console.log(`[role-sync] ${reason}: updated ${updated} of ${checked} roster member(s).`);
    }

    return { updated, checked };
  } finally {
    roleSyncRunning = false;
  }
}

async function maybeRunStartupReorganize() {
  if (!isSheetsConfigured()) return;

  if (hasReorganizeMarker()) {
    return;
  }

  try {
    const result = await reorganizeRosterStructure({ force: false });
    if (!result.skipped) {
      console.log(`[roster-reorganize] v${REORGANIZE_VERSION} completed:`, result);
    }
  } catch (error) {
    console.error("[roster-reorganize] Failed:", error);
  }
}

function primeMemberFingerprints(client) {
  if (!isSheetsConfigured()) return;

  getRosterRows()
    .then(({ entries }) => {
      const orderedRanks = getOrderedRanksFromEntries(entries);

      for (const guild of client.guilds.cache.values()) {
        for (const member of guild.members.cache.values()) {
          if (!hasRosterSyncRole(member)) continue;
          memberRankFingerprints.set(member.id, getMemberRankFingerprint(member, orderedRanks));
        }
      }
    })
    .catch((error) => {
      console.error("[role-sync] Failed to prime fingerprints:", error);
    });
}

function startRoleSyncScheduler(client) {
  if (roleSyncTimer) return;

  maybeRunStartupReorganize();
  primeMemberFingerprints(client);

  roleSyncTimer = setInterval(() => {
    runRoleSyncPass(client, { reason: "interval" }).catch((error) => {
      console.error("[role-sync] Interval pass failed:", error);
    });
  }, ROLE_SYNC_INTERVAL_MS);

  console.log(
    `[role-sync] Watching Discord rank roles and nickname callsigns every ${Math.round(ROLE_SYNC_INTERVAL_MS / 60000)} minute(s).`,
  );
}

function registerRoleSyncHandlers(client) {
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (!isSheetsConfigured()) return;

    const nicknameChanged = oldMember.displayName !== newMember.displayName;
    const rolesChanged = !oldMember.roles.cache.equals(newMember.roles.cache);

    if (!nicknameChanged && !rolesChanged) return;

    try {
      const { entries } = await getRosterRows();
      const orderedRanks = getOrderedRanksFromEntries(entries);
      const hadRosterSync = hasRosterSyncRole(oldMember);
      const hasRosterSync = hasRosterSyncRole(newMember);

      if (rolesChanged && hadRosterSync && !hasRosterSync) {
        const outcome = await processMemberRosterRemoval(client, newMember, {
          reason: "Discord roster sync role removed",
          entries,
          identityMember: oldMember,
        });

        if (outcome.status === "removed") {
          memberRankFingerprints.delete(newMember.id);
          console.log(
            `[role-sync] ${newMember.displayName}: roster cleared after roster sync role removal`,
          );
        }

        return;
      }

      if (rolesChanged && hasRosterSync) {
        const oldFingerprint = getMemberRankFingerprint(oldMember, orderedRanks);
        const newFingerprint = getMemberRankFingerprint(newMember, orderedRanks);

        if (oldFingerprint && !newFingerprint) {
          const outcome = await processMemberRosterRemoval(client, newMember, {
            reason: "Discord rank roles removed",
            entries,
            identityMember: oldMember,
          });

          if (outcome.status === "removed") {
            memberRankFingerprints.delete(newMember.id);
            console.log(
              `[role-sync] ${newMember.displayName}: roster cleared after rank roles removed`,
            );
          }

          return;
        }
      }

      if (!hasRosterSync) return;

      if (nicknameChanged) {
        await guardMemberCallsignDrift(client, newMember, { reason: "nickname_change", entries });
      }

      if (!rolesChanged) return;

      const outcome = await syncMemberIfRankChanged(client, newMember, orderedRanks, {
        reason: "member_update",
        entries,
      });

      if (outcome.status === "updated") {
        console.log(`[role-sync] ${newMember.displayName}: ${outcome.summary}`);
      }
    } catch (error) {
      console.error(`[role-sync] GuildMemberUpdate failed for ${newMember.id}:`, error);
    }
  });
}

module.exports = {
  startRoleSyncScheduler,
  registerRoleSyncHandlers,
  runRoleSyncPass,
};
