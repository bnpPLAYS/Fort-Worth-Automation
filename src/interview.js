const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const fs = require("fs");
const { COOLDOWN_MS, clearCooldown, getCooldownEnd, isOnCooldown, setCooldown } = require("./cooldowns");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { STAFF_PING_ROLE_ID } = require("./constants");
const { buildV2Payload, buildV2EditPayload } = require("./v2-message");
const { getRoleplayNameFromMember } = require("./discord-callsign");
const { formatRoleplayInitials } = require("./roleplay-name");
const { isSheetsConfigured } = require("./google-sheets/client");
const { completeMemberRosterSetup } = require("./roster-onboarding");
const { logRosterAudit } = require("./roster-audit-log");
const {
  RANK_OPTIONS,
  resolveAssignmentRoleIds,
  assignRankRolesToMember,
} = require("./rank-options");
const {
  getInterviewApplication,
  saveInterviewApplication,
  listInterviewApplications,
  clearInterviewApplicationsForUser,
} = require("./interview-applications-store");
const { synthesizeSpeech, deleteTempFile } = require("./voice/tts");
const { ensureMessageMember, getMemberVoiceChannel } = require("./voice/member-voice");
const { VoiceInterviewRecorder } = require("./voice/recorder");
const {
  joinVoiceChannelById,
  playFile,
  destroyVoiceSession,
  waitForUserToFinishSpeaking,
} = require("./voice/audio");
const {
  createInterviewVoiceChannel,
  moveMemberToInterviewChannel,
  deleteInterviewVoiceChannel,
} = require("./interview-voice-channel");
const {
  isBlockedFromRecruitmentFlows,
  RECRUITMENT_BLOCKED_MESSAGE,
} = require("./member-roster");

const INTERVIEW_COMMAND = "-interview";
const INTERVIEW_CLEAR_COMMAND = "-clearinterview";
const CONTINUE_PREFIX = "interview_continue:";
const DISCONTINUE_PREFIX = "interview_discontinue:";
const ADD_NOTE_PREFIX = "interview_add_note:";
const REPEAT_PREFIX = "interview_repeat:";
const MODAL_NOTE_PREFIX = "interview_note_modal:";
const MODAL_DISCONTINUE_PREFIX = "interview_discontinue_modal:";
const ACCEPT_PREFIX = "voice_interview_accept:";
const DENY_PREFIX = "voice_interview_deny:";
const ASK_AGAIN_PREFIX = "voice_interview_ask_again:";
const ASK_AGAIN_SELECT_PREFIX = "voice_interview_ask_again_select:";
const RETAKE_READY_PREFIX = "voice_interview_retake_ready:";
const RANK_SELECT_PREFIX = "voice_interview_rank:";
const MODAL_DENY_PREFIX = "voice_interview_deny_modal:";
const MODAL_ROLEPLAY_PREFIX = "interview_roleplay_modal:";
const INTERVIEW_START_PREFIX = "interview_start:";
const INTERVIEW_DASHBOARD_BUTTON_ID = "interview_apply";
const INTERVIEW_COOLDOWN_TYPE = "interview";
const INTERVIEW_QUEUE_GUILD_ID = "1484948320534265879";
const INTERVIEW_QUEUE_VOICE_CHANNEL_ID = "1495604479070961694";
const INTERVIEW_QUEUE_VOICE_URL = `https://discord.com/channels/${INTERVIEW_QUEUE_GUILD_ID}/${INTERVIEW_QUEUE_VOICE_CHANNEL_ID}`;

const GUIDE_CHANNEL_ID = "1484990957299564666";
const DEFAULT_SUBMISSIONS_CHANNEL_ID = "1507976263141163008";
const MIC_WARNING_TEXT =
  "Please ensure you are near your microphone so we can understand you.";
/** Silence after the applicant stops speaking before showing Continue. */
const ANSWER_SILENCE_MS = 5000;

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

const RANKS = RANK_OPTIONS.filter((rank) => !rank.useCadetCallsign).map((rank) => ({
  id: rank.id,
  label: rank.label,
}));

const sessions = new Map();
const applications = new Map();
const retakeInProgress = new Set();
const pendingInterviewStarts = new Map();

const PENDING_INTERVIEW_TTL_MS = 30 * 60 * 1000;

function pendingInterviewKey(guildId, intervieweeId) {
  return `${guildId}:${intervieweeId}`;
}

function getPendingInterviewStart(guildId, intervieweeId) {
  const pending = pendingInterviewStarts.get(pendingInterviewKey(guildId, intervieweeId));
  if (!pending) return null;

  if (Date.now() - pending.createdAt > PENDING_INTERVIEW_TTL_MS) {
    pendingInterviewStarts.delete(pendingInterviewKey(guildId, intervieweeId));
    return null;
  }

  return pending;
}

function hasPendingInterviewSubmission(userId) {
  return listInterviewApplications({ status: "pending" }).some(
    (application) => application.userId === userId,
  );
}

function isIntervieweeInActiveSession(guildId, userId) {
  const session = getSession(guildId);
  return session?.intervieweeId === userId;
}

async function assertIntervieweeInQueueVoice(interviewee) {
  const voiceChannel = await getMemberVoiceChannel(interviewee);

  if (!voiceChannel) {
    throw new Error(
      `Join the interview waiting voice channel first, then start again:\n${INTERVIEW_QUEUE_VOICE_URL}\n\n` +
        "Once you're connected there, we'll move you into a private voice channel for the interview.",
    );
  }

  if (voiceChannel.id !== INTERVIEW_QUEUE_VOICE_CHANNEL_ID) {
    throw new Error(
      `Join the interview waiting voice channel to continue:\n${INTERVIEW_QUEUE_VOICE_URL}\n\n` +
        `You are currently in **#${voiceChannel.name}**.`,
    );
  }
}

async function assertIntervieweeCanStart(guild, interviewee, { checkQueueVoice = false } = {}) {
  if (isBlockedFromRecruitmentFlows(interviewee)) {
    throw new Error(RECRUITMENT_BLOCKED_MESSAGE);
  }

  if (isIntervieweeInActiveSession(guild.id, interviewee.id)) {
    throw new Error("You already have a voice interview in progress in this server.");
  }

  if (hasPendingInterviewSubmission(interviewee.id)) {
    throw new Error(
      "You already have a voice interview awaiting staff review. Wait until it is accepted or denied before starting another.",
    );
  }

  if (isOnCooldown(interviewee.id, INTERVIEW_COOLDOWN_TYPE)) {
    const cooldownEnd = getCooldownEnd(interviewee.id, INTERVIEW_COOLDOWN_TYPE);
    throw new Error(
      `You cannot start another voice interview until <t:${Math.floor(cooldownEnd / 1000)}:F> (<t:${Math.floor(cooldownEnd / 1000)}:R>).`,
    );
  }

  if (checkQueueVoice) {
    await assertIntervieweeInQueueVoice(interviewee);
  }
}

function buildRoleplayNameModal(guildId, intervieweeId) {
  return new ModalBuilder()
    .setCustomId(`${MODAL_ROLEPLAY_PREFIX}${guildId}:${intervieweeId}`)
    .setTitle("Voice Interview — Roleplay Name")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("roleplay_name")
          .setLabel("Full roleplay name")
          .setPlaceholder("John Smith (roster name will be J. Smith)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(100),
      ),
    );
}

function buildInterviewStartButton(guildId, intervieweeId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${INTERVIEW_START_PREFIX}${guildId}:${intervieweeId}`)
      .setLabel("Enter Roleplay Name & Start")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildInterviewPanelButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(INTERVIEW_DASHBOARD_BUTTON_ID)
      .setLabel("Voice Interview")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildRoleplayPromptDescription(interviewee, hostMember) {
  const selfServe = hostMember.id === interviewee.id;
  const intro = selfServe
    ? `<@${interviewee.id}> Join the interview waiting voice channel, then enter your **full roleplay name**.`
    : `<@${interviewee.id}> Staff started a voice interview for you. Join the waiting voice channel, then enter your **full roleplay name**.`;

  return (
    `${intro}\n\n` +
    `Waiting room: ${INTERVIEW_QUEUE_VOICE_URL}\n\n` +
    "Example: **John Smith** → roster name **J. Smith**\n\n" +
    "If you pass, this name is used to add you to the roster."
  );
}

async function promptInterviewRoleplayName(client, { guild, textChannel, hostMember, interviewee, interaction }) {
  if (getSession(guild.id)) {
    throw new Error("An interview is already running in this server.");
  }

  const selfServe = hostMember.id === interviewee.id;
  await assertIntervieweeCanStart(guild, interviewee, { checkQueueVoice: selfServe });

  pendingInterviewStarts.set(pendingInterviewKey(guild.id, interviewee.id), {
    guildId: guild.id,
    textChannelId: textChannel.id,
    hostMemberId: hostMember.id,
    intervieweeId: interviewee.id,
    createdAt: Date.now(),
  });

  if (
    interaction &&
    interaction.user.id === interviewee.id &&
    (interaction.isChatInputCommand() || interaction.customId === INTERVIEW_DASHBOARD_BUTTON_ID)
  ) {
    await interaction.showModal(buildRoleplayNameModal(guild.id, interviewee.id));
    return;
  }

  await textChannel.send(
    buildV2Payload({
      withTicketBanner: true,
      title: "Voice Interview — Roleplay Name Required",
      description: buildRoleplayPromptDescription(interviewee, hostMember),
      actionRows: [buildInterviewStartButton(guild.id, interviewee.id)],
      allowedMentions: { users: [interviewee.id] },
    }),
  );

  if (interaction && interaction.isChatInputCommand() && interaction.user.id !== interviewee.id) {
    await interaction.reply({
      content: `Waiting for <@${interviewee.id}> to enter their roleplay name and start.`,
      ephemeral: true,
    });
  }
}

function getSubmissionsChannelId() {
  return process.env.INTERVIEW_SUBMISSIONS_CHANNEL_ID || DEFAULT_SUBMISSIONS_CHANNEL_ID;
}

async function resolveSubmissionsChannel(client, guildId) {
  const channelId = getSubmissionsChannelId();
  let channel = await client.channels.fetch(channelId).catch(() => null);

  if (!channel?.isTextBased() && guildId) {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    channel = await guild?.channels.fetch(channelId).catch(() => null);
  }

  return channel?.isTextBased() ? channel : null;
}

function buildRecordingAttachment(recordingPath, application, { retakeQuestionIndex } = {}) {
  if (!recordingPath || !fs.existsSync(recordingPath)) {
    return null;
  }

  const safeTag = application.userTag.replace(/[^a-z0-9-_]/gi, "-");
  const name =
    retakeQuestionIndex == null
      ? `voice-interview-${safeTag}.mp3`
      : `voice-interview-retake-q${retakeQuestionIndex + 1}-${safeTag}.mp3`;

  return new AttachmentBuilder(recordingPath, { name });
}

async function sendSubmissionPanel(channel, application, appId, { skipStaffPing = false } = {}) {
  const payload = buildSubmissionPayload(application, {
    actionRows: [buildReviewButtons(appId)],
    skipStaffPing,
  });

  return channel.send(payload);
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function truncateField(value) {
  const text = String(value ?? "");
  return text.length > 1024 ? `${text.slice(0, 1021)}...` : text;
}

function canInterviewOthers(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    member?.permissions?.has(PermissionFlagsBits.ManageRoles)
  ) {
    return true;
  }

  return member?.roles?.cache?.has(STAFF_PING_ROLE_ID);
}

function canReviewInterview(member) {
  return canInterviewOthers(member);
}

function getSession(guildId) {
  return sessions.get(guildId) ?? null;
}

function persistApplication(application) {
  if (!application?.appId) return;
  applications.set(application.appId, application);
  saveInterviewApplication(application);
}

function getApplication(appId) {
  if (applications.has(appId)) {
    return applications.get(appId);
  }

  const stored = getInterviewApplication(appId);
  if (stored) {
    applications.set(appId, stored);
  }
  return stored ?? null;
}

function canControlInterviewPanel(member, session) {
  if (!member || !session) return false;
  if (member.id === session.intervieweeId) return true;
  if (member.id === session.startedById) return true;
  return canInterviewOthers(member);
}

function buildAnswerControlRows(guildId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONTINUE_PREFIX}${guildId}`)
        .setLabel("Continue")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${ADD_NOTE_PREFIX}${guildId}`)
        .setLabel("Add Note")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`${REPEAT_PREFIX}${guildId}`)
        .setLabel("Repeat Question")
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DISCONTINUE_PREFIX}${guildId}`)
        .setLabel("Discontinue")
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildInterviewSessionFields(session, { statusNote, micWarning = false } = {}) {
  const questionNumber = session.questionIndex + 1;
  const fields = [
    { name: "Applicant", value: `<@${session.intervieweeId}>` },
    {
      name: "Voice Channel",
      value: session.voiceChannelName ? `#${session.voiceChannelName}` : "Setting up…",
    },
  ];

  if (session.roleplayName) {
    fields.push({
      name: "Roster Name",
      value: session.roleplayNameRaw
        ? `${session.roleplayName} *(from ${session.roleplayNameRaw})*`
        : session.roleplayName,
    });
  }

  if (session.startedAt || session.questionIndex > 0 || session.waitingForContinue) {
    fields.push({
      name: "Progress",
      value:
        session.questionIndex >= QUESTIONS.length
          ? "All questions answered"
          : `Question **${questionNumber}** of **${QUESTIONS.length}**`,
    });
  }

  if (statusNote) {
    fields.push({ name: "Status", value: statusNote });
  }

  if (micWarning) {
    fields.push({
      name: "Microphone",
      value:
        "We could not detect your voice. Move closer to your microphone or use **Add Note** if needed.",
    });
  }

  if (session.notes?.length > 0) {
    fields.push({
      name: "Notes",
      value: `${session.notes.length} note(s) added this interview.`,
    });
  }

  return fields;
}

function buildInterviewSessionPayload(
  session,
  {
    title = "Voice Interview",
    description,
    statusNote,
    micWarning = false,
    actionRows = [],
    footer,
    forEdit = false,
    ephemeral = false,
  } = {},
) {
  const builder = forEdit ? buildV2EditPayload : buildV2Payload;

  return builder({
    withTicketBanner: true,
    title,
    description,
    fields: buildInterviewSessionFields(session, { statusNote, micWarning }),
    footer,
    actionRows,
    allowedMentions: { users: [session.intervieweeId] },
    ephemeral: forEdit ? false : ephemeral,
  });
}

function shouldUseEphemeralInterviewPanel(interaction, intervieweeId) {
  return Boolean(
    interaction &&
      intervieweeId &&
      interaction.user?.id === intervieweeId &&
      (interaction.deferred || interaction.replied),
  );
}

async function publishInterviewStatusMessage(
  interaction,
  textChannel,
  session,
  options,
) {
  const payload = buildInterviewSessionPayload(session, {
    ...options,
    ephemeral: shouldUseEphemeralInterviewPanel(interaction, session.intervieweeId),
  });

  if (shouldUseEphemeralInterviewPanel(interaction, session.intervieweeId)) {
    return interaction.editReply(payload);
  }

  return textChannel.send(payload);
}

async function getInterviewStatusMessage(client, session) {
  if (session?.statusMessage?.editable) {
    return session.statusMessage;
  }

  if (!session?.statusMessageId) return null;

  const textChannel = await client.channels.fetch(session.textChannelId).catch(() => null);
  if (!textChannel?.isTextBased()) return null;

  const message = await textChannel.messages.fetch(session.statusMessageId).catch(() => null);
  if (message) {
    session.statusMessage = message;
  }

  return message;
}

async function editInterviewPanel(client, session, options = {}, sourceInteraction = null) {
  const payload = buildInterviewSessionPayload(session, { ...options, forEdit: true });
  const interaction = sourceInteraction ?? session.statusInteraction;

  if (interaction?.deferred || interaction.replied) {
    try {
      const message = await interaction.editReply(payload);
      session.statusMessage = message;
      if (message?.id) {
        session.statusMessageId = message.id;
      }
      return message;
    } catch (error) {
      console.error("[interview] Panel editReply failed:", error.message, error.code ?? "");
    }
  }

  const message = await getInterviewStatusMessage(client, session);
  if (!message) {
    console.warn("[interview] Status panel message not available for update.");
    return null;
  }

  try {
    const edited = await message.edit(payload);
    session.statusMessage = edited;
    return edited;
  } catch (error) {
    console.error("[interview] Panel message.edit failed:", error.message, error.code ?? "");
    return null;
  }
}

async function updateInterviewStatusMessage(client, session, options = {}, sourceInteraction = null) {
  return editInterviewPanel(client, session, options, sourceInteraction);
}

async function replyInterviewFailure(interaction, description, { session } = {}) {
  const payload = buildV2EditPayload({
    withTicketBanner: true,
    title: "Voice Interview — Failed",
    description,
    actionRows: [],
    fields: session ? buildInterviewSessionFields(session, { statusNote: "Try again or contact staff." }) : [],
  });

  if (interaction?.deferred || interaction?.replied) {
    await interaction.editReply(payload).catch(() => null);
    return;
  }

  if (interaction?.isRepliable()) {
    await interaction.reply({ ...payload, ephemeral: true }).catch(() => null);
  }
}

function formatAnswerPanelDescription(session) {
  return (
    `<@${session.intervieweeId}> Click **Continue** when you are ready for the next question.\n\n` +
    "**Continue** — next question · **Add Note** — type extra info · **Repeat Question** · **Discontinue** — end early"
  );
}

function buildReviewButtons(appId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ACCEPT_PREFIX}${appId}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${DENY_PREFIX}${appId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${ASK_AGAIN_PREFIX}${appId}`)
      .setLabel("Ask Again")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildAskAgainSelect(appId) {
  return new StringSelectMenuBuilder()
    .setCustomId(`${ASK_AGAIN_SELECT_PREFIX}${appId}`)
    .setPlaceholder("Select a question to re-ask")
    .addOptions(
      QUESTIONS.map((question, index) => ({
        label: `Question ${index + 1}`,
        description: question.slice(0, 100),
        value: String(index),
      })),
    );
}

function buildRetakeReadyButton(appId, questionIndex) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RETAKE_READY_PREFIX}${appId}:${questionIndex}`)
      .setLabel("Ready to Re-Answer")
      .setStyle(ButtonStyle.Primary),
  );
}

function formatRetakeRequests(application) {
  if (!application.retakeRequests?.length) return "";

  return application.retakeRequests
    .map((entry) => {
      const status = entry.status === "completed" ? "Completed" : "Pending";
      return `**${status}** — Q${entry.questionIndex + 1} (requested by ${entry.requestedByTag})`;
    })
    .join("\n");
}

function buildRankSelect(appId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${RANK_SELECT_PREFIX}${appId}`)
      .setPlaceholder("Select a rank to assign")
      .addOptions(
        RANKS.map((rank) => ({
          label: rank.label,
          value: rank.id,
        })),
      ),
  );
}

function buildSubmissionPayload(application, { actionRows = [], forEdit = false, skipStaffPing = false } = {}) {
  const {
    userId,
    userTag,
    roleplayName,
    roleplayNameRaw,
    durationMs,
    status,
    reviewerTag,
    rankLabel,
    denyReason,
    submittedAt,
    voiceChannelName,
    hasRecording,
    notes,
    discontinuedEarly,
    discontinueReason,
    retakeRequests,
  } = application;

  const title =
    status === "accepted"
      ? "Voice Interview — Accepted"
      : status === "denied"
        ? "Voice Interview — Denied"
        : "New Voice Interview";

  const fields = [
    { name: "Interview Length", value: formatDuration(durationMs) },
    { name: "Voice Channel", value: voiceChannelName ?? "Unknown" },
    {
      name: "Recording",
      value: hasRecording
        ? "Attached below — includes each spoken question and the applicant's voice answers."
        : "No audio captured.",
    },
  ];

  if (roleplayName) {
    fields.push({
      name: "Roster Name",
      value: roleplayNameRaw ? `${roleplayName} *(from ${roleplayNameRaw})*` : roleplayName,
    });
  }

  fields.push({
    name: "Interview Questions",
    value: truncateField(
      QUESTIONS.map((question, index) => `${index + 1}. ${question}`).join("\n"),
    ),
  });
  fields.push({
    name: "Responses",
    value: "Answers were given in voice — the recording includes both questions and responses.",
  });

  if (discontinuedEarly) {
    fields.push({
      name: "Ended Early",
      value: discontinueReason
        ? truncateField(discontinueReason)
        : "The applicant discontinued before all questions were completed.",
    });
  }

  if (notes?.length > 0) {
    fields.push({
      name: "Applicant Notes",
      value: truncateField(
        notes
          .map(
            (entry) =>
              `**Q${entry.questionIndex + 1}** (${entry.authorTag ?? "applicant"}): ${entry.note}`,
          )
          .join("\n\n"),
      ),
    });
  }

  const retakeSummary = formatRetakeRequests(application);
  if (retakeSummary) {
    fields.push({ name: "Re-Answer Requests", value: truncateField(retakeSummary) });
  }

  if (status === "accepted" && rankLabel) {
    fields.push({ name: "Assigned Rank", value: rankLabel });
  }

  if (status === "denied" && denyReason) {
    fields.push({ name: "Denial Reason", value: truncateField(denyReason) });
  }

  const footerParts = [];
  if (submittedAt) {
    footerParts.push(`Submitted <t:${Math.floor(submittedAt / 1000)}:f>`);
  }
  if (reviewerTag) {
    footerParts.push(`Reviewed by ${reviewerTag}`);
  }

  const builder = forEdit ? buildV2EditPayload : buildV2Payload;

  return builder({
    title,
    description:
      (status === "pending" && !skipStaffPing ? `<@&${STAFF_PING_ROLE_ID}>\n\n` : "") +
      `Applicant: <@${userId}> (\`${userTag}\`)\nUser ID: \`${userId}\``,
    fields,
    footer: footerParts.length > 0 ? footerParts.join(" · ") : undefined,
    actionRows,
    allowedMentions:
      status === "pending" && !skipStaffPing ? { roles: [STAFF_PING_ROLE_ID] } : undefined,
  });
}

async function speakText(session, text) {
  console.log(`[interview] TTS: ${text.slice(0, 80)}${text.length > 80 ? "…" : ""}`);
  const filePath = await synthesizeSpeech(text);
  try {
    if (session.recorder) {
      await session.recorder.addTtsSegment(filePath);
    }
    await playFile(session.player, filePath);
    if (session.recorder) {
      session.recorder.resumeUserCapture();
    }
  } finally {
    deleteTempFile(filePath);
  }
}

async function postAnswerControlPanel(client, session) {
  session.waitingForContinue = true;

  await updateInterviewStatusMessage(client, session, {
    description: formatAnswerPanelDescription(session),
    statusNote: `**Question ${session.questionIndex + 1}:** ${QUESTIONS[session.questionIndex]}`,
    micWarning: session.lastAnswerHadVoice === false,
    actionRows: buildAnswerControlRows(session.guildId),
  });
}

async function runQuestion(client, session) {
  if (session.cancelled) return;

  const questionNumber = session.questionIndex + 1;
  const question = QUESTIONS[session.questionIndex];
  const spoken = `Question ${questionNumber}. ${question}`;

  session.waitingForContinue = false;
  session.waitingForSpeech = true;

  await updateInterviewStatusMessage(client, session, {
    description:
      `<@${session.intervieweeId}> Answer in voice. **Continue** appears after you stop talking for **5 seconds**.`,
    statusNote: `**Question ${questionNumber}:** ${question}`,
    actionRows: [],
  }).catch(() => null);

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

  const answerResult = await waitForInterviewAnswer(session, {
    timeoutMs: 180_000,
    silenceAfterMs: ANSWER_SILENCE_MS,
  });

  if (session.cancelled) return;

  session.waitingForSpeech = false;
  session.lastAnswerHadVoice = answerResult.spoke;

  await postAnswerControlPanel(client, session);
}

async function waitForInterviewAnswer(session, { timeoutMs = 90_000, silenceAfterMs = 0 } = {}) {
  let result = await waitForUserToFinishSpeaking(session.connection, session.intervieweeId, {
    timeoutMs,
    silenceAfterMs,
  });

  if (!result.spoke) {
    try {
      await speakText(session, MIC_WARNING_TEXT);
    } catch (error) {
      console.warn("[interview] Mic warning TTS failed:", error.message);
    }

    result = await waitForUserToFinishSpeaking(session.connection, session.intervieweeId, {
      timeoutMs: Math.min(timeoutMs, 60_000),
      silenceAfterMs,
    });
  }

  return result;
}

async function submitInterviewApplication(client, session, recordingPath) {
  const guild = await client.guilds.fetch(session.guildId).catch(() => null);
  const member = await guild?.members.fetch(session.intervieweeId).catch(() => null);
  const user = member?.user ?? (await client.users.fetch(session.intervieweeId).catch(() => null));
  const submittedAt = Date.now();
  const appId = `${session.intervieweeId}-${submittedAt}`;
  const roleplayName =
    session.roleplayName ?? (member ? getRoleplayNameFromMember(member) : null);
  const recordingAttachment = buildRecordingAttachment(recordingPath, {
    userTag: user?.tag ?? session.intervieweeId,
  });

  const application = {
    appId,
    userId: session.intervieweeId,
    userTag: user?.tag ?? session.intervieweeId,
    guildId: session.guildId,
    roleplayName,
    roleplayNameRaw: session.roleplayNameRaw,
    durationMs: session.startedAt ? submittedAt - session.startedAt : 0,
    submittedAt,
    status: "pending",
    voiceChannelName: session.voiceChannelName,
    hasRecording: Boolean(recordingAttachment),
    notes: session.notes ?? [],
    discontinuedEarly: Boolean(session.discontinuedEarly),
    discontinueReason: session.discontinueReason ?? "",
  };

  persistApplication(application);

  const submissionsChannel = await resolveSubmissionsChannel(client, session.guildId);
  if (!submissionsChannel) {
    throw new Error(
      `The interview submissions channel could not be found (ID: ${getSubmissionsChannelId()}).`,
    );
  }

  let submissionMessage;
  try {
    submissionMessage = await sendSubmissionPanel(submissionsChannel, application, appId);
  } catch (error) {
    console.error("[interview] Submission panel send failed:", error.message, error.code ?? "");
    submissionMessage = await sendSubmissionPanel(submissionsChannel, application, appId, {
      skipStaffPing: true,
    });
  }

  application.messageId = submissionMessage.id;
  application.channelId = submissionsChannel.id;
  persistApplication(application);

  if (recordingAttachment) {
    try {
      const recordingMessage = await submissionsChannel.send({
        content:
          `<@${application.userId}> **Voice interview recording** (${formatDuration(application.durationMs)})`,
        files: [recordingAttachment],
        reply: { messageReference: submissionMessage.id, failIfNotExists: false },
      });
      application.recordingMessageId = recordingMessage.id;
      application.hasRecording = true;
      persistApplication(application);
    } catch (error) {
      console.error("[interview] Recording attachment send failed:", error.message, error.code ?? "");
      application.hasRecording = false;
      persistApplication(application);
      await submissionMessage
        .edit(
          buildSubmissionPayload(application, {
            forEdit: true,
            actionRows: [buildReviewButtons(appId)],
          }),
        )
        .catch(() => null);
    }
  }

  if (recordingPath) {
    deleteTempFile(recordingPath);
  }

  return application;
}

function buildRetakeSubmissionPayload(application, questionIndex, retakeRequest, { forEdit = false } = {}) {
  const question = QUESTIONS[questionIndex];
  const builder = forEdit ? buildV2EditPayload : buildV2Payload;

  return builder({
    withTicketBanner: true,
    title: "Voice Interview — Re-Answer Submitted",
    description:
      `<@&${STAFF_PING_ROLE_ID}>\n\n` +
      `Re-answer from <@${application.userId}> (\`${application.userTag}\`)`,
    fields: [
      { name: "Question", value: truncateField(`**${questionIndex + 1}.** ${question}`) },
      { name: "Requested By", value: retakeRequest.requestedByTag ?? "Staff" },
      {
        name: "Recording",
        value: retakeRequest.hasRecording
          ? "Attached below — includes the spoken question and the applicant's re-answer."
          : "No audio captured for this re-answer.",
      },
    ],
    actionRows: application.status === "pending" ? [buildReviewButtons(application.appId)] : [],
    allowedMentions: { roles: [STAFF_PING_ROLE_ID] },
  });
}

async function submitRetakeRecording(client, application, questionIndex, recordingPath, retakeRequest) {
  const channel = await client.channels.fetch(application.channelId).catch(() => null);
  if (!channel?.isTextBased()) {
    throw new Error("The interview submissions channel could not be found.");
  }

  const recordingAttachment = buildRecordingAttachment(recordingPath, application, {
    retakeQuestionIndex: questionIndex,
  });

  retakeRequest.hasRecording = Boolean(recordingAttachment);
  retakeRequest.status = "completed";
  retakeRequest.completedAt = Date.now();
  persistApplication(application);

  const submissionMessage = await channel.send({
    ...buildRetakeSubmissionPayload(application, questionIndex, retakeRequest),
    reply: { messageReference: application.messageId, failIfNotExists: false },
  });

  retakeRequest.retakeMessageId = submissionMessage.id;
  persistApplication(application);

  if (recordingAttachment) {
    try {
      const recordingMessage = await channel.send({
        content: `Re-answer recording for question ${questionIndex + 1}`,
        files: [recordingAttachment],
        reply: { messageReference: submissionMessage.id, failIfNotExists: false },
      });
      retakeRequest.recordingMessageId = recordingMessage.id;
      retakeRequest.hasRecording = true;
      persistApplication(application);
    } catch (error) {
      console.error("[interview] Retake recording send failed:", error.message, error.code ?? "");
      retakeRequest.hasRecording = false;
      persistApplication(application);
    }
  }

  if (recordingPath) {
    deleteTempFile(recordingPath);
  }

  await refreshInterviewSubmissionMessage(client, application);
  return submissionMessage;
}

async function runRetakeAnswer(client, application, questionIndex, retakeRequest) {
  const guild = await client.guilds.fetch(application.guildId).catch(() => null);
  if (!guild) {
    throw new Error("Could not find the server for this interview.");
  }

  const member = await guild.members.fetch(application.userId).catch(() => null);
  if (!member) {
    throw new Error("You must still be in the server to re-answer this question.");
  }

  if (getSession(guild.id)) {
    throw new Error("An interview is already running in this server. Try again when it finishes.");
  }

  let interviewChannel;
  try {
    interviewChannel = await createInterviewVoiceChannel(guild, member);
    await moveMemberToInterviewChannel(member, interviewChannel);
  } catch (error) {
    if (interviewChannel) {
      await deleteInterviewVoiceChannel(guild, interviewChannel.id);
    }
    throw error;
  }

  let voiceSession;
  try {
    voiceSession = await joinVoiceChannelById(guild, interviewChannel.id);
  } catch (error) {
    await deleteInterviewVoiceChannel(guild, interviewChannel.id);
    throw error;
  }

  const recorder = new VoiceInterviewRecorder(voiceSession.connection, member.id);
  const voiceSessionState = {
    connection: voiceSession.connection,
    player: voiceSession.player,
    intervieweeId: member.id,
    recorder,
  };
  let recordingPath = null;

  try {
    recorder.startSession();
    const questionNumber = questionIndex + 1;
    const question = QUESTIONS[questionIndex];
    await speakText(voiceSessionState, `Question ${questionNumber}. ${question}`);
    await waitForInterviewAnswer(voiceSessionState, { timeoutMs: 90_000 });
    recordingPath = await recorder.stop();
  } catch (error) {
    await recorder.stop().catch(() => null);
    throw error;
  } finally {
    await destroyVoiceSession(voiceSession.connection, voiceSession.player);
    await deleteInterviewVoiceChannel(guild, interviewChannel.id);
  }

  await submitRetakeRecording(client, application, questionIndex, recordingPath, retakeRequest);
}

async function refreshInterviewSubmissionMessage(client, application) {
  const channel = await client.channels.fetch(application.channelId).catch(() => null);
  const message = await channel?.messages.fetch(application.messageId).catch(() => null);
  if (!message) return;

  await message.edit(
    buildSubmissionPayload(application, {
      forEdit: true,
      actionRows: application.status === "pending" ? [buildReviewButtons(application.appId)] : [],
    }),
  );
}

async function handleInterviewAskAgain(interaction, appId) {
  const application = getApplication(appId);

  if (!application || application.status !== "pending") {
    await interaction.reply({ content: "This interview submission is no longer pending.", ephemeral: true });
    return true;
  }

  if (!canReviewInterview(interaction.member)) {
    await interaction.reply({
      content: "You need **Manage Roles** or **Manage Server** to request a re-answer.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.reply({
    ...buildV2Payload({
      title: "Ask Again",
      description: "Select which question the applicant should re-answer in voice.",
      actionRows: [new ActionRowBuilder().addComponents(buildAskAgainSelect(appId))],
      ephemeral: true,
      includeFiles: false,
    }),
  });

  return true;
}

async function handleInterviewAskAgainSelect(interaction, appId) {
  const application = getApplication(appId);

  if (!application || application.status !== "pending") {
    await interaction.reply({ content: "This interview submission is no longer pending.", ephemeral: true });
    return true;
  }

  if (!canReviewInterview(interaction.member)) {
    await interaction.reply({
      content: "You need **Manage Roles** or **Manage Server** to request a re-answer.",
      ephemeral: true,
    });
    return true;
  }

  const questionIndex = Number.parseInt(interaction.values[0], 10);
  if (!Number.isFinite(questionIndex) || questionIndex < 0 || questionIndex >= QUESTIONS.length) {
    await interaction.reply({ content: "Invalid question selected.", ephemeral: true });
    return true;
  }

  if (!application.retakeRequests) application.retakeRequests = [];

  const existingPending = application.retakeRequests.find(
    (entry) => entry.questionIndex === questionIndex && entry.status === "pending",
  );
  if (existingPending) {
    await interaction.update({
      ...buildV2EditPayload({
        title: "Ask Again",
        description: `Question **${questionIndex + 1}** already has a pending re-answer request.`,
        includeFiles: false,
      }),
      components: [],
    });
    return true;
  }

  const retakeRequest = {
    questionIndex,
    requestedById: interaction.user.id,
    requestedByTag: interaction.user.tag,
    requestedAt: Date.now(),
    status: "pending",
  };

  application.retakeRequests.push(retakeRequest);
  persistApplication(application);

  const applicant = await interaction.client.users.fetch(application.userId).catch(() => null);
  const question = QUESTIONS[questionIndex];

  if (applicant) {
    await applicant
      .send(
        buildV2Payload({
          withTicketBanner: true,
          title: "Voice Interview — Re-Answer Required",
          description:
            `Staff requested that you re-answer **Question ${questionIndex + 1}** in voice:\n\n` +
            `> ${question}\n\n` +
            `When you're ready, click **Ready to Re-Answer** below. We'll move you to a private voice channel, repeat the question, and send your new answer to staff.`,
          actionRows: [buildRetakeReadyButton(appId, questionIndex)],
        }),
      )
      .catch(() => null);
  }

  await refreshInterviewSubmissionMessage(interaction.client, application);

  await interaction.update({
    ...buildV2EditPayload({
      title: "Ask Again",
      description:
        `Requested a re-answer for **Question ${questionIndex + 1}**.\n` +
        (applicant
          ? `<@${application.userId}> was DMed with a **Ready to Re-Answer** button.`
          : `Could not DM <@${application.userId}> — ask them to enable DMs and click **Ready to Re-Answer** when sent.`),
      includeFiles: false,
    }),
    components: [],
  });

  return true;
}

async function handleInterviewRetakeReady(interaction) {
  const payload = interaction.customId.slice(RETAKE_READY_PREFIX.length);
  const separatorIndex = payload.lastIndexOf(":");
  if (separatorIndex <= 0) return false;

  const appId = payload.slice(0, separatorIndex);
  const questionIndex = Number.parseInt(payload.slice(separatorIndex + 1), 10);

  if (!Number.isFinite(questionIndex)) {
    await interaction.reply({ content: "Invalid re-answer request.", ephemeral: true });
    return true;
  }

  const application = getApplication(appId);
  if (!application || application.status !== "pending") {
    await interaction.reply({ content: "This interview submission is no longer pending.", ephemeral: true });
    return true;
  }

  if (interaction.user.id !== application.userId) {
    await interaction.reply({ content: "This re-answer request is not for you.", ephemeral: true });
    return true;
  }

  const retakeRequest = application.retakeRequests?.find(
    (entry) => entry.questionIndex === questionIndex && entry.status === "pending",
  );
  if (!retakeRequest) {
    await interaction.reply({ content: "This re-answer request is no longer active.", ephemeral: true });
    return true;
  }

  if (retakeInProgress.has(interaction.user.id)) {
    await interaction.reply({
      content: "You're already completing a re-answer. Finish that first.",
      ephemeral: true,
    });
    return true;
  }

  if (hasProcessed(`interview-retake:${interaction.id}`)) return true;
  markProcessed(`interview-retake:${interaction.id}`);

  await interaction.deferUpdate();

  retakeInProgress.add(interaction.user.id);

  try {
    await interaction.message
      .edit(
        buildV2EditPayload({
          withTicketBanner: true,
          title: "Voice Interview — Re-Answer In Progress",
          description:
            `Re-answering **Question ${questionIndex + 1}** now.\n\n` +
            `Join the private voice channel when prompted and answer clearly.`,
          includeFiles: false,
        }),
      )
      .catch(() => null);

    await runRetakeAnswer(interaction.client, application, questionIndex, retakeRequest);

    await interaction.message
      .edit(
        buildV2EditPayload({
          withTicketBanner: true,
          title: "Voice Interview — Re-Answer Submitted",
          description:
            `Your re-answer for **Question ${questionIndex + 1}** was submitted to staff.\n\n` +
            `You will be notified when your interview is reviewed.`,
          includeFiles: false,
        }),
      )
      .catch(() => null);
  } catch (error) {
    console.error("[interview] Retake failed:", error);
    await interaction.message
      .edit(
        buildV2EditPayload({
          withTicketBanner: true,
          title: "Voice Interview — Re-Answer Failed",
          description: `${error.message ?? "Could not complete the re-answer."}\n\nClick **Ready to Re-Answer** to try again.`,
          actionRows: [buildRetakeReadyButton(appId, questionIndex)],
          includeFiles: false,
        }),
      )
      .catch(() => null);
  } finally {
    retakeInProgress.delete(interaction.user.id);
  }

  return true;
}

async function finishInterview(client, session) {
  let recordingPath = null;

  if (session.recorder) {
    try {
      recordingPath = await session.recorder.stop();
    } catch (error) {
      console.error("[interview] Recording stop failed:", error);
    }
  }

  const closingLine =
    "Thank you for submitting your voice interview. You will be DMed a response soon.";

  try {
    await speakText(session, closingLine);
  } catch (error) {
    console.error("[interview] Closing TTS failed:", error);
  }

  const applicant = await client.users.fetch(session.intervieweeId).catch(() => null);
  if (applicant) {
    await applicant.send({ content: closingLine }).catch(() => null);
  }

  let submissionFailed = false;
  let submissionHasRecording = false;

  try {
    const application = await submitInterviewApplication(client, session, recordingPath);
    submissionHasRecording = Boolean(application.hasRecording);
  } catch (error) {
    console.error("[interview] Submission failed:", error.message, error.code ?? "", error.stack);
    submissionFailed = true;
  }

  let statusNote = "Staff will review your recording shortly.";
  if (submissionFailed) {
    statusNote =
      "Staff could not be notified automatically. Contact an administrator and mention your interview time.";
  } else if (!submissionHasRecording) {
    statusNote =
      "Your submission was sent to staff, but no voice recording was captured. Contact staff if needed.";
  }

  await updateInterviewStatusMessage(client, session, {
    title: submissionFailed ? "Voice Interview — Submission Issue" : "Voice Interview — Submitted",
    description: `<@${session.intervieweeId}> ${closingLine}`,
    statusNote,
    actionRows: [],
  }).catch(() => null);

  await endInterview(client, session.guildId, { silent: true });
}

async function endInterview(client, guildId, { reason, silent = false } = {}) {
  const session = sessions.get(guildId);
  if (!session) return;

  session.cancelled = true;
  sessions.delete(guildId);

  if (session.recorder) {
    await session.recorder.stop().catch(() => null);
  }

  await destroyVoiceSession(session.connection, session.player);

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (guild && session.createdInterviewChannel) {
    await deleteInterviewVoiceChannel(guild, session.voiceChannelId);
  }

  if (session.statusMessageId) {
    if (!silent && reason) {
      await updateInterviewStatusMessage(client, session, {
        title: "Voice Interview — Ended",
        description: reason,
        actionRows: [],
      }).catch(() => null);
    } else if (!silent) {
      await updateInterviewStatusMessage(client, session, { actionRows: [] }).catch(() => null);
    }
  }
}

async function runInterviewLoop(client, session) {
  try {
    session.recorder.startSession();
    session.startedAt = Date.now();

    await speakText(
      session,
      "This voice interview is being recorded for staff review. Please answer each question clearly when prompted.",
    );

    if (session.cancelled) return;

    await runQuestion(client, session);
  } catch (error) {
    console.error("[interview] Loop failed:", error);
    await endInterview(client, session.guildId, {
      reason: `The interview stopped: ${error.message ?? "unknown error"}`,
    });
  }
}

async function resolveInterviewee(message, hostMember) {
  const mentioned = message.mentions.users.first();

  if (mentioned) {
    if (!canInterviewOthers(hostMember)) {
      return {
        error: "You need staff permissions to start an interview for someone else.",
      };
    }

    const member = await message.guild.members.fetch(mentioned.id).catch(() => null);
    if (!member) {
      return { error: "That member is not in this server." };
    }

    return { interviewee: member };
  }

  return { interviewee: hostMember };
}

async function startInterview(
  client,
  { guild, textChannel, hostMember, interviewee, roleplayName, roleplayNameRaw, interaction },
) {
  if (getSession(guild.id)) {
    throw new Error("An interview is already running in this server.");
  }

  if (!roleplayName) {
    throw new Error("A roleplay name is required before starting the interview.");
  }

  await assertIntervieweeCanStart(guild, interviewee, { checkQueueVoice: true });

  const bootstrapSession = {
    intervieweeId: interviewee.id,
    questionIndex: 0,
    notes: [],
    roleplayName,
    roleplayNameRaw,
  };

  const statusMessage = await publishInterviewStatusMessage(
    interaction,
    textChannel,
    bootstrapSession,
    {
      description: `Creating a private interview voice channel for <@${interviewee.id}>…`,
      statusNote: "Please wait…",
    },
  );

  let interviewChannel;
  try {
    interviewChannel = await createInterviewVoiceChannel(guild, interviewee);
    await moveMemberToInterviewChannel(interviewee, interviewChannel);
  } catch (error) {
    if (interviewChannel) {
      await deleteInterviewVoiceChannel(guild, interviewChannel.id);
    }
    await editInterviewPanel(
      client,
      bootstrapSession,
      {
        title: "Voice Interview — Failed",
        description: error.message ?? "Could not create the interview voice channel.",
        statusNote: "Try again or contact staff.",
      },
      interaction,
    );
    throw error;
  }

  let voiceSession;
  try {
    voiceSession = await joinVoiceChannelById(guild, interviewChannel.id);
  } catch (error) {
    await deleteInterviewVoiceChannel(guild, interviewChannel.id);
    await editInterviewPanel(
      client,
      { ...bootstrapSession, voiceChannelName: interviewChannel.name },
      {
        title: "Voice Interview — Failed",
        description: error.message ?? "Could not join the interview voice channel.",
        statusNote: "Try again or contact staff.",
      },
      interaction,
    );
    throw new Error(error.message ?? "Could not join the interview voice channel.");
  }

  const statusEphemeral = shouldUseEphemeralInterviewPanel(interaction, interviewee.id);
  const session = {
    guildId: guild.id,
    textChannelId: textChannel.id,
    statusMessage,
    statusMessageId: statusMessage.id,
    statusInteraction: statusEphemeral ? interaction : null,
    statusEphemeral,
    voiceChannelId: interviewChannel.id,
    voiceChannelName: interviewChannel.name,
    createdInterviewChannel: true,
    intervieweeId: interviewee.id,
    startedById: hostMember.id,
    roleplayName,
    roleplayNameRaw,
    questionIndex: 0,
    waitingForSpeech: false,
    waitingForContinue: false,
    cancelled: false,
    lastAnswerHadVoice: true,
    connection: voiceSession.connection,
    player: voiceSession.player,
    recorder: new VoiceInterviewRecorder(voiceSession.connection, interviewee.id),
    startedAt: Date.now(),
    notes: [],
    discontinuedEarly: false,
    discontinueReason: "",
  };

  sessions.set(guild.id, session);

  await updateInterviewStatusMessage(client, session, {
    description:
      `<@${session.intervieweeId}> Your voice interview is in progress in ${interviewChannel}.\n\n` +
      `Roster name: **${roleplayName}**` +
      (roleplayNameRaw ? ` *(from ${roleplayNameRaw})*` : "") +
      `\nOnly you can join that channel. This session **is being recorded**.\n` +
      `Answer each question in voice, then use the panel on this message when you're ready.`,
    statusNote: "Starting interview…",
  });

  runInterviewLoop(client, session).catch(async (error) => {
    console.error("[interview] Loop failed:", error);
    await endInterview(client, session.guildId, {
      reason: `The interview stopped: ${error.message ?? "unknown error"}`,
    });
  });
}

async function handleInterviewAccept(interaction, appId) {
  const application = getApplication(appId);

  if (!application || application.status !== "pending") {
    await interaction.reply({ content: "This interview submission is no longer pending.", ephemeral: true });
    return true;
  }

  if (!canReviewInterview(interaction.member)) {
    await interaction.reply({
      content: "You need **Manage Roles** or **Manage Server** to review interviews.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.reply({
    content: "Select a rank to assign to this applicant:",
    components: [buildRankSelect(appId)],
    ephemeral: true,
  });

  return true;
}

async function handleInterviewRankSelect(interaction, appId) {
  const application = getApplication(appId);
    const rankValue = interaction.values[0];
    const rank = RANKS.find((entry) => entry.id === rankValue);

    if (!application || application.status !== "pending") {
      await interaction.reply({ content: "This interview submission is no longer pending.", ephemeral: true });
      return true;
    }

    if (!canReviewInterview(interaction.member)) {
      await interaction.reply({
        content: "You need **Manage Roles** or **Manage Server** to review interviews.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferUpdate();

    const guild = await interaction.client.guilds.fetch(application.guildId).catch(() => null);
    const member = await guild?.members.fetch(application.userId).catch(() => null);
    const rankLabel = rank?.label ?? "Unknown Rank";
    const { sheetRank, discordRoleIds } = await resolveAssignmentRoleIds(guild, rankValue);

    let roleSummary = "";
    if (member && guild) {
      const roleResult = await assignRankRolesToMember(member, rankValue, "Voice interview accepted");
      if (roleResult.error) {
        roleSummary = `\nDiscord roles: assignment failed (${roleResult.error}).`;
      } else if (roleResult.added.length === 0) {
        roleSummary = "\nDiscord roles: member already had the assigned rank roles.";
      }
    }

  let rosterSummary = "";
  let rosterResult = null;
  const roleplayName = application.roleplayName ?? (member ? getRoleplayNameFromMember(member) : null);

  if (member && isSheetsConfigured() && roleplayName) {
    try {
      const setup = await completeMemberRosterSetup(member, {
        roleplayName,
        sheetRank,
        reason: "Voice interview accepted",
        dmTitle: "Congratulations! Your voice interview has been **accepted**.",
        dmExtraLines: [`Please read over <#${GUIDE_CHANNEL_ID}> before getting started.`],
        audit: {
          client: interaction.client,
          actor: interaction.member,
          trigger: "Voice interview accepted",
        },
      });

      rosterResult = setup.rosterResult;
      rosterSummary =
        `\nRoster: **${setup.rank}** — callsign **${setup.callsign}**` +
        (setup.syncResult.nicknameResult?.ok && setup.syncResult.nicknameResult.changed
          ? " (nickname updated)"
          : setup.syncResult.nicknameResult?.ok
            ? ""
            : ` (nickname not updated: ${setup.syncResult.nicknameResult?.reason ?? "unknown"})`) +
        (setup.dmSent ? "" : " (DM failed — check privacy settings)");
    } catch (error) {
      console.error("Voice interview roster assignment failed:", error);
      rosterSummary = `\nRoster assignment failed: ${error.message}`;
    }
  } else if (!roleplayName) {
    rosterSummary = "\nNo roster name found — set their nickname or add them with `/rosteradd`.";
  }

  application.status = "accepted";
  application.rankLabel = rankLabel;
  application.rankId = discordRoleIds[0] ?? rankValue;
  application.reviewerTag = interaction.user.tag;
  persistApplication(application);

  await logRosterAudit(interaction.client, application.guildId, {
    title: "Voice interview accepted",
    actor: interaction.member,
    target: member,
    roleplayName,
    rank: rankLabel,
    trigger: "Voice interview review",
    notes: rosterSummary.trim() || undefined,
  }).catch(() => null);

  const channel = await interaction.client.channels.fetch(application.channelId).catch(() => null);
  const message = await channel?.messages.fetch(application.messageId).catch(() => null);
  if (message) {
    await message.edit(buildSubmissionPayload(application, { forEdit: true }));
  }

  if (!rosterResult) {
    const applicant = await interaction.client.users.fetch(application.userId).catch(() => null);
    if (applicant) {
      let dmContent =
        `Congratulations! Your voice interview has been **accepted**.\n\n` +
        `You have been assigned the rank: **${application.rankLabel}**\n\n` +
        `Please read over <#${GUIDE_CHANNEL_ID}> before getting started.`;

      if (rosterSummary.includes("Roster assignment failed") || rosterSummary.includes("No roster name")) {
        dmContent +=
          "\n\nYour roster callsign could not be assigned automatically. Contact staff to be added to the database.";
      }

      await applicant.send({ content: dmContent }).catch(() => null);
    }
  }

  await interaction.editReply({
    content:
      `Interview accepted. **${application.userTag}** was assigned **${application.rankLabel}**.${roleSummary}${rosterSummary}`,
    components: [],
  });

  return true;
}

async function handleInterviewDenyButton(interaction, appId) {
  const application = getApplication(appId);

  if (!application || application.status !== "pending") {
    await interaction.reply({ content: "This interview submission is no longer pending.", ephemeral: true });
    return true;
  }

  if (!canReviewInterview(interaction.member)) {
    await interaction.reply({
      content: "You need **Manage Roles** or **Manage Server** to review interviews.",
      ephemeral: true,
    });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_DENY_PREFIX}${appId}`)
    .setTitle("Deny Voice Interview")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("deny_reason")
          .setLabel("Reason for denial")
          .setPlaceholder("Explain why this interview was denied...")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );

  await interaction.showModal(modal);
  return true;
}

async function handleInterviewDenyModal(interaction, appId) {
  const application = getApplication(appId);

  if (!application || application.status !== "pending") {
    await interaction.reply({ content: "This interview submission is no longer pending.", ephemeral: true });
    return true;
  }

  if (!canReviewInterview(interaction.member)) {
    await interaction.reply({
      content: "You need **Manage Roles** or **Manage Server** to review interviews.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const denyReason = interaction.fields.getTextInputValue("deny_reason");
  const cooldownEnd = setCooldown(application.userId, COOLDOWN_MS, INTERVIEW_COOLDOWN_TYPE);

  application.status = "denied";
  application.denyReason = denyReason;
  application.reviewerTag = interaction.user.tag;
  persistApplication(application);

  await logRosterAudit(interaction.client, application.guildId, {
    title: "Voice interview denied",
    actor: interaction.member,
    target: await interaction.client.users.fetch(application.userId).catch(() => null),
    roleplayName: application.roleplayName,
    trigger: "Voice interview review",
    notes: denyReason,
  }).catch(() => null);

  const channel = await interaction.client.channels.fetch(application.channelId).catch(() => null);
  const message = await channel?.messages.fetch(application.messageId).catch(() => null);
  if (message) {
    await message.edit(buildSubmissionPayload(application, { forEdit: true }));
  }

  const applicant = await interaction.client.users.fetch(application.userId).catch(() => null);
  if (applicant) {
    await applicant
      .send({
        content:
          `Your voice interview has been **denied**.\n\n` +
          `**Reason:** ${denyReason}\n\n` +
          `You may submit a new application after <t:${Math.floor(cooldownEnd / 1000)}:F> (<t:${Math.floor(cooldownEnd / 1000)}:R>).`,
      })
      .catch(() => null);
  }

  await interaction.editReply(`Interview denied. **${application.userTag}** was notified via DM.`);
  return true;
}

function canClearInterviewState(member, targetUserId) {
  if (!member) return false;
  if (member.id === targetUserId) return true;
  return canInterviewOthers(member);
}

function clearInterviewStateForUser(guildId, userId) {
  const removedAppIds = clearInterviewApplicationsForUser(userId);

  for (const appId of removedAppIds) {
    applications.delete(appId);
  }

  pendingInterviewStarts.delete(pendingInterviewKey(guildId, userId));

  const hadCooldown = clearCooldown(userId, INTERVIEW_COOLDOWN_TYPE);

  return { removedAppIds, hadCooldown };
}

async function handleInterviewClearCommand(message) {
  if (message.author.bot || !message.guild) return false;

  const content = message.content.trim();
  const lower = content.toLowerCase();
  if (lower !== INTERVIEW_CLEAR_COMMAND && !lower.startsWith(`${INTERVIEW_CLEAR_COMMAND} `)) {
    return false;
  }

  if (hasProcessed(`interview-clear:${message.id}`)) return true;
  markProcessed(`interview-clear:${message.id}`);

  const hostMember = await ensureMessageMember(message);
  if (!hostMember) {
    await message.reply("Could not resolve your server membership.");
    return true;
  }

  const mentioned = message.mentions.users.first();
  const targetUserId = mentioned?.id ?? hostMember.id;

  if (!canClearInterviewState(hostMember, targetUserId)) {
    await message.reply(
      "You can clear your own interview state, or mention a member if you have staff permissions.",
    );
    return true;
  }

  const result = clearInterviewStateForUser(message.guild.id, targetUserId);
  const targetLabel = mentioned ? `<@${targetUserId}>` : "your";

  await message.reply(
    `Cleared ${targetLabel} voice interview test state: **${result.removedAppIds.length}** saved application(s)` +
      (result.hadCooldown ? ", interview cooldown removed" : "") +
      ". You can start a new interview if no session is currently running in this server.",
  );

  return true;
}

async function handleInterviewClearSlashCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "clearinterview") {
    return false;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return true;
  }

  const hostMember =
    interaction.member ?? (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));

  if (!hostMember) {
    await interaction.reply({ content: "Could not resolve your server membership.", ephemeral: true });
    return true;
  }

  const targetUser = interaction.options.getUser("member");
  const targetUserId = targetUser?.id ?? hostMember.id;

  if (!canClearInterviewState(hostMember, targetUserId)) {
    await interaction.reply({
      content:
        "You can clear your own interview state, or specify a member if you have staff permissions.",
      ephemeral: true,
    });
    return true;
  }

  const result = clearInterviewStateForUser(interaction.guild.id, targetUserId);
  const targetLabel = targetUser ? `<@${targetUserId}>` : "your";

  await interaction.reply({
    content:
      `Cleared ${targetLabel} voice interview test state: **${result.removedAppIds.length}** saved application(s)` +
      (result.hadCooldown ? ", interview cooldown removed" : "") +
      ". You can start a new interview if no session is currently running in this server.",
    ephemeral: true,
  });

  return true;
}

async function handleInterviewCommand(message) {
  if (message.author.bot || !message.guild) return false;

  const content = message.content.trim();
  if (content.toLowerCase() !== INTERVIEW_COMMAND && !content.toLowerCase().startsWith(`${INTERVIEW_COMMAND} `)) {
    return false;
  }

  if (hasProcessed(`interview-cmd:${message.id}`)) return true;
  markProcessed(`interview-cmd:${message.id}`);

  try {
    const hostMember = await ensureMessageMember(message);
    if (!hostMember) {
      await message.reply("Could not resolve your server membership. Try again in a moment.");
      return true;
    }

    const resolved = await resolveInterviewee(message, hostMember);
    if (resolved.error) {
      await message.reply(resolved.error);
      return true;
    }

    await promptInterviewRoleplayName(message.client, {
      guild: message.guild,
      textChannel: message.channel,
      hostMember,
      interviewee: resolved.interviewee,
    });
  } catch (error) {
    console.error("[interview] Start failed:", error);
    await message.reply(error.message ?? "Could not start the interview.").catch(() => null);
  }

  return true;
}

function buildInterviewCommand() {
  return new SlashCommandBuilder()
    .setName("interview")
    .setDescription(
      "Start a voice interview — join the waiting VC, enter roleplay name, then private VC",
    )
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Optional: staff can interview another member")
        .setRequired(false),
    );
}

function buildInterviewClearCommand() {
  return new SlashCommandBuilder()
    .setName("clearinterview")
    .setDescription("Clear saved voice interview applications and cooldown for testing")
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Optional: staff can clear another member's interview state")
        .setRequired(false),
    );
}

async function handleInterviewSlashCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "interview") {
    return false;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return true;
  }

  try {
    const hostMember =
      interaction.member ??
      (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));

    if (!hostMember) {
      await interaction.reply({ content: "Could not resolve your server membership.", ephemeral: true });
      return true;
    }

    const targetUser = interaction.options.getUser("member");
    const fakeMessage = {
      guild: interaction.guild,
      mentions: { users: { first: () => targetUser ?? null } },
    };

    const resolved = await resolveInterviewee(fakeMessage, hostMember);
    if (resolved.error) {
      await interaction.reply({ content: resolved.error, ephemeral: true });
      return true;
    }

    await promptInterviewRoleplayName(interaction.client, {
      guild: interaction.guild,
      textChannel: interaction.channel,
      hostMember,
      interviewee: resolved.interviewee,
      interaction,
    });
  } catch (error) {
    console.error("[interview] Slash start failed:", error);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(error.message ?? "Could not start the interview.").catch(() => null);
    } else {
      await interaction.reply({
        content: error.message ?? "Could not start the interview.",
        ephemeral: true,
      });
    }
  }

  return true;
}

async function advanceInterviewAfterContinue(client, session, interaction) {
  session.questionIndex += 1;
  session.waitingForContinue = false;

  if (session.questionIndex >= QUESTIONS.length) {
    await editInterviewPanel(
      client,
      session,
      {
        description: `<@${session.intervieweeId}> Wrapping up your interview…`,
        statusNote: "Submitting your recording to staff.",
        actionRows: [],
      },
      interaction,
    );
    await finishInterview(client, session);
    return;
  }

  await editInterviewPanel(
    client,
    session,
    {
      description: `<@${session.intervieweeId}> Moving to the next question…`,
      statusNote: "Listen in voice for the next question.",
      actionRows: [],
    },
    interaction,
  );

  runQuestion(client, session).catch(async (error) => {
    console.error("[interview] Question loop failed:", error);
    await endInterview(client, session.guildId, {
      reason: "The interview stopped because of an error. Please try again.",
    });
  });
}

async function handleInterviewContinue(interaction, guildId) {
  const session = getSession(guildId);

  if (!session || !session.waitingForContinue) {
    await interaction.reply({ content: "This interview panel is no longer active.", ephemeral: true });
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

  if (session.recorder) {
    session.lastAnswerHadVoice = await session.recorder.flushAndMeasureUserAudio();
  }

  await interaction.deferUpdate();
  await advanceInterviewAfterContinue(interaction.client, session, interaction);
  return true;
}

async function handleInterviewAddNoteButton(interaction, guildId) {
  const session = getSession(guildId);

  if (!session || !session.waitingForContinue) {
    await interaction.reply({ content: "This interview panel is no longer active.", ephemeral: true });
    return true;
  }

  if (!canControlInterviewPanel(interaction.member, session)) {
    await interaction.reply({ content: "You cannot add notes to this interview.", ephemeral: true });
    return true;
  }

  const questionNumber = session.questionIndex + 1;
  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_NOTE_PREFIX}${guildId}`)
    .setTitle(`Add Note — Question ${questionNumber}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("note_text")
          .setLabel("Note for this answer")
          .setPlaceholder("Anything you forgot to say in voice, or staff observations...")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );

  await interaction.showModal(modal);
  return true;
}

async function handleInterviewNoteModal(interaction, guildId) {
  const session = getSession(guildId);

  if (!session || !session.waitingForContinue) {
    await interaction.reply({ content: "This interview panel is no longer active.", ephemeral: true });
    return true;
  }

  if (!canControlInterviewPanel(interaction.member, session)) {
    await interaction.reply({ content: "You cannot add notes to this interview.", ephemeral: true });
    return true;
  }

  const noteText = interaction.fields.getTextInputValue("note_text").trim();
  if (!noteText) {
    await interaction.reply({ content: "Note cannot be empty.", ephemeral: true });
    return true;
  }

  if (!session.notes) session.notes = [];

  session.notes.push({
    questionIndex: session.questionIndex,
    question: QUESTIONS[session.questionIndex],
    note: noteText,
    authorId: interaction.user.id,
    authorTag: interaction.user.tag,
    addedAt: Date.now(),
  });

  await interaction.reply({ content: "Note saved. You can keep going or click **Continue**.", ephemeral: true });
  await updateInterviewStatusMessage(interaction.client, session, {
    description: formatAnswerPanelDescription(session),
    statusNote: `**Question ${session.questionIndex + 1}:** ${QUESTIONS[session.questionIndex]}`,
    micWarning: session.lastAnswerHadVoice === false,
    actionRows: buildAnswerControlRows(session.guildId),
  });
  return true;
}

async function handleInterviewRepeat(interaction, guildId) {
  const session = getSession(guildId);

  if (!session || !session.waitingForContinue) {
    await interaction.reply({ content: "This interview panel is no longer active.", ephemeral: true });
    return true;
  }

  if (interaction.user.id !== session.intervieweeId) {
    await interaction.reply({
      content: "Only the person being interviewed can repeat the question.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const questionNumber = session.questionIndex + 1;
  const question = QUESTIONS[session.questionIndex];

  try {
    await speakText(session, `Question ${questionNumber}. ${question}`);
    await interaction.editReply("Question repeated in voice.");
  } catch (error) {
    await interaction.editReply(`Could not repeat the question: ${error.message}`);
  }

  return true;
}

async function handleInterviewDiscontinueButton(interaction, guildId) {
  const session = getSession(guildId);

  if (!session || !session.waitingForContinue) {
    await interaction.reply({ content: "This interview panel is no longer active.", ephemeral: true });
    return true;
  }

  if (!canControlInterviewPanel(interaction.member, session)) {
    await interaction.reply({ content: "You cannot discontinue this interview.", ephemeral: true });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`${MODAL_DISCONTINUE_PREFIX}${guildId}`)
    .setTitle("Discontinue Interview")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("discontinue_reason")
          .setLabel("Reason (optional)")
          .setPlaceholder("Why is the interview ending early?")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500),
      ),
    );

  await interaction.showModal(modal);
  return true;
}

async function handleInterviewDiscontinueModal(interaction, guildId) {
  const session = getSession(guildId);

  if (!session) {
    await interaction.reply({ content: "This interview is no longer active.", ephemeral: true });
    return true;
  }

  if (!canControlInterviewPanel(interaction.member, session)) {
    await interaction.reply({ content: "You cannot discontinue this interview.", ephemeral: true });
    return true;
  }

  session.discontinuedEarly = true;
  session.discontinueReason =
    interaction.fields.getTextInputValue("discontinue_reason").trim() ||
    "Interview discontinued before all questions were completed.";
  session.waitingForContinue = false;

  await interaction.deferUpdate();
  await editInterviewPanel(
    interaction.client,
    session,
    {
      description: `<@${session.intervieweeId}> Interview ending early…`,
      statusNote: session.discontinueReason,
      actionRows: [],
    },
    interaction,
  );
  await finishInterview(interaction.client, session);
  return true;
}

async function handleInterviewStartButton(interaction) {
  const payload = interaction.customId.slice(INTERVIEW_START_PREFIX.length);
  const separatorIndex = payload.indexOf(":");
  if (separatorIndex <= 0) return false;

  const guildId = payload.slice(0, separatorIndex);
  const intervieweeId = payload.slice(separatorIndex + 1);

  if (interaction.user.id !== intervieweeId) {
    await interaction.reply({
      content: "Only the person being interviewed can enter their roleplay name.",
      ephemeral: true,
    });
    return true;
  }

  const pending = getPendingInterviewStart(guildId, intervieweeId);
  if (!pending) {
    await interaction.reply({
      content: "This interview prompt expired. Run `-interview` or `/interview` again.",
      ephemeral: true,
    });
    return true;
  }

  const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
  const interviewee = await guild?.members.fetch(intervieweeId).catch(() => null);
  if (!guild || !interviewee) {
    await interaction.reply({ content: "Could not verify your membership. Try again.", ephemeral: true });
    return true;
  }

  try {
    await assertIntervieweeCanStart(guild, interviewee, { checkQueueVoice: true });
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
    return true;
  }

  await interaction.showModal(buildRoleplayNameModal(guildId, intervieweeId));
  return true;
}

async function handleInterviewRoleplayModal(interaction) {
  const payload = interaction.customId.slice(MODAL_ROLEPLAY_PREFIX.length);
  const separatorIndex = payload.indexOf(":");
  if (separatorIndex <= 0) return false;

  const guildId = payload.slice(0, separatorIndex);
  const intervieweeId = payload.slice(separatorIndex + 1);

  if (interaction.user.id !== intervieweeId) {
    await interaction.reply({ content: "This form is not for you.", ephemeral: true });
    return true;
  }

  const pending = getPendingInterviewStart(guildId, intervieweeId);
  if (!pending) {
    await interaction.reply({
      content: "This interview prompt expired. Run `-interview` or `/interview` again.",
      ephemeral: true,
    });
    return true;
  }

  let roleplayName;
  let roleplayNameRaw;
  try {
    roleplayNameRaw = interaction.fields.getTextInputValue("roleplay_name").trim();
    roleplayName = formatRoleplayInitials(roleplayNameRaw);
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = await interaction.client.guilds.fetch(guildId).catch(() => null);
  const textChannel = await interaction.client.channels.fetch(pending.textChannelId).catch(() => null);
  const hostMember = await guild?.members.fetch(pending.hostMemberId).catch(() => null);
  const interviewee = await guild?.members.fetch(intervieweeId).catch(() => null);

  if (!guild || !textChannel?.isTextBased() || !hostMember || !interviewee) {
    await interaction.editReply("Could not start the interview. Try again.");
    return true;
  }

  pendingInterviewStarts.delete(pendingInterviewKey(guildId, intervieweeId));

  try {
    await startInterview(interaction.client, {
      guild,
      textChannel,
      hostMember,
      interviewee,
      roleplayName,
      roleplayNameRaw,
      interaction,
    });
  } catch (error) {
    console.error("[interview] Start after roleplay modal failed:", error);
    await replyInterviewFailure(
      interaction,
      error.message ?? "Could not start the interview.",
    );
  }

  return true;
}

async function handleInterviewInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === INTERVIEW_DASHBOARD_BUTTON_ID) {
    if (!interaction.guild) {
      await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
      return true;
    }

    const member = interaction.member;
    if (!member) {
      await interaction.reply({ content: "Could not resolve your server membership.", ephemeral: true });
      return true;
    }

    try {
      await promptInterviewRoleplayName(interaction.client, {
        guild: interaction.guild,
        textChannel: interaction.channel,
        hostMember: member,
        interviewee: member,
        interaction,
      });
    } catch (error) {
      await interaction.reply({
        content: error.message ?? "Could not start the interview.",
        ephemeral: true,
      }).catch(() => null);
    }

    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_ROLEPLAY_PREFIX)) {
    return handleInterviewRoleplayModal(interaction);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_DISCONTINUE_PREFIX)) {
    const guildId = interaction.customId.slice(MODAL_DISCONTINUE_PREFIX.length);
    return handleInterviewDiscontinueModal(interaction, guildId);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_NOTE_PREFIX)) {
    const guildId = interaction.customId.slice(MODAL_NOTE_PREFIX.length);
    return handleInterviewNoteModal(interaction, guildId);
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_DENY_PREFIX)) {
    const appId = interaction.customId.slice(MODAL_DENY_PREFIX.length);
    return handleInterviewDenyModal(interaction, appId);
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith(RANK_SELECT_PREFIX)) {
    const appId = interaction.customId.slice(RANK_SELECT_PREFIX.length);
    return handleInterviewRankSelect(interaction, appId);
  }

  if (interaction.isButton() && interaction.customId.startsWith(ACCEPT_PREFIX)) {
    const appId = interaction.customId.slice(ACCEPT_PREFIX.length);
    return handleInterviewAccept(interaction, appId);
  }

  if (interaction.isButton() && interaction.customId.startsWith(DENY_PREFIX)) {
    const appId = interaction.customId.slice(DENY_PREFIX.length);
    return handleInterviewDenyButton(interaction, appId);
  }

  if (interaction.isButton() && interaction.customId.startsWith(ASK_AGAIN_PREFIX)) {
    const appId = interaction.customId.slice(ASK_AGAIN_PREFIX.length);
    return handleInterviewAskAgain(interaction, appId);
  }

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith(ASK_AGAIN_SELECT_PREFIX)) {
    const appId = interaction.customId.slice(ASK_AGAIN_SELECT_PREFIX.length);
    return handleInterviewAskAgainSelect(interaction, appId);
  }

  if (interaction.isButton() && interaction.customId.startsWith(RETAKE_READY_PREFIX)) {
    return handleInterviewRetakeReady(interaction);
  }

  if (interaction.isButton() && interaction.customId.startsWith(INTERVIEW_START_PREFIX)) {
    return handleInterviewStartButton(interaction);
  }

  if (interaction.isButton() && interaction.customId.startsWith(CONTINUE_PREFIX)) {
    const guildId = interaction.customId.slice(CONTINUE_PREFIX.length);
    return handleInterviewContinue(interaction, guildId);
  }

  if (interaction.isButton() && interaction.customId.startsWith(ADD_NOTE_PREFIX)) {
    const guildId = interaction.customId.slice(ADD_NOTE_PREFIX.length);
    return handleInterviewAddNoteButton(interaction, guildId);
  }

  if (interaction.isButton() && interaction.customId.startsWith(REPEAT_PREFIX)) {
    const guildId = interaction.customId.slice(REPEAT_PREFIX.length);
    return handleInterviewRepeat(interaction, guildId);
  }

  if (interaction.isButton() && interaction.customId.startsWith(DISCONTINUE_PREFIX)) {
    const guildId = interaction.customId.slice(DISCONTINUE_PREFIX.length);
    return handleInterviewDiscontinueButton(interaction, guildId);
  }

  return false;
}

async function restoreInterviewApplications(client) {
  for (const application of listInterviewApplications({ status: "pending" })) {
    applications.set(application.appId, application);

    if (!application.messageId || !application.channelId) continue;

    try {
      const channel = await client.channels.fetch(application.channelId).catch(() => null);
      const message = await channel?.messages.fetch(application.messageId).catch(() => null);

      if (message) {
        await message.edit(
          buildSubmissionPayload(application, {
            forEdit: true,
            actionRows: [buildReviewButtons(application.appId)],
          }),
        );
      }
    } catch (error) {
      console.warn(`[interview] Could not restore submission ${application.appId}:`, error.message);
    }
  }

  const pendingCount = listInterviewApplications({ status: "pending" }).length;
  if (pendingCount > 0) {
    console.log(`[interview] Restored ${pendingCount} pending submission(s).`);
  }
}

function registerInterviewVoiceHandlers(client) {
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const session = getSession(newState.guild.id);
    if (!session) return;

    if (
      newState.channelId === session.voiceChannelId &&
      newState.id !== session.intervieweeId &&
      !newState.member?.user?.bot
    ) {
      await newState.disconnect("This interview channel is for the applicant only.").catch(() => null);
      return;
    }

    if (newState.id !== session.intervieweeId) return;

    const leftChannel =
      oldState.channelId === session.voiceChannelId && newState.channelId !== session.voiceChannelId;

    if (leftChannel) {
      await endInterview(client, session.guildId, {
        reason: `<@${session.intervieweeId}> left the interview voice channel — interview ended without submission.`,
      });
    }
  });
}

module.exports = {
  INTERVIEW_COMMAND,
  INTERVIEW_DASHBOARD_BUTTON_ID,
  INTERVIEW_QUEUE_VOICE_URL,
  buildInterviewPanelButton,
  promptInterviewRoleplayName,
  buildInterviewCommand,
  buildInterviewClearCommand,
  handleInterviewCommand,
  handleInterviewClearCommand,
  handleInterviewClearSlashCommand,
  handleInterviewSlashCommand,
  handleInterviewInteraction,
  registerInterviewVoiceHandlers,
  restoreInterviewApplications,
};
