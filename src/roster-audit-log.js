const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { buildV2Payload } = require("./v2-message");
const { STAFF_PING_ROLE_ID, ROSTER_ADD_STAFF_ROLE_IDS, BOT_NAME } = require("./constants");
const { getAuditChannelId, setAuditChannelId } = require("./guild-settings-store");

const DEFAULT_CHANNEL_NAME = "roster-audit";

function normalizeEnv(value) {
  if (!value) return "";
  return String(value).trim().replace(/^["']|["']$/g, "");
}

function formatUser(userOrMember) {
  if (!userOrMember) return "Unknown";
  const user = userOrMember.user ?? userOrMember;
  return `<@${user.id}> (\`${user.tag ?? user.username ?? user.id}\`)`;
}

function buildAuditFields({ actor, target, roleplayName, callsign, rank, rowNumber, trigger, notes }) {
  const fields = [];

  if (actor) fields.push({ name: "Actor", value: formatUser(actor) });
  if (target) fields.push({ name: "Member", value: formatUser(target) });
  if (roleplayName) fields.push({ name: "Roster name", value: roleplayName });
  if (callsign) fields.push({ name: "Callsign", value: String(callsign) });
  if (rank) fields.push({ name: "Rank", value: String(rank) });
  if (rowNumber) fields.push({ name: "Sheet row", value: String(rowNumber) });
  if (trigger) fields.push({ name: "Source", value: String(trigger) });
  if (notes) fields.push({ name: "Notes", value: String(notes).slice(0, 1024) });

  return fields;
}

async function ensureAuditChannel(guild) {
  if (!guild) return null;

  const existingId = getAuditChannelId(guild.id);
  if (existingId) {
    const existing = await guild.channels.fetch(existingId).catch(() => null);
    if (existing?.isTextBased()) {
      return existing;
    }
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    return null;
  }

  const staffRoleIds = [...new Set([STAFF_PING_ROLE_ID, ...ROSTER_ADD_STAFF_ROLE_IDS])];
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];

  for (const roleId of staffRoleIds) {
    if (guild.roles.cache.has(roleId)) {
      permissionOverwrites.push({
        id: roleId,
        allow: [PermissionFlagsBits.ViewChannel],
      });
    }
  }

  const channel = await guild.channels.create({
    name: DEFAULT_CHANNEL_NAME,
    type: ChannelType.GuildText,
    topic: "Automated roster, rank, and department action logs.",
    permissionOverwrites,
    reason: `${BOT_NAME} audit log setup`,
  });

  setAuditChannelId(guild.id, channel.id);
  return channel;
}

async function getAuditChannel(guild) {
  if (!guild) return null;

  const channelId = getAuditChannelId(guild.id);
  if (!channelId) return null;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

async function logRosterAudit(client, guildId, options = {}) {
  const {
    title = "Roster update",
    description,
    actor,
    target,
    roleplayName,
    callsign,
    rank,
    rowNumber,
    trigger,
    notes,
    fields: extraFields = [],
  } = options;

  if (!client || !guildId) return false;

  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return false;

    let channel = await getAuditChannel(guild);
    if (!channel) {
      channel = await ensureAuditChannel(guild);
    }
    if (!channel) {
      console.warn("[audit-log] No audit channel available for guild", guildId);
      return false;
    }

    const fields = [
      ...buildAuditFields({ actor, target, roleplayName, callsign, rank, rowNumber, trigger, notes }),
      ...extraFields,
    ];

    await channel.send(
      buildV2Payload({
        title,
        description,
        fields,
        includeFiles: false,
      }),
    );

    return true;
  } catch (error) {
    console.error("[audit-log] Failed to post audit entry:", error);
    return false;
  }
}

function logRosterResultAudit(client, guildId, options = {}) {
  const {
    trigger,
    actor,
    target,
    roleplayName,
    rosterResult,
    notes,
  } = options;

  if (!rosterResult) return Promise.resolve(false);

  return logRosterAudit(client, guildId, {
    title: "Roster assignment",
    actor,
    target,
    roleplayName: roleplayName ?? rosterResult.roleplayName,
    callsign: rosterResult.newCallsign ?? rosterResult.callsign,
    rank: rosterResult.newRank ?? rosterResult.rank,
    rowNumber: rosterResult.rowNumber,
    trigger,
    notes:
      notes ??
      (rosterResult.previousCallsign
        ? `Previous: ${rosterResult.previousRank ?? "none"} / ${rosterResult.previousCallsign}`
        : undefined),
  });
}

module.exports = {
  DEFAULT_CHANNEL_NAME,
  ensureAuditChannel,
  getAuditChannel,
  logRosterAudit,
  logRosterResultAudit,
};
