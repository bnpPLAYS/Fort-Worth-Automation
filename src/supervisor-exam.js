const {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { EMBED_COLOR } = require("./constants");

const TYPE_SUPERVISOR_EXAM_ID = "support_type_supervisor_exam";
const SUPERVISOR_EXAM_MODAL_ID = "supervisor_exam_modal";

const REQUIRED_ROLE_ID = "1501804405366718534";
const SUBMISSION_CHANNEL_ID = "1507976263141163008";
const MIN_WORDS = 20;

const EXAM_FIELDS = [
  {
    id: "ready",
    label: "Ready for supervisor role?",
    question: "Why do you believe you are ready for a supervisor position?",
    placeholder: "Write at least 20 words explaining your readiness...",
  },
  {
    id: "officer_arguing",
    label: "Officer arguing with civilians?",
    question:
      "An officer under your supervision begins arguing with civilians. What would you do?",
    placeholder: "Write at least 20 words describing your response...",
  },
  {
    id: "talking_over",
    label: "Officers talking over each other?",
    question:
      "You arrive on scene, and multiple officers are talking over each other. How do you regain control?",
    placeholder: "Write at least 20 words explaining how you would handle this...",
  },
  {
    id: "driver_exits",
    label: "Driver exits during traffic stop?",
    question:
      "During a traffic stop, the driver suddenly exits the vehicle and begins walking toward your officers. What would you do?",
    placeholder: "Write at least 20 words describing your actions...",
  },
  {
    id: "stolen_vehicle",
    label: "Vehicle reported stolen on stop?",
    question:
      "During the stop, dispatch advises that the vehicle was reported stolen. How would you coordinate the situation?",
    placeholder: "Write at least 20 words explaining your coordination plan...",
  },
];

const examSessions = new Map();

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

function buildSupervisorExamModal() {
  const modal = new ModalBuilder()
    .setCustomId(SUPERVISOR_EXAM_MODAL_ID)
    .setTitle("Supervisor Exam");

  for (const field of EXAM_FIELDS) {
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(field.id)
          .setLabel(field.label)
          .setPlaceholder(field.placeholder)
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000),
      ),
    );
  }

  return modal;
}

function buildSubmissionEmbed(user, answers, durationMs) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("New Supervisor Exam Submission")
    .setDescription(`Applicant: ${user} (\`${user.tag}\`)\nUser ID: \`${user.id}\``)
    .addFields({
      name: "Completion Time",
      value: formatDuration(durationMs),
      inline: true,
    })
    .setTimestamp();

  for (const field of EXAM_FIELDS) {
    embed.addFields({
      name: field.question,
      value: truncateField(answers[field.id]),
    });
  }

  return embed;
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

    const durationMs = Date.now() - session.startTime;
    examSessions.delete(interaction.user.id);

    const submissionsChannel = await interaction.client.channels
      .fetch(SUBMISSION_CHANNEL_ID)
      .catch(() => null);

    if (!submissionsChannel?.isTextBased()) {
      await interaction.editReply(
        "Your exam could not be submitted because the submissions channel was not found. Contact an admin.",
      );
      return true;
    }

    try {
      await submissionsChannel.send({
        embeds: [buildSubmissionEmbed(interaction.user, answers, durationMs)],
      });
    } catch (error) {
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

  return false;
}

module.exports = {
  TYPE_SUPERVISOR_EXAM_ID,
  handleSupervisorExamInteraction,
};
