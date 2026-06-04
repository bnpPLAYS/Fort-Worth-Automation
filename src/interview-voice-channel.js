const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { STAFF_PING_ROLE_ID } = require("./constants");

function sanitizeChannelName(value) {
  const cleaned = String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return (cleaned || "interview").slice(0, 90);
}

async function uniqueVoiceChannelName(guild, baseName) {
  let name = baseName;
  let suffix = 1;

  while (guild.channels.cache.some((channel) => channel.name === name)) {
    name = `${baseName}-${suffix}`.slice(0, 100);
    suffix += 1;
  }

  return name;
}

function getInterviewCategoryId() {
  const fromEnv = String(process.env.INTERVIEW_VC_CATEGORY_ID ?? "").trim();
  return fromEnv || null;
}

async function createInterviewVoiceChannel(guild, interviewee) {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error("I need **Manage Channels** permission to create an interview voice channel.");
  }

  const baseName = await uniqueVoiceChannelName(
    guild,
    sanitizeChannelName(`interview-${interviewee.user.username}`),
  );

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    },
    {
      id: interviewee.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ],
    },
    {
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.MoveMembers,
      ],
    },
  ];

  if (guild.roles.cache.has(STAFF_PING_ROLE_ID)) {
    permissionOverwrites.push({
      id: STAFF_PING_ROLE_ID,
      allow: [PermissionFlagsBits.ViewChannel],
      deny: [PermissionFlagsBits.Connect],
    });
  }

  const channel = await guild.channels.create({
    name: baseName,
    type: ChannelType.GuildVoice,
    parent: getInterviewCategoryId(),
    permissionOverwrites,
    reason: `Private voice interview for ${interviewee.user.tag}`,
  });

  return channel;
}

async function moveMemberToInterviewChannel(member, channel) {
  if (!member?.voice?.channelId || member.voice.channelId === channel.id) {
    if (member.voice?.channelId === channel.id) {
      return;
    }

    await member.voice.setChannel(channel).catch(() => {
      throw new Error(
        `Join ${channel} to start your interview. Only you can connect to that channel.`,
      );
    });
    return;
  }

  await member.voice.setChannel(channel).catch(() => {
    throw new Error(
      `Could not move you to ${channel}. Disconnect from your current call and join **${channel.name}** — only you can connect.`,
    );
  });
}

async function deleteInterviewVoiceChannel(guild, channelId) {
  if (!channelId) return;

  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  await channel.delete("Interview session ended").catch((error) => {
    console.warn("[interview] Could not delete interview VC:", error.message);
  });
}

module.exports = {
  createInterviewVoiceChannel,
  moveMemberToInterviewChannel,
  deleteInterviewVoiceChannel,
};
