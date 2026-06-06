const {
  CADET_ENROLL_ROLE_IDS,
  CADET_FORBIDDEN_ROLE_IDS,
  PROBATIONARY_OFFICER_ROLE_ID,
} = require("./constants");
const { RANK_OPTIONS } = require("./rank-options");

const ALLOWED_ROLE_IDS = new Set(CADET_ENROLL_ROLE_IDS);

function getRolesToStripOnCadetEnroll(member) {
  const rankRoleIds = RANK_OPTIONS.flatMap((rank) => rank.discordRoleIds);
  const candidates = [
    PROBATIONARY_OFFICER_ROLE_ID,
    ...CADET_FORBIDDEN_ROLE_IDS,
    ...rankRoleIds,
  ];

  return [...new Set(candidates)].filter(
    (roleId) => roleId && !ALLOWED_ROLE_IDS.has(roleId) && member.roles.cache.has(roleId),
  );
}

async function applyCadetEnrollmentRoles(member) {
  if (!member?.guild) {
    throw new Error("Could not resolve your server membership.");
  }

  let current = await member.guild.members.fetch({ user: member.id, force: true });

  const toRemove = getRolesToStripOnCadetEnroll(current);
  if (toRemove.length > 0) {
    await current.roles.remove(toRemove, "Become Cadet — remove incompatible roles");
    current = await member.guild.members.fetch({ user: member.id, force: true });
  }

  if (current.roles.cache.has(PROBATIONARY_OFFICER_ROLE_ID)) {
    throw new Error(
      "You still have the **Probationary Officer** role. Ask staff to remove it, or move the bot role above it, then try again.",
    );
  }

  const toAdd = CADET_ENROLL_ROLE_IDS.filter((roleId) => !current.roles.cache.has(roleId));
  if (toAdd.length > 0) {
    await current.roles.add(toAdd, "Become Cadet");
    current = await member.guild.members.fetch({ user: member.id, force: true });
  }

  const missing = CADET_ENROLL_ROLE_IDS.filter((roleId) => !current.roles.cache.has(roleId));
  if (missing.length > 0) {
    throw new Error(
      `Could not assign required cadet role(s): ${missing.join(", ")}. The bot role may be too low in the role list.`,
    );
  }

  const unexpected = getRolesToStripOnCadetEnroll(current);
  if (unexpected.length > 0) {
    await current.roles.remove(unexpected, "Become Cadet — remove leftover rank roles").catch(() => null);
    current = await member.guild.members.fetch({ user: member.id, force: true });
  }

  if (current.roles.cache.has(PROBATIONARY_OFFICER_ROLE_ID)) {
    throw new Error(
      "Probationary Officer was re-applied during enrollment. Contact staff — another integration may be conflicting.",
    );
  }

  console.log(
    `[cadet] Enrolled ${current.id}: roles ${CADET_ENROLL_ROLE_IDS.filter((id) => current.roles.cache.has(id)).join(", ")}`,
  );

  return current;
}

module.exports = {
  applyCadetEnrollmentRoles,
  getRolesToStripOnCadetEnroll,
};
