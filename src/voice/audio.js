const ffmpegPath = require("ffmpeg-static");
const { PermissionFlagsBits } = require("discord.js");
const {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  getVoiceConnection,
} = require("@discordjs/voice");
const { spawn } = require("child_process");
const { ensureVoiceReady } = require("./init");
const { getMemberVoiceChannel } = require("./member-voice");

if (ffmpegPath) {
  process.env.FFMPEG_PATH = ffmpegPath;
}

function createMp3Resource(filePath) {
  if (!ffmpegPath) {
    return createAudioResource(filePath);
  }

  const ffmpeg = spawn(ffmpegPath, [
    "-i",
    filePath,
    "-analyzeduration",
    "0",
    "-loglevel",
    "0",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "pipe:1",
  ]);

  ffmpeg.stderr.on("data", () => {});

  return createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
  });
}

async function joinVoiceChannelById(guild, channelId) {
  await ensureVoiceReady();

  const voiceChannel =
    guild.channels.cache.get(channelId) ??
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!voiceChannel?.isVoiceBased()) {
    throw new Error("Interview voice channel not found.");
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  const permissions = voiceChannel.permissionsFor(me);
  if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions?.has(PermissionFlagsBits.Speak)) {
    throw new Error("I need **Connect** and **Speak** permission in the interview voice channel.");
  }

  const existing = getVoiceConnection(guild.id);
  if (existing) {
    existing.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    connection.destroy();
    throw new Error("Could not connect to voice. Check bot permissions and try again.");
  }

  const player = createAudioPlayer();
  connection.subscribe(player);

  return { connection, player, voiceChannel };
}

async function joinMemberVoiceChannel(member) {
  await ensureVoiceReady();

  const voiceChannel = await getMemberVoiceChannel(member);
  if (!voiceChannel) {
    throw new Error("Join a voice channel first, then run the command again.");
  }

  const me = member.guild.members.me ?? (await member.guild.members.fetchMe().catch(() => null));
  const permissions = voiceChannel.permissionsFor(me);
  if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions?.has(PermissionFlagsBits.Speak)) {
    throw new Error("I need **Connect** and **Speak** permission in your voice channel.");
  }

  const existing = getVoiceConnection(member.guild.id);
  if (existing) {
    existing.destroy();
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: member.guild.id,
    adapterCreator: member.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (error) {
    connection.destroy();
    throw new Error("Could not connect to voice. Check bot permissions and try again.");
  }

  const player = createAudioPlayer();
  connection.subscribe(player);

  return { connection, player, voiceChannel };
}

async function playFile(player, filePath, { volume = 1 } = {}) {
  const resource = createMp3Resource(filePath);

  if (resource.volume && volume !== 1) {
    resource.volume.setVolume(Math.min(Math.max(volume, 0.1), 2));
  }

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(new Error(`Could not play audio in voice (${error.message}).`));
    };

    const cleanup = () => {
      player.removeListener("error", onError);
    };

    player.on("error", onError);
    player.play(resource);

    entersState(player, AudioPlayerStatus.Playing, 30_000)
      .then(() => entersState(player, AudioPlayerStatus.Idle, 300_000))
      .then(() => {
        cleanup();
        resolve();
      })
      .catch((error) => {
        cleanup();
        reject(
          error?.message?.includes("timed out")
            ? new Error("Voice playback timed out. Check that FFmpeg is installed and the bot can speak.")
            : error,
        );
      });
  });
}

async function destroyVoiceSession(connection, player) {
  try {
    player?.stop(true);
  } catch {
    // ignore
  }

  try {
    connection?.destroy();
  } catch {
    // ignore
  }
}

function waitForUserToFinishSpeaking(connection, userId, { timeoutMs = 180_000, minSpeechMs = 800 } = {}) {
  return new Promise((resolve) => {
    const receiver = connection.receiver;
    let spoke = false;
    let speechStartedAt = 0;
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      cleanup();
      resolve({ spoke: false, timedOut: true });
    }, timeoutMs);

    function onStart(id) {
      if (id !== userId) return;
      spoke = true;
      speechStartedAt = Date.now();
    }

    function onEnd(id) {
      if (id !== userId || !spoke) return;
      if (Date.now() - speechStartedAt < minSpeechMs) return;
      cleanup();
      resolve({ spoke: true, timedOut: false });
    }

    function cleanup() {
      clearTimeout(timeout);
      receiver.speaking.removeListener("start", onStart);
      receiver.speaking.removeListener("end", onEnd);
    }

    receiver.speaking.on("start", onStart);
    receiver.speaking.on("end", onEnd);
  });
}

module.exports = {
  joinVoiceChannelById,
  joinMemberVoiceChannel,
  playFile,
  destroyVoiceSession,
  waitForUserToFinishSpeaking,
};
