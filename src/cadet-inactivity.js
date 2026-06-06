const {
  CADET_ENROLL_COOLDOWN_MS,
  CADET_ENROLL_ROLE_IDS,
  PROBATIONARY_OFFICER_ROLE_ID,
  CADET_INACTIVITY_MS,
} = require("./constants");
const { setCooldown } = require("./cooldowns");
const { getRosterCallsignForMember, getRoleplayNameFromMember } = require("./discord-callsign");
const { isCadetTrackMember } = require("./member-roster");
const { getRosterLink } = require("./roster-links-store");
const { removeMemberRosterLink } = require("./roster-member-link");
const { logRosterAudit } = require("./roster-audit-log");
const { pauseRoleSyncForMember, pauseRoleSyncGlobally } = require("./role-sync-guard");
const { isSheetsConfigured, clearRosterForName } = require("./google-sheets/roster-assign");
const { resolveRoleplayNameForMember } = require("./google-sheets/roster-sync");
const { CADET_ROLE_IDS } = require("./rank-options");
const {
  getCadetInactivityRecord,
  recordCadetEnrollment,
  markCadetRideAlongRequested,
  markCadetInactivityTerminated,
  clearCadetInactivityRecord,
  listCadetInactivityRecords,
} = require("./cadet-inactivity-store");

const CADET_ENROLL_COOLDOWN_TYPE = "cadet-enroll";
const CHECK_INTERVAL_MS = Number.parseInt(process.env.CADET_INACTIVITY_CHECK_MS || "3600000", 10);

let inactivityTimer = null;
let inactivityRunning = false;

function ensureCadetEnrollmentTracked(member) {
  if (!member || !isCadetTrackMember(member)) return null;

  const existing = getCadetInactivityRecord(member.id);
  if (existing) {
    if (existing.terminatedAt) return null;
    return existing;
  }

  const link = getRosterLink(member.id);
  return recordCadetEnrollment(member.id, {
    guildId: member.guild.id,
    roleplayName: link?.roleplayName ?? getRoleplayNameFromMember(member),
    enrolledAt: link?.linkedAt,
  });
}

function isCadetInactive(record, now = Date.now()) {
  if (!record || record.terminatedAt || record.rideAlongRequestedAt) return false;

  const enrolledAt = Date.parse(record.enrolledAt);
  if (!Number.isFinite(enrolledAt)) return false;

  return now - enrolledAt >= CADET_INACTIVITY_MS;
}

async function terminateCadetForInactivity(client, member, record) {
  pauseRoleSyncGlobally(45_000);
  pauseRoleSyncForMember(member, 120_000);

  await member.roles.remove(CADET_ROLE_IDS).catch((error) => {
    console.error("[cadet-inactivity] Failed to remove cadet rank roles:", error);
  });
  await member.roles.remove(CADET_ENROLL_ROLE_IDS).catch((error) => {
    console.error("[cadet-inactivity] Failed to remove cadet roster roles:", error);
  });
  await member.roles.remove(PROBATIONARY_OFFICER_ROLE_ID).catch((error) => {
    console.error("[cadet-inactivity] Failed to remove PO role:", error);
  });

  setCooldown(member.id, CADET_ENROLL_COOLDOWN_MS, CADET_ENROLL_COOLDOWN_TYPE);

  let roleplayName = record.roleplayName || getRoleplayNameFromMember(member);
  if (isSheetsConfigured()) {
    try {
      roleplayName = await resolveRoleplayNameForMember(member, roleplayName);
    } catch {
      // Keep the best name we already have.
    }
  }

  if (isSheetsConfigured() && roleplayName) {
    try {
      await clearRosterForName(roleplayName, {
        currentCallsign: getRosterCallsignForMember(member),
        member,
      });
    } catch (error) {
      console.error("[cadet-inactivity] Roster clear failed:", error);
    }
  }

  removeMemberRosterLink(member);
  markCadetInactivityTerminated(member.id, "No ride-along request within 7 days");

  const dmText =
    "You have been **terminated for inactivity** as a cadet.\n\n" +
    "You did not submit a **/ridealong** request within **7 days** of enrolling.\n\n" +
    "Your cadet roles and roster entry were removed. You may enroll again in **3 days** using **Become Cadet**.";

  await member.user.send(dmText).catch(() => null);

  await logRosterAudit(client, member.guild.id, {
    title: "Cadet terminated — inactivity",
    target: member,
    roleplayName,
    trigger: "Cadet inactivity (7 days, no ride-along request)",
    notes: `Enrolled <t:${Math.floor(Date.parse(record.enrolledAt) / 1000)}:F>`,
  }).catch(() => null);

  console.log(`[cadet-inactivity] Terminated ${member.displayName} (${member.id}) for inactivity.`);

  return { roleplayName };
}

async function runCadetInactivityPass(client, { reason = "scheduled" } = {}) {
  if (inactivityRunning) return null;

  inactivityRunning = true;

  try {
    let terminated = 0;
    let checked = 0;
    const now = Date.now();
    const recordsByUser = new Map(listCadetInactivityRecords().map((record) => [record.userId, record]));

    for (const guild of client.guilds.cache.values()) {
      await guild.members.fetch().catch(() => null);

      for (const member of guild.members.cache.values()) {
        if (member.user.bot) continue;

        let record = recordsByUser.get(member.id) ?? ensureCadetEnrollmentTracked(member);
        if (!record || record.terminatedAt) continue;
        if (!isCadetTrackMember(member)) {
          continue;
        }

        checked += 1;

        if (!isCadetInactive(record, now)) continue;

        try {
          await terminateCadetForInactivity(client, member, record);
          terminated += 1;
        } catch (error) {
          console.error(`[cadet-inactivity] Failed for ${member.id}:`, error);
        }
      }
    }

    if (terminated > 0) {
      console.log(`[cadet-inactivity] ${reason}: terminated ${terminated} of ${checked} tracked cadet(s).`);
    }

    return { terminated, checked };
  } finally {
    inactivityRunning = false;
  }
}

function startCadetInactivityScheduler(client) {
  if (inactivityTimer) return;

  runCadetInactivityPass(client, { reason: "startup" }).catch((error) => {
    console.error("[cadet-inactivity] Startup pass failed:", error);
  });

  inactivityTimer = setInterval(() => {
    runCadetInactivityPass(client, { reason: "interval" }).catch((error) => {
      console.error("[cadet-inactivity] Interval pass failed:", error);
    });
  }, CHECK_INTERVAL_MS);

  console.log(
    `[cadet-inactivity] Checking cadets every ${Math.round(CHECK_INTERVAL_MS / 60000)} minute(s); ` +
      `deadline ${Math.round(CADET_INACTIVITY_MS / 86400000)} day(s) after enroll without /ridealong.`,
  );
}

module.exports = {
  ensureCadetEnrollmentTracked,
  markCadetRideAlongRequested,
  clearCadetInactivityRecord,
  recordCadetEnrollment,
  startCadetInactivityScheduler,
  runCadetInactivityPass,
};
