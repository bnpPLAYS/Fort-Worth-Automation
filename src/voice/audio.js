const ffmpegPath = require("ffmpeg-static");
const {
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  entersState,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
} = require("@discordjs/voice");
const { spawn } = require("child_process");

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

async function joinMemberVoiceChannel(member) {
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    throw new Error("You must be in a voice channel to start an interview.");
  }

  const permissions = voiceChannel.permissionsFor(member.guild.members.me);
  if (!permissions?.has("Connect") || !permissions?.has("Speak")) {
    throw new Error("I need **Connect** and **Speak** permission in your voice channel.");
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: member.guild.id,
    adapterCreator: member.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

  const player = createAudioPlayer();
  connection.subscribe(player);

  return { connection, player, voiceChannel };
}

async function playFile(player, filePath) {
  const resource = createMp3Resource(filePath);
  player.play(resource);
  await entersState(player, AudioPlayerStatus.Playing, 30_000).catch(() => null);
  await entersState(player, AudioPlayerStatus.Idle, 300_000);
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

    const timeout = setTimeout(() => {
      cleanup();
      resolve({ spoke });
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
      resolve({ spoke: true });
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
  joinMemberVoiceChannel,
  playFile,
  destroyVoiceSession,
  waitForUserToFinishSpeaking,
};
