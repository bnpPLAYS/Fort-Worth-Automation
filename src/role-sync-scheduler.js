const { Events } = require("discord.js");
const { isSheetsConfigured } = require("./google-sheets/client");
const {
  syncMemberRankFromDiscord,
  getOrderedRanksFromEntries,
  safeFetchGuildMembers,
} = require("./google-sheets/roster-sync");
const { getRosterRows } = require("./google-sheets/client");
const { hasRosterSyncRole } = require("./member-roster");
const { ranksMatch } = require("./rank-matching");
const { reorganizeRosterStructure, hasReorganizeMarker } = require("./google-sheets/roster-reorganize");
const { MEMBER_ROSTER_ROLE_IDS, ROSTER_SYNC_ROLE_ID } = require("./constants");

const ROLE_SYNC_INTERVAL_MS = Number.parseInt(process.env.ROLE_SYNC_INTERVAL_MS || "300000", 10);
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

async function syncMemberIfRankChanged(member, orderedRanks, { reason = "scheduled" } = {}) {
  const fingerprint = getMemberRankFingerprint(member, orderedRanks);
  const previous = memberRankFingerprints.get(member.id);

  if (previous === fingerprint) {
    return { status: "unchanged" };
  }

  memberRankFingerprints.set(member.id, fingerprint);

  if (!fingerprint) {
    return { status: "no_rank_role" };
  }

  const result = await syncMemberRankFromDiscord(member, { dmOnChange: true, reason });
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
        const outcome = await syncMemberIfRankChanged(member, orderedRanks, { reason });

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
  if (!isSheetsConfigured() || hasReorganizeMarker()) return;

  try {
    const result = await reorganizeRosterStructure({ force: false });
    if (!result.skipped) {
      console.log("[roster-reorganize] Completed:", result);
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
    `[role-sync] Watching Discord rank roles every ${Math.round(ROLE_SYNC_INTERVAL_MS / 60000)} minute(s).`,
  );
}

function registerRoleSyncHandlers(client) {
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (!isSheetsConfigured()) return;
    if (oldMember.roles.cache.equals(newMember.roles.cache)) return;
    if (!hasRosterSyncRole(newMember) && !hasRosterSyncRole(oldMember)) return;

    try {
      const { entries } = await getRosterRows();
      const orderedRanks = getOrderedRanksFromEntries(entries);
      const outcome = await syncMemberIfRankChanged(newMember, orderedRanks, {
        reason: "member_update",
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
