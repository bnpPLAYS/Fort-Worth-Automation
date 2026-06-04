const { PermissionFlagsBits } = require("discord.js");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { STAFF_PING_ROLE_ID } = require("./constants");
const { synthesizeSpeech, deleteTempFile } = require("./voice/tts");
const { joinMemberVoiceChannel, playFile, destroyVoiceSession } = require("./voice/audio");
const { ensureMessageMember } = require("./voice/member-voice");

const SILENCE_COMMAND = "-silence";
const COOLDOWN_MS = 15_000;

const lastUsedByGuild = new Map();

function canUseSilence(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member?.permissions?.has(PermissionFlagsBits.ManageRoles)
  ) {
    return true;
  }

  return member?.roles?.cache?.has(STAFF_PING_ROLE_ID);
}

async function handleSilenceCommand(message) {
  if (message.author.bot || !message.guild) return false;

  const content = message.content.trim();
  if (content.toLowerCase() !== SILENCE_COMMAND) return false;

  if (hasProcessed(`silence-cmd:${message.id}`)) return true;
  markProcessed(`silence-cmd:${message.id}`);

  if (!canUseSilence(message.member)) {
    await message.reply("You do not have permission to use this command.");
    return true;
  }

  const lastUsed = lastUsedByGuild.get(message.guild.id) ?? 0;
  if (Date.now() - lastUsed < COOLDOWN_MS) {
    const secondsLeft = Math.ceil((COOLDOWN_MS - (Date.now() - lastUsed)) / 1000);
    await message.reply(`Silence is on cooldown. Try again in **${secondsLeft}s**.`);
    return true;
  }

  let voiceSession;
  try {
    const member = await ensureMessageMember(message);
    if (!member) {
      await message.reply("Could not resolve your server membership.");
      return true;
    }

    voiceSession = await joinMemberVoiceChannel(member);
  } catch (error) {
    await message.reply(error.message ?? "Could not join your voice channel.");
    return true;
  }

  lastUsedByGuild.set(message.guild.id, Date.now());

  const { connection, player, voiceChannel } = voiceSession;
  const screamText = "SILENCE! SILENCE! SILENCE!";

  try {
    const filePath = await synthesizeSpeech(screamText, { slow: false });
    try {
      await playFile(player, filePath, { volume: 2 });
    } finally {
      deleteTempFile(filePath);
    }

    await message.react("🔇").catch(() => null);
  } catch (error) {
    console.error("[silence] Failed:", error);
    await message.reply("Could not scream silence. Check bot voice permissions and FFmpeg.").catch(() => null);
  } finally {
    await destroyVoiceSession(connection, player);
  }

  return true;
}

module.exports = {
  handleSilenceCommand,
};
