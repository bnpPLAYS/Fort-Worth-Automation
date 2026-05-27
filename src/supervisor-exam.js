const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const {
  EMBED_COLOR,
  STAFF_PING_ROLE_ID,
  SUPERVISOR_EXAM_ELIGIBILITY_ROLE_ID,
  SUPERVISOR_APPROVED_ROLE_IDS,
  GOOGLE_SUPERVISOR_RANK_NAME,
} = require("./constants");
const { getRoleplayNameFromMember, updateMemberCallsign } = require("./discord-callsign");
const {
  isSheetsConfigured,
  assignMemberToOpenRank,
} = require("./google-sheets/roster-assign");

const TYPE_SUPERVISOR_EXAM_ID = "support_type_supervisor_exam";
const SUPERVISOR_EXAM_BEGIN_ID = "supervisor_exam_begin";
const SUPERVISOR_EXAM_MODAL_ID = "supervisor_exam_modal";
const EXAM_APPROVE_PREFIX = "supervisor_exam_approve:";
const EXAM_DENY_PREFIX = "supervisor_exam_deny:";
const EXAM_DENY_MODAL_PREFIX = "supervisor_exam_deny_modal:";

const REQUIRED_ROLE_ID = SUPERVISOR_EXAM_ELIGIBILITY_ROLE_ID;
const SUBMISSION_CHANNEL_ID = "1507976263141163008";
const MIN_WORDS = 20;

const EXAM_FIELDS = [
  {
    id: "ready",
    number: 1,
    modalLabel: "Why are you ready to become supervisor?",
    question: "Why do you believe you are ready for a supervisor position?",
  },
  {
    id: "officer_arguing",
    number: 2,
    modalLabel: "Officer argues with civilians; response?",
    question:
      "An officer under your supervision begins arguing with civilians. What would you do?",
  },
  {
    id: "talking_over",
    number: 3,
    modalLabel: "How do you regain control of a scene?",
    question:
      "You arrive on scene, and multiple officers are talking over each other. How do you regain control?",
  },
  {
    id: "driver_exits",
    number: 4,
    modalLabel: "Driver exits during stop; your response?",
    question:
      "During a traffic stop, the driver suddenly exits the vehicle and begins walking toward your officers. What would you do?",
  },
  {
    id: "stolen_vehicle",
    number: 5,
    modalLabel: "Stolen vehicle alert; how coordinate?",
    question:
      "During the stop, dispatch advises that the vehicle was reported stolen. How would you coordinate the situation?",
  },
];

const examSessions = new Map();
const examApplications = new Map();

function countWords(text) {
  const normalized = text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!normalized) return 0;
  return normalized.split(" ").length;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function truncateField(value) {
  return value.length > 1024 ? value.slice(0, 1021) + "..." : value;
}

function canReviewExam(member) {
  return (
    member?.permissions?.has(PermissionFlagsBits.ManageRoles) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

function getExamApplication(appId) {
  return examApplications.get(appId) ?? null;
}

function buildExamQuestionsEmbed() {
  const description = EXAM_FIELDS.map(
    (field) => `**${field.number}.** ${field.question}`,
  ).join("\n\n");

  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Supervisor Exam")
    .setDescription(
      `${description}\n\n` +
        `Each answer must be at least **${MIN_WORDS} words**. Click **Begin Exam** below when you are ready.`,
    );
}

function buildBeginExamButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(SUPERVISOR_EXAM_BEGIN_ID)
      .setLabel("Begin Exam")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildSupervisorExamModal() {
  const modal = new ModalBuilder()
    .setCustomId(SUPERVISOR_EXAM_MODAL_ID)
    .setTitle("Supervisor Exam");

  for (const field of EXAM_FIELDS) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(field.id)
          .setLabel(field.modalLabel)
          .setPlaceholder(`Minimum ${MIN_WORDS} words — see full question in the exam preview above`)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000),
      ),
    );
  }

  return modal;
}

function buildSubmissionEmbed(application) {
  const { userId, userTag, answers, durationMs, status, reviewerTag, denyReason } = application;

  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(
      status === "accepted"
        ? "Supervisor Exam — Approved"
        : status === "denied"
          ? "Supervisor Exam — Denied"
          : "New Supervisor Exam Submission",
    )
    .setDescription(`Applicant: <@${userId}> (\`${userTag}\`)\nUser ID: \`${userId}\``)
    .addFields({
      name: "Completion Time",
      value: formatDuration(durationMs),
      inline: true,
    })
    .setTimestamp(application.submittedAt);

  for (const field of EXAM_FIELDS) {
    embed.addFields({
      name: `${field.number}. ${field.question}`,
      value: truncateField(answers[field.id]),
    });
  }

  if (status === "denied" && denyReason) {
    embed.addFields({ name: "Denial Reason", value: truncateField(denyReason) });
  }

  if (reviewerTag) {
    embed.setFooter({ text: `Reviewed by ${reviewerTag}` });
  }

  return embed;
}

function buildReviewButtons(appId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${EXAM_APPROVE_PREFIX}${appId}`)
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${EXAM_DENY_PREFIX}${appId}`)
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger),
  );
}

async function handleSupervisorExamInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === TYPE_SUPERVISOR_EXAM_ID) {
    const member = interaction.member;
    if (!member?.roles?.cache?.has(REQUIRED_ROLE_ID)) {
      await interaction.reply({
        content: "You do not have the required role to request a supervisor exam.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.reply({
      embeds: [buildExamQuestionsEmbed()],
      components: [buildBeginExamButton()],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isButton() && interaction.customId === SUPERVISOR_EXAM_BEGIN_ID) {
    const member = interaction.member;
    if (!member?.roles?.cache?.has(REQUIRED_ROLE_ID)) {
      await interaction.reply({
        content: "You do not have the required role to request a supervisor exam.",
        ephemeral: true,
      });
      return true;
    }

    examSessions.set(interaction.user.id, { startTime: Date.now() });
    await interaction.showModal(buildSupervisorExamModal());
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === SUPERVISOR_EXAM_MODAL_ID) {
    const member = interaction.member;
    if (!member?.roles?.cache?.has(REQUIRED_ROLE_ID)) {
      await interaction.reply({
        content: "You no longer have the required role to submit a supervisor exam.",
        ephemeral: true,
      });
      return true;
    }

    const session = examSessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content: "Your exam session expired. Please start again from **Contact Support**.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const answers = {};
    const tooShort = [];

    for (const field of EXAM_FIELDS) {
      const answer = interaction.fields.getTextInputValue(field.id);
      const wordCount = countWords(answer);
      answers[field.id] = answer;

      if (wordCount < MIN_WORDS) {
        tooShort.push({ question: field.question, wordCount });
      }
    }

    if (tooShort.length > 0) {
      examSessions.delete(interaction.user.id);
      await interaction.editReply({
        content:
          `Each answer must be at least **${MIN_WORDS} words**. These answers were too short:\n` +
          tooShort.map(({ question, wordCount }) => `• ${question} — **${wordCount}/${MIN_WORDS} words**`).join("\n") +
          "\n\nPlease start again from **Contact Support** → **Supervisor Exam**.",
      });
      return true;
    }

    const endTime = Date.now();
    const durationMs = endTime - session.startTime;
    const appId = `${interaction.user.id}-${endTime}`;
    examSessions.delete(interaction.user.id);

    const application = {
      appId,
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      guildId: interaction.guildId,
      answers,
      durationMs,
      submittedAt: endTime,
      status: "pending",
    };

    examApplications.set(appId, application);

    const submissionsChannel = await interaction.client.channels
      .fetch(SUBMISSION_CHANNEL_ID)
      .catch(() => null);

    if (!submissionsChannel?.isTextBased()) {
      examApplications.delete(appId);
      await interaction.editReply(
        "Your exam could not be submitted because the submissions channel was not found. Contact an admin.",
      );
      return true;
    }

    try {
      const submissionMessage = await submissionsChannel.send({
        content: `<@&${STAFF_PING_ROLE_ID}>`,
        embeds: [buildSubmissionEmbed(application)],
        components: [buildReviewButtons(appId)],
        allowedMentions: { roles: [STAFF_PING_ROLE_ID] },
      });

      application.messageId = submissionMessage.id;
      application.channelId = submissionsChannel.id;
    } catch (error) {
      examApplications.delete(appId);
      console.error("Failed to send supervisor exam submission:", error);
      await interaction.editReply(
        "Your exam could not be submitted due to a Discord error. Contact an admin.",
      );
      return true;
    }

    await interaction.editReply(
      `Your supervisor exam has been submitted! It took you **${formatDuration(durationMs)}** to complete.`,
    );
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith(EXAM_APPROVE_PREFIX)) {
    const appId = interaction.customId.slice(EXAM_APPROVE_PREFIX.length);
    const application = getExamApplication(appId);

    if (!application || application.status !== "pending") {
      await interaction.reply({ content: "This exam submission is no longer pending.", ephemeral: true });
      return true;
    }

    if (!canReviewExam(interaction.member)) {
      await interaction.reply({
        content: "You need **Manage Roles** or **Manage Server** to review supervisor exams.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const guild = await interaction.client.guilds.fetch(application.guildId).catch(() => null);
    const member = await guild?.members.fetch(application.userId).catch(() => null);

    if (member && guild) {
      if (member.roles.cache.has(REQUIRED_ROLE_ID)) {
        await member.roles.remove(REQUIRED_ROLE_ID).catch((error) => {
          console.error("Failed to remove eligibility role:", error);
        });
      }

      await member.roles.add(SUPERVISOR_APPROVED_ROLE_IDS).catch((error) => {
        console.error("Failed to assign supervisor roles:", error);
      });
    }

    let rosterSummary = "";
    if (member && isSheetsConfigured()) {
      const roleplayName = getRoleplayNameFromMember(member);
      const supervisorRank =
        process.env.GOOGLE_SUPERVISOR_RANK_NAME || GOOGLE_SUPERVISOR_RANK_NAME;

      try {
        const rosterResult = await assignMemberToOpenRank(roleplayName, supervisorRank, {
          currentCallsign: extractCallsignFromDisplayName(member.displayName),
        });
        const nicknameResult = await updateMemberCallsign(
          member,
          rosterResult.newCallsign,
          roleplayName,
        );

        rosterSummary =
          `\nRoster: **${rosterResult.newRank}** — callsign **${rosterResult.newCallsign}**` +
          (nicknameResult.ok && nicknameResult.changed ? " (nickname updated)" : "");

        application.rosterCallsign = rosterResult.newCallsign;
        application.rosterRank = rosterResult.newRank;
      } catch (error) {
        console.error("Supervisor exam roster assignment failed:", error);
        rosterSummary = `\nRoster assignment failed: ${error.message}`;
      }
    }

    application.status = "accepted";
    application.reviewerTag = interaction.user.tag;

    const channel = await interaction.client.channels.fetch(application.channelId).catch(() => null);
    const message = await channel?.messages.fetch(application.messageId).catch(() => null);

    if (message) {
      await message.edit({
        embeds: [buildSubmissionEmbed(application)],
        components: [],
      });
    }

    const applicant = await interaction.client.users.fetch(application.userId).catch(() => null);
    if (applicant) {
      let dmContent =
        "Congratulations! Your **Supervisor Exam** has been **approved**.\n\n" +
        "Your roles have been updated. Welcome to the supervisor team.";

      if (application.rosterCallsign) {
        dmContent += `\n\nYour roster callsign is **${application.rosterCallsign}** (${application.rosterRank}).`;
      } else if (rosterSummary.includes("Roster assignment failed")) {
        dmContent +=
          "\n\nYour roster entry could not be updated automatically. Contact staff to be moved on the database.";
      }

      await applicant.send({ content: dmContent }).catch(() => {});
    }

    await interaction.editReply(
      `Exam approved. **${application.userTag}** was updated with supervisor roles.${rosterSummary}`,
    );
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith(EXAM_DENY_PREFIX)) {
    const appId = interaction.customId.slice(EXAM_DENY_PREFIX.length);
    const application = getExamApplication(appId);

    if (!application || application.status !== "pending") {
      await interaction.reply({ content: "This exam submission is no longer pending.", ephemeral: true });
      return true;
    }

    if (!canReviewExam(interaction.member)) {
      await interaction.reply({
        content: "You need **Manage Roles** or **Manage Server** to review supervisor exams.",
        ephemeral: true,
      });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId(`${EXAM_DENY_MODAL_PREFIX}${appId}`)
      .setTitle("Deny Supervisor Exam")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("deny_reason")
            .setLabel("Reason for denial")
            .setPlaceholder("Explain why this exam was denied...")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000),
        ),
      );

    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(EXAM_DENY_MODAL_PREFIX)) {
    const appId = interaction.customId.slice(EXAM_DENY_MODAL_PREFIX.length);
    const application = getExamApplication(appId);

    if (!application || application.status !== "pending") {
      await interaction.reply({ content: "This exam submission is no longer pending.", ephemeral: true });
      return true;
    }

    if (!canReviewExam(interaction.member)) {
      await interaction.reply({
        content: "You need **Manage Roles** or **Manage Server** to review supervisor exams.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const denyReason = interaction.fields.getTextInputValue("deny_reason");

    application.status = "denied";
    application.denyReason = denyReason;
    application.reviewerTag = interaction.user.tag;

    const channel = await interaction.client.channels.fetch(application.channelId).catch(() => null);
    const message = await channel?.messages.fetch(application.messageId).catch(() => null);

    if (message) {
      await message.edit({
        embeds: [buildSubmissionEmbed(application)],
        components: [],
      });
    }

    const applicant = await interaction.client.users.fetch(application.userId).catch(() => null);
    if (applicant) {
      await applicant
        .send({
          content:
            `Your **Supervisor Exam** has been **denied**.\n\n` +
            `**Reason:** ${denyReason}`,
        })
        .catch(() => {});
    }

    await interaction.editReply(`Exam denied. **${application.userTag}** was notified via DM.`);
    return true;
  }

  return false;
}

module.exports = {
  TYPE_SUPERVISOR_EXAM_ID,
  handleSupervisorExamInteraction,
};
