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
const { getCooldownEnd, setCooldown } = require("./cooldowns");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { STAFF_PING_ROLE_ID } = require("./constants");
const { buildV2Payload, buildV2EditPayload } = require("./v2-message");
const { getRoleplayNameFromMember } = require("./discord-callsign");
const { isSheetsConfigured } = require("./google-sheets/client");
const { completeMemberRosterSetup } = require("./roster-onboarding");
const { logRosterAudit } = require("./roster-audit-log");
const { RANK_OPTIONS, resolveRankForRosterAdd } = require("./rank-options");
const {
  getInterviewApplication,
  saveInterviewApplication,
  listInterviewApplications,
} = require("./interview-applications-store");
const { synthesizeSpeech, deleteTempFile } = require("./voice/tts");
const { ensureMessageMember, getMemberVoiceChannel } = require("./voice/member-voice");
const { VoiceInterviewRecorder } = require("./voice/recorder");
const {
  joinMemberVoiceChannel,
  playFile,
  destroyVoiceSession,
  waitForUserToFinishSpeaking,
} = require("./voice/audio");

const INTERVIEW_COMMAND = "-interview";
const CONTINUE_PREFIX = "interview_continue:";
const DISCONTINUE_PREFIX = "interview_discontinue:";
const ADD_NOTE_PREFIX = "interview_add_note:";
const REPEAT_PREFIX = "interview_repeat:";
const MODAL_NOTE_PREFIX = "interview_note_modal:";
const MODAL_DISCONTINUE_PREFIX = "interview_discontinue_modal:";
const ACCEPT_PREFIX = "voice_interview_accept:";
const DENY_PREFIX = "voice_interview_deny:";
const RANK_SELECT_PREFIX = "voice_interview_rank:";
const MODAL_DENY_PREFIX = "voice_interview_deny_modal:";

const GUIDE_CHANNEL_ID = "1484990957299564666";
const DEFAULT_SUBMISSIONS_CHANNEL_ID = "1507976263141163008";

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
  id: rank.discordRoleIds[0],
  label: rank.label,
}));

const sessions = new Map();
const applications = new Map();

function getSubmissionsChannelId() {
  return process.env.INTERVIEW_SUBMISSIONS_CHANNEL_ID || DEFAULT_SUBMISSIONS_CHANNEL_ID;
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

function formatAnswerPanelContent(session) {
  const questionNumber = session.questionIndex + 1;
  let content =
    `<@${session.intervieweeId}> **Done talking?**\n` +
    `Question **${questionNumber}** of **${QUESTIONS.length}** — use the panel when you're ready.\n\n` +
    "**Continue** — next question · **Add Note** — type extra info · **Repeat Question** · **Discontinue** — end early";

  if (session.notes?.length > 0) {
    content += `\n\n📝 **${session.notes.length}** note(s) added this interview.`;
  }

  return content;
}

async function refreshAnswerPanelMessage(client, session) {
  if (!session.continueMessageId) return;

  const textChannel = await client.channels.fetch(session.textChannelId).catch(() => null);
  const message = await textChannel?.messages.fetch(session.continueMessageId).catch(() => null);
  if (!message) return;

  await message.edit({
    content: formatAnswerPanelContent(session),
    components: buildAnswerControlRows(session.guildId),
    allowedMentions: { users: [session.intervieweeId] },
  });
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
  );
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

function buildSubmissionPayload(application, { actionRows = [], forEdit = false } = {}) {
  const {
    userId,
    userTag,
    roleplayName,
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
      value: hasRecording ? "Attached below — all answers were recorded in voice." : "No audio captured.",
    },
  ];

  if (roleplayName) {
    fields.push({ name: "Roster Name", value: roleplayName });
  }

  fields.push({
    name: "Interview Questions",
    value: truncateField(
      QUESTIONS.map((question, index) => `${index + 1}. ${question}`).join("\n"),
    ),
  });
  fields.push({
    name: "Responses",
    value: "All answers were given in voice — listen to the attached recording.",
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
      (status === "pending" ? `<@&${STAFF_PING_ROLE_ID}>\n\n` : "") +
      `Applicant: <@${userId}> (\`${userTag}\`)\nUser ID: \`${userId}\``,
    fields,
    footer: footerParts.length > 0 ? footerParts.join(" · ") : undefined,
    actionRows,
    allowedMentions: status === "pending" ? { roles: [STAFF_PING_ROLE_ID] } : undefined,
  });
}

async function speakText(session, text) {
  const filePath = await synthesizeSpeech(text);
  try {
    await playFile(session.player, filePath);
  } finally {
    deleteTempFile(filePath);
  }
}

async function postAnswerControlPanel(client, session) {
  const textChannel = await client.channels.fetch(session.textChannelId).catch(() => null);
  if (!textChannel?.isTextBased()) return;

  session.waitingForContinue = true;

  const message = await textChannel.send({
    content: formatAnswerPanelContent(session),
    components: buildAnswerControlRows(session.guildId),
    allowedMentions: { users: [session.intervieweeId] },
  });

  session.continueMessageId = message.id;
}

async function runQuestion(client, session) {
  if (session.cancelled) return;

  const questionNumber = session.questionIndex + 1;
  const question = QUESTIONS[session.questionIndex];
  const spoken = `Question ${questionNumber}. ${question}`;

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

  await postAnswerControlPanel(client, session);
}

async function submitInterviewApplication(client, session, recordingPath) {
  const guild = await client.guilds.fetch(session.guildId).catch(() => null);
  const member = await guild?.members.fetch(session.intervieweeId).catch(() => null);
  const user = member?.user ?? (await client.users.fetch(session.intervieweeId).catch(() => null));
  const submittedAt = Date.now();
  const appId = `${session.intervieweeId}-${submittedAt}`;
  const roleplayName = member ? getRoleplayNameFromMember(member) : null;

  const application = {
    appId,
    userId: session.intervieweeId,
    userTag: user?.tag ?? session.intervieweeId,
    guildId: session.guildId,
    roleplayName,
    durationMs: session.startedAt ? submittedAt - session.startedAt : 0,
    submittedAt,
    status: "pending",
    voiceChannelName: session.voiceChannelName,
    hasRecording: Boolean(recordingPath),
    notes: session.notes ?? [],
    discontinuedEarly: Boolean(session.discontinuedEarly),
    discontinueReason: session.discontinueReason ?? "",
  };

  persistApplication(application);

  const submissionsChannel = await client.channels.fetch(getSubmissionsChannelId()).catch(() => null);
  if (!submissionsChannel?.isTextBased()) {
    throw new Error("The interview submissions channel could not be found.");
  }

  const files = [];
  if (recordingPath) {
    files.push(
      new AttachmentBuilder(recordingPath, {
        name: `voice-interview-${application.userTag.replace(/[^a-z0-9-_]/gi, "-")}.mp3`,
      }),
    );
  }

  try {
    const submissionMessage = await submissionsChannel.send({
      ...buildSubmissionPayload(application, { actionRows: [buildReviewButtons(appId)] }),
      files,
    });

    application.messageId = submissionMessage.id;
    application.channelId = submissionsChannel.id;
    persistApplication(application);
  } catch (error) {
    if (files.length > 0 && /413|file/i.test(error.message ?? "")) {
      const submissionMessage = await submissionsChannel.send({
        ...buildSubmissionPayload(application, {
          actionRows: [buildReviewButtons(appId)],
        }),
      });
      application.messageId = submissionMessage.id;
      application.channelId = submissionsChannel.id;
      application.hasRecording = false;
      persistApplication(application);
    } else {
      throw error;
    }
  }

  if (recordingPath) {
    deleteTempFile(recordingPath);
  }

  return application;
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

  const textChannel = await client.channels.fetch(session.textChannelId).catch(() => null);
  if (textChannel?.isTextBased()) {
    await textChannel.send(`<@${session.intervieweeId}> ${closingLine}`);
  }

  try {
    await submitInterviewApplication(client, session, recordingPath);
  } catch (error) {
    console.error("[interview] Submission failed:", error);
    if (textChannel?.isTextBased()) {
      await textChannel.send(
        `<@${session.intervieweeId}> Your interview was recorded, but staff could not be notified automatically. Contact an administrator.`,
      );
    }
  }

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

async function runInterviewLoop(client, session) {
  try {
    await speakText(
      session,
      "This voice interview is being recorded for staff review. Please answer each question clearly when prompted.",
    );

    if (session.cancelled) return;

    session.recorder.start();
    session.startedAt = Date.now();
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

    const hostChannel = await getMemberVoiceChannel(hostMember);
    if (!hostChannel) {
      return { error: "You must be in a voice channel to host an interview." };
    }

    const applicantChannel = await getMemberVoiceChannel(member);
    if (!applicantChannel || applicantChannel.id !== hostChannel.id) {
      return { error: `<@${member.id}> must be in your voice channel.` };
    }

    return { interviewee: member, hostChannel };
  }

  const hostChannel = await getMemberVoiceChannel(hostMember);
  if (!hostChannel) {
    return { error: "Join a voice channel first, then run `-interview` or `/interview`." };
  }

  return {
    interviewee: hostMember,
    hostChannel,
  };
}

async function startInterview(client, { guild, textChannel, hostMember, interviewee, hostChannel }) {
  if (getSession(guild.id)) {
    throw new Error("An interview is already running in this server.");
  }

  const statusMessage = await textChannel.send(
    `Joining **${hostChannel.name}** to start the voice interview for <@${interviewee.id}>…`,
  );

  let voiceSession;
  try {
    voiceSession = await joinMemberVoiceChannel(hostMember);
  } catch (error) {
    throw new Error(error.message ?? "Could not join the voice channel.");
  }

  if (voiceSession.voiceChannel.id !== hostChannel.id) {
    await destroyVoiceSession(voiceSession.connection, voiceSession.player);
    throw new Error("Could not join your voice channel.");
  }

  const session = {
    guildId: guild.id,
    textChannelId: textChannel.id,
    voiceChannelId: hostChannel.id,
    voiceChannelName: hostChannel.name,
    intervieweeId: interviewee.id,
    startedById: hostMember.id,
    questionIndex: 0,
    waitingForSpeech: false,
    waitingForContinue: false,
    cancelled: false,
    connection: voiceSession.connection,
    player: voiceSession.player,
    recorder: new VoiceInterviewRecorder(voiceSession.connection, interviewee.id),
    continueMessageId: null,
    startedAt: null,
    notes: [],
    discontinuedEarly: false,
    discontinueReason: "",
  };

  sessions.set(guild.id, session);

  await statusMessage.edit(
    `Voice interview started for <@${interviewee.id}> in **${hostChannel.name}**.\n` +
      `This session **is being recorded**. Answer each question in voice, then click the red **Continue** button here.`,
  );

  runInterviewLoop(client, session);
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
  const roleId = interaction.values[0];
  const rank = RANKS.find((entry) => entry.id === roleId);

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
  const rankOption = RANK_OPTIONS.find((option) => option.discordRoleIds.includes(roleId));
  const { sheetRank } = resolveRankForRosterAdd(guild, rankOption?.id ?? rankLabel);

  if (member && guild) {
    await member.roles.add(roleId, "Voice interview accepted").catch((error) => {
      console.error("Failed to assign role:", error);
    });
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
  application.rankId = roleId;
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
    content: `Interview accepted. **${application.userTag}** was assigned **${application.rankLabel}**.${rosterSummary}`,
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
  const cooldownEnd = setCooldown(application.userId);

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

    await startInterview(message.client, {
      guild: message.guild,
      textChannel: message.channel,
      hostMember,
      interviewee: resolved.interviewee,
      hostChannel: resolved.hostChannel,
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
    .setDescription("Start a voice interview in your current voice channel")
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Optional: staff can interview another member in your VC")
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

  await interaction.deferReply();

  try {
    const hostMember =
      interaction.member ??
      (await interaction.guild.members.fetch(interaction.user.id).catch(() => null));

    if (!hostMember) {
      await interaction.editReply("Could not resolve your server membership.");
      return true;
    }

    const targetUser = interaction.options.getUser("member");
    const fakeMessage = {
      guild: interaction.guild,
      mentions: { users: { first: () => targetUser ?? null } },
    };

    const resolved = await resolveInterviewee(fakeMessage, hostMember);
    if (resolved.error) {
      await interaction.editReply(resolved.error);
      return true;
    }

    await startInterview(interaction.client, {
      guild: interaction.guild,
      textChannel: interaction.channel,
      hostMember,
      interviewee: resolved.interviewee,
      hostChannel: resolved.hostChannel,
    });

    await interaction.deleteReply().catch(async () => {
      await interaction.editReply("Interview started — check the messages above.");
    });
  } catch (error) {
    console.error("[interview] Slash start failed:", error);
    await interaction.editReply(error.message ?? "Could not start the interview.");
  }

  return true;
}

async function advanceInterviewAfterContinue(client, session, interaction) {
  await interaction.message.edit({ components: [] }).catch(() => null);

  session.questionIndex += 1;
  session.waitingForContinue = false;

  if (session.questionIndex >= QUESTIONS.length) {
    await finishInterview(client, session);
    return;
  }

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
  await refreshAnswerPanelMessage(interaction.client, session);
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
  await interaction.message.edit({ components: [] }).catch(() => null);
  await finishInterview(interaction.client, session);
  return true;
}

async function handleInterviewInteraction(interaction) {
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

    if (newState.id !== session.intervieweeId) return;

    const leftChannel =
      oldState.channelId === session.voiceChannelId && newState.channelId !== session.voiceChannelId;

    if (leftChannel) {
      await endInterview(client, session.guildId, {
        reason: `<@${session.intervieweeId}> left the voice channel — interview ended without submission.`,
      });
    }
  });
}

module.exports = {
  INTERVIEW_COMMAND,
  buildInterviewCommand,
  handleInterviewCommand,
  handleInterviewSlashCommand,
  handleInterviewInteraction,
  registerInterviewVoiceHandlers,
  restoreInterviewApplications,
};
