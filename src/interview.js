const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  PermissionFlagsBits,
} = require("discord.js");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { STAFF_PING_ROLE_ID } = require("./constants");
const { synthesizeSpeech, deleteTempFile } = require("./voice/tts");
const {
  joinMemberVoiceChannel,
  playFile,
  destroyVoiceSession,
  waitForUserToFinishSpeaking,
} = require("./voice/audio");

const INTERVIEW_COMMAND = "-interview";
const CONTINUE_PREFIX = "interview_continue:";

const QUESTIONS = [
  "How active are you on the server weekly?",
  "Do you have previous law enforcement RP experience?",
  "Why should we choose you over other applicants?",
  "What qualities would you bring to the department?",
  "What should you do before initiating a traffic stop?",
  "When is it appropriate to use force during a situation?",
  "What should you do if a suspect refuses to comply with orders?",
  "What is officer safety, and why is it important?",
  "What would you do if another officer made a mistake on scene?",
  "What is the most important trait for a law enforcement officer?",
];

const sessions = new Map();

function canInterviewOthers(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member?.permissions?.has(PermissionFlagsBits.ManageRoles)
  ) {
    return true;
  }

  return member?.roles?.cache?.has(STAFF_PING_ROLE_ID);
}

function getSession(guildId) {
  return sessions.get(guildId) ?? null;
}

function buildContinueRow(guildId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONTINUE_PREFIX}${guildId}`)
      .setLabel("Continue")
      .setStyle(ButtonStyle.Danger),
  );
}

async function speakText(session, text) {
  const filePath = await synthesizeSpeech(text);
  try {
    await playFile(session.player, filePath);
  } finally {
    deleteTempFile(filePath);
  }
}

async function postContinuePrompt(client, session) {
  const textChannel = await client.channels.fetch(session.textChannelId).catch(() => null);
  if (!textChannel?.isTextBased()) return;

  session.waitingForContinue = true;

  const content =
    `<@${session.intervieweeId}> **Continue?**\n` +
    `Click **Continue** when you are ready for the next question.`;

  const message = await textChannel.send({
    content,
    components: [buildContinueRow(session.guildId)],
    allowedMentions: { users: [session.intervieweeId] },
  });

  session.continueMessageId = message.id;
}

async function runQuestion(client, session) {
  if (session.cancelled) return;

  const questionNumber = session.questionIndex + 1;
  const question = QUESTIONS[session.questionIndex];
  const spoken =
    questionNumber === 1
      ? `Welcome to your Houston Police Department voice interview. Question ${questionNumber}. ${question}`
      : `Question ${questionNumber}. ${question}`;

  session.waitingForContinue = false;
  session.waitingForSpeech = true;

  try {
    await speakText(session, spoken);
  } catch (error) {
    console.error("[interview] TTS failed:", error);
    await endInterview(client, session.guildId, {
      reason: "Could not play the interview question. Check that FFmpeg is available on the server.",
    });
    return;
  }

  if (session.cancelled) return;

  await waitForUserToFinishSpeaking(session.connection, session.intervieweeId);
  session.waitingForSpeech = false;

  if (session.cancelled) return;

  await postContinuePrompt(client, session);
}

async function finishInterview(client, session) {
  try {
    await speakText(session, "Interview complete. Thank you for your responses.");
  } catch (error) {
    console.error("[interview] Closing TTS failed:", error);
  }

  const textChannel = await client.channels.fetch(session.textChannelId).catch(() => null);
  if (textChannel?.isTextBased()) {
    await textChannel.send(
      `<@${session.intervieweeId}> Your voice interview is **complete**. Thank you!`,
    );
  }

  await endInterview(client, session.guildId, { silent: true });
}

async function endInterview(client, guildId, { reason, silent = false } = {}) {
  const session = sessions.get(guildId);
  if (!session) return;

  session.cancelled = true;
  sessions.delete(guildId);

  await destroyVoiceSession(session.connection, session.player);

  if (!silent && reason) {
    const textChannel = await client.channels.fetch(session.textChannelId).catch(() => null);
    if (textChannel?.isTextBased()) {
      await textChannel.send(reason).catch(() => null);
    }
  }

  if (session.continueMessageId) {
    const textChannel = await client.channels.fetch(session.textChannelId).catch(() => null);
    const message = await textChannel?.messages.fetch(session.continueMessageId).catch(() => null);
    if (message) {
      await message.edit({ components: [] }).catch(() => null);
    }
  }
}

async function resolveInterviewee(message) {
  const mentioned = message.mentions.users.first();

  if (mentioned) {
    if (!canInterviewOthers(message.member)) {
      return {
        error: "You need staff permissions to start an interview for someone else.",
      };
    }

    const member = await message.guild.members.fetch(mentioned.id).catch(() => null);
    if (!member) {
      return { error: "That member is not in this server." };
    }

    const hostChannelId = message.member.voice.channelId;
    if (!hostChannelId) {
      return { error: "You must be in a voice channel to host an interview." };
    }

    if (member.voice.channelId !== hostChannelId) {
      return { error: `<@${member.id}> must be in your voice channel.` };
    }

    return { interviewee: member, hostChannel: message.member.voice.channel };
  }

  if (!message.member.voice.channel) {
    return { error: "Join a voice channel first, then run `-interview`." };
  }

  return {
    interviewee: message.member,
    hostChannel: message.member.voice.channel,
  };
}

async function handleInterviewCommand(message) {
  if (message.author.bot || !message.guild) return false;

  const content = message.content.trim();
  if (content.toLowerCase() !== INTERVIEW_COMMAND && !content.toLowerCase().startsWith(`${INTERVIEW_COMMAND} `)) {
    return false;
  }

  if (hasProcessed(`interview-cmd:${message.id}`)) return true;
  markProcessed(`interview-cmd:${message.id}`);

  if (getSession(message.guild.id)) {
    await message.reply("An interview is already running in this server.");
    return true;
  }

  const resolved = await resolveInterviewee(message);
  if (resolved.error) {
    await message.reply(resolved.error);
    return true;
  }

  const { interviewee, hostChannel } = resolved;

  let voiceSession;
  try {
    voiceSession = await joinMemberVoiceChannel(message.member);
  } catch (error) {
    await message.reply(error.message ?? "Could not join the voice channel.");
    return true;
  }

  if (voiceSession.voiceChannel.id !== hostChannel.id) {
    await destroyVoiceSession(voiceSession.connection, voiceSession.player);
    await message.reply("Could not join your voice channel.");
    return true;
  }

  const session = {
    guildId: message.guild.id,
    textChannelId: message.channel.id,
    voiceChannelId: hostChannel.id,
    intervieweeId: interviewee.id,
    startedById: message.author.id,
    questionIndex: 0,
    waitingForSpeech: false,
    waitingForContinue: false,
    cancelled: false,
    connection: voiceSession.connection,
    player: voiceSession.player,
    continueMessageId: null,
  };

  sessions.set(message.guild.id, session);

  await message.reply(
    `Starting voice interview for <@${interviewee.id}> in **${hostChannel.name}**. ` +
      `Answer each question in voice, then click **Continue** in this channel.`,
  );

  runQuestion(message.client, session).catch(async (error) => {
    console.error("[interview] Question loop failed:", error);
    await endInterview(message.client, message.guild.id, {
      reason: "The interview stopped because of an error. Please try again.",
    });
  });

  return true;
}

async function handleInterviewInteraction(interaction) {
  if (!interaction.isButton() || !interaction.customId.startsWith(CONTINUE_PREFIX)) {
    return false;
  }

  const guildId = interaction.customId.slice(CONTINUE_PREFIX.length);
  const session = getSession(guildId);

  if (!session || !session.waitingForContinue) {
    await interaction.reply({ content: "This interview prompt is no longer active.", ephemeral: true });
    return true;
  }

  if (interaction.user.id !== session.intervieweeId) {
    await interaction.reply({
      content: "Only the person being interviewed can click **Continue**.",
      ephemeral: true,
    });
    return true;
  }

  if (hasProcessed(`interview-continue:${interaction.id}`)) return true;
  markProcessed(`interview-continue:${interaction.id}`);

  await interaction.deferUpdate();
  await interaction.message.edit({ components: [] }).catch(() => null);

  session.questionIndex += 1;

  if (session.questionIndex >= QUESTIONS.length) {
    await finishInterview(interaction.client, session);
    return true;
  }

  runQuestion(interaction.client, session).catch(async (error) => {
    console.error("[interview] Question loop failed:", error);
    await endInterview(interaction.client, guildId, {
      reason: "The interview stopped because of an error. Please try again.",
    });
  });

  return true;
}

function registerInterviewVoiceHandlers(client) {
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const session = getSession(newState.guild.id);
    if (!session) return;

    if (newState.id !== session.intervieweeId) return;

    const leftChannel =
      oldState.channelId === session.voiceChannelId && newState.channelId !== session.voiceChannelId;

    if (leftChannel) {
      await endInterview(client, session.guildId, {
        reason: `<@${session.intervieweeId}> left the voice channel — interview ended.`,
      });
    }
  });
}

module.exports = {
  INTERVIEW_COMMAND,
  handleInterviewCommand,
  handleInterviewInteraction,
  registerInterviewVoiceHandlers,
};
