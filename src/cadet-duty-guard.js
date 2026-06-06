const { Events } = require("discord.js");
const {
  ON_DUTY_ROLE_ID,
} = require("./constants");
const { isCadetTrackMember } = require("./member-roster");

const DUTY_WARNING_INTERVAL_MS = 60_000;
const DUTY_WARNING_MESSAGE =
  "You **cannot yet be on duty**. Go **off duty immediately** or you will be **terminated** until the on-duty role is removed from you.";

const activeWarnings = new Map();

function isCadetOnDuty(member) {
  if (!member || member.user?.bot) return false;
  if (!member.roles.cache.has(ON_DUTY_ROLE_ID)) return false;
  return isCadetTrackMember(member);
}

function stopDutyWarning(userId) {
  const interval = activeWarnings.get(userId);
  if (!interval) return;

  clearInterval(interval);
  activeWarnings.delete(userId);
}

async function sendDutyWarning(member) {
  const content = `<@${member.id}> ${DUTY_WARNING_MESSAGE}`;

  try {
    await member.send(content);
    return;
  } catch {
    // Fall back to a visible ping in a shared channel if DMs are closed.
  }

  const channel =
    member.guild.systemChannel ??
    member.guild.channels.cache.find(
      (entry) =>
        entry.isTextBased() &&
        entry.permissionsFor(member.guild.members.me)?.has(["ViewChannel", "SendMessages"]),
    );

  if (channel) {
    await channel.send({ content, allowedMentions: { users: [member.id] } }).catch(() => null);
  }
}

function startDutyWarning(member) {
  if (!isCadetOnDuty(member)) {
    stopDutyWarning(member.id);
    return;
  }

  if (activeWarnings.has(member.id)) return;

  sendDutyWarning(member).catch(() => null);

  const interval = setInterval(() => {
    member.guild.members
      .fetch(member.id)
      .then((freshMember) => {
        if (!isCadetOnDuty(freshMember)) {
          stopDutyWarning(freshMember.id);
          return;
        }

        sendDutyWarning(freshMember).catch(() => null);
      })
      .catch(() => stopDutyWarning(member.id));
  }, DUTY_WARNING_INTERVAL_MS);

  activeWarnings.set(member.id, interval);
}

function scanCadetDutyState(member) {
  if (isCadetOnDuty(member)) {
    startDutyWarning(member);
    return;
  }

  stopDutyWarning(member.id);
}

function scanAllMembers(client) {
  for (const guild of client.guilds.cache.values()) {
    guild.members
      .fetch()
      .then((members) => {
        for (const member of members.values()) {
          scanCadetDutyState(member);
        }
      })
      .catch((error) => {
        console.warn(`[cadet-duty] Could not scan ${guild.name}:`, error.message);
      });
  }
}

function registerCadetDutyGuard(client) {
  scanAllMembers(client);

  client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (oldMember.roles.cache.equals(newMember.roles.cache)) return;
    scanCadetDutyState(newMember);
  });

  client.on(Events.GuildMemberRemove, (member) => {
    stopDutyWarning(member.id);
  });

  console.log("[cadet-duty] Watching cadets with the on-duty role.");
}

module.exports = {
  registerCadetDutyGuard,
  scanCadetDutyState,
  isCadetOnDuty,
};
