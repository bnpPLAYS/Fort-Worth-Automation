async function ensureMessageMember(message) {
  if (message.member) {
    return message.member;
  }

  if (!message.guild) {
    return null;
  }

  return message.guild.members.fetch(message.author.id).catch(() => null);
}

async function getMemberVoiceChannel(member) {
  if (!member?.guild) {
    return null;
  }

  const fresh = await member.guild.members
    .fetch({ user: member.id, force: true })
    .catch(() => member);

  const channelId = fresh.voice?.channelId;
  if (!channelId) {
    return null;
  }

  if (fresh.voice.channel) {
    return fresh.voice.channel;
  }

  return fresh.guild.channels.cache.get(channelId) ??
    (await fresh.guild.channels.fetch(channelId).catch(() => null));
}

module.exports = {
  ensureMessageMember,
  getMemberVoiceChannel,
};
