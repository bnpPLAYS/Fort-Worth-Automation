const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require("discord.js");
const { getCooldownEnd, isOnCooldown, setCooldown } = require("./cooldowns");
const { hasProcessed, markProcessed } = require("./panel-dedupe");

const PANEL_COMMAND = "-panelfastpass";
const BUTTON_CUSTOM_ID = "fastpass_apply";
const MODAL_STAGE_ONE_ID = "fastpass_modal_stage1";
const MODAL_DENY_PREFIX = "fastpass_deny_modal:";
const CONTINUE_PREFIX = "fastpass_continue:";
const MODAL_STAGE_TWO_PREFIX = "fastpass_modal_stage2:";
const ACCEPT_PREFIX = "fastpass_accept:";
const DENY_PREFIX = "fastpass_deny:";
const RANK_SELECT_PREFIX = "fastpass_rank:";

const MIN_WORDS = 20;
const GUIDE_CHANNEL_ID = "1484990957299564666";

const STAGE_ONE_FIELDS = [
  {
    id: "activity",
    label: "Weekly server activity?",
    question: "How active are you on the server weekly?",
    placeholder: "Describe how often you play and participate each week...",
  },
  {
    id: "le_experience",
    label: "Previous LE RP experience?",
    question: "Do you have previous law enforcement RP experience?",
    placeholder: "Describe any prior law enforcement roleplay experience...",
  },
];

const STAGE_TWO_FIELDS = [
  {
    id: "why_choose",
    label: "Why choose you over others?",
    question: "Why should we choose you over other applicants?",
    placeholder: "Write at least 20 words explaining why you stand out...",
  },
  {
    id: "qualities",
    label: "Qualities for the department?",
    question: "What qualities would you bring to the department?",
    placeholder: "Write at least 20 words about your strengths and qualities...",
  },
  {
    id: "traffic_stop",
    label: "Before initiating a traffic stop?",
    question: "What should you do before initiating a traffic stop?",
    placeholder: "Write at least 20 words on proper traffic stop procedure...",
  },
  {
    id: "use_of_force",
    label: "When is force appropriate?",
    question: "When is it appropriate to use force during a situation?",
    placeholder: "Write at least 20 words on appropriate use of force...",
  },
  {
    id: "non_compliance",
    label: "If suspect refuses to comply?",
    question: "What should you do if a suspect refuses to comply with orders?",
    placeholder: "Write at least 20 words on handling non-compliance...",
  },
];

const RANKS = [
  { id: "1484975766868594699", label: "Probationary Officer" },
  { id: "1484950896864530442", label: "Officer One" },
  { id: "1484950861716263004", label: "Officer Two" },
  { id: "1484950728647774408", label: "Officer Three" },
];

const pendingSessions = new Map();
const applications = new Map();

function getSubmissionsChannelId() {
  return process.env.FASTPASS_SUBMISSIONS_CHANNEL_ID || "1498803252626718833";
}

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

function canReviewApplications(member) {
  return (
    member?.permissions?.has(PermissionFlagsBits.ManageRoles) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

function buildModal(title, customId, fields) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);

  for (const field of fields) {
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

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Fast Pass Application")
    .setDescription(
      "Click **Fast Pass** below to begin your application.\n\n" +
        "You will complete a two-part form. The second part requires detailed answers of at least 20 words each.",
    )
    .setFooter({ text: "Fort Worth Automation" });
}

function buildPanelButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_CUSTOM_ID)
      .setLabel("Fast Pass")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildSubmissionEmbed(application) {
  const { userId, userTag, stage1, stage2, durationMs, status, reviewerTag, rankLabel, denyReason } =
    application;

  const color =
    status === "accepted" ? 0x57f287 : status === "denied" ? 0xed4245 : 0x5865f2;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(
      status === "accepted"
        ? "Fast Pass Application — Accepted"
        : status === "denied"
          ? "Fast Pass Application — Denied"
          : "New Fast Pass Application",
    )
    .setDescription(`Applicant: <@${userId}> (\`${userTag}\`)\nUser ID: \`${userId}\``)
    .addFields({
      name: "Completion Time",
      value: formatDuration(durationMs),
      inline: true,
    })
    .setTimestamp(application.submittedAt);

  for (const field of STAGE_ONE_FIELDS) {
    embed.addFields({
      name: field.question,
      value: truncateField(stage1[field.id]),
    });
  }

  for (const field of STAGE_TWO_FIELDS) {
    embed.addFields({
      name: field.question,
      value: truncateField(stage2[field.id]),
    });
  }

  if (status === "accepted" && rankLabel) {
    embed.addFields({ name: "Assigned Rank", value: rankLabel });
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

function getApplication(appId) {
  return applications.get(appId) ?? null;
}

async function handlePanelCommand(message) {
  if (message.content.trim().toLowerCase() !== PANEL_COMMAND) return false;
  if (message.author.bot) return false;

  if (hasProcessed(message.id)) {
    return true;
  }

  markProcessed(message.id);

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need **Manage Server** permission to post the Fast Pass panel.");
    return true;
  }

  if (message.deletable) {
    await message.delete().catch(() => {});
  }

  await message.channel.send({
    embeds: [buildPanelEmbed()],
    components: [buildPanelButton()],
  });

  return true;
}

async function handleInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === BUTTON_CUSTOM_ID) {
    if (isOnCooldown(interaction.user.id)) {
      const cooldownEnd = getCooldownEnd(interaction.user.id);
      await interaction.reply({
        content: `You are on cooldown and cannot apply again until <t:${Math.floor(cooldownEnd / 1000)}:F> (<t:${Math.floor(cooldownEnd / 1000)}:R>).`,
        ephemeral: true,
      });
      return true;
    }

    pendingSessions.set(interaction.user.id, {
      startTime: Date.now(),
      guildId: interaction.guildId,
      stage1: null,
    });

    await interaction.showModal(buildModal("Fast Pass — Part 1", MODAL_STAGE_ONE_ID, STAGE_ONE_FIELDS));
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === MODAL_STAGE_ONE_ID) {
    const session = pendingSessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content: "Your session expired. Please click **Fast Pass** again to restart.",
        ephemeral: true,
      });
      return true;
    }

    session.stage1 = {};
    for (const field of STAGE_ONE_FIELDS) {
      session.stage1[field.id] = interaction.fields.getTextInputValue(field.id);
    }

    await interaction.reply({
      content:
        "Part 1 submitted! Click the red **Continue** button below to open the final questions.\n\n" +
        "Each final answer must be at least **20 words**.",
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${CONTINUE_PREFIX}${interaction.user.id}`)
            .setLabel("Continue")
            .setStyle(ButtonStyle.Danger),
        ),
      ],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith(CONTINUE_PREFIX)) {
    const userId = interaction.customId.slice(CONTINUE_PREFIX.length);
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "This button is not for you.", ephemeral: true });
      return true;
    }

    const session = pendingSessions.get(userId);
    if (!session?.stage1) {
      await interaction.reply({
        content: "Your session expired. Please click **Fast Pass** again to restart.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.showModal(
      buildModal(
        "Fast Pass — Part 2",
        `${MODAL_STAGE_TWO_PREFIX}${userId}`,
        STAGE_TWO_FIELDS,
      ),
    );
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_STAGE_TWO_PREFIX)) {
    const userId = interaction.customId.slice(MODAL_STAGE_TWO_PREFIX.length);
    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "This form is not for you.", ephemeral: true });
      return true;
    }

    const session = pendingSessions.get(userId);
    if (!session?.stage1) {
      await interaction.reply({
        content: "Your session expired. Please click **Fast Pass** again to restart.",
        ephemeral: true,
      });
      return true;
    }

    const stage2 = {};
    const tooShort = [];

    for (const field of STAGE_TWO_FIELDS) {
      const answer = interaction.fields.getTextInputValue(field.id);
      const wordCount = countWords(answer);
      stage2[field.id] = answer;

      if (wordCount < MIN_WORDS) {
        tooShort.push({
          question: field.question,
          wordCount,
        });
      }
    }

    if (tooShort.length > 0) {
      await interaction.reply({
        content:
          `Each answer in Part 2 must be at least **${MIN_WORDS} words**. These answers were too short:\n` +
          tooShort.map(({ question, wordCount }) => `• ${question} — **${wordCount}/${MIN_WORDS} words**`).join("\n") +
          "\n\nClick **Continue** again and resubmit with longer answers.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const endTime = Date.now();
    const durationMs = endTime - session.startTime;
    const appId = `${userId}-${endTime}`;

    const application = {
      appId,
      userId,
      userTag: interaction.user.tag,
      guildId: session.guildId,
      stage1: session.stage1,
      stage2,
      durationMs,
      submittedAt: endTime,
      status: "pending",
    };

    applications.set(appId, application);
    pendingSessions.delete(userId);

    const submissionsChannel = await interaction.client.channels
      .fetch(getSubmissionsChannelId())
      .catch(() => null);

    if (!submissionsChannel?.isTextBased()) {
      applications.delete(appId);
      await interaction.editReply(
        "Your application could not be sent because the submissions channel was not found. Contact an admin.",
      );
      return true;
    }

    const submissionMessage = await submissionsChannel.send({
      embeds: [buildSubmissionEmbed(application)],
      components: [buildReviewButtons(appId)],
    });

    application.messageId = submissionMessage.id;
    application.channelId = submissionChannel.id;

    await interaction.editReply(
      `Your Fast Pass application has been submitted! It took you **${formatDuration(durationMs)}** to complete.`,
    );
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith(ACCEPT_PREFIX)) {
    const appId = interaction.customId.slice(ACCEPT_PREFIX.length);
    const application = getApplication(appId);

    if (!application || application.status !== "pending") {
      await interaction.reply({ content: "This application is no longer pending.", ephemeral: true });
      return true;
    }

    if (!canReviewApplications(interaction.member)) {
      await interaction.reply({
        content: "You need **Manage Roles** or **Manage Server** to review applications.",
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

  if (interaction.isStringSelectMenu() && interaction.customId.startsWith(RANK_SELECT_PREFIX)) {
    const appId = interaction.customId.slice(RANK_SELECT_PREFIX.length);
    const application = getApplication(appId);
    const roleId = interaction.values[0];
    const rank = RANKS.find((r) => r.id === roleId);

    if (!application || application.status !== "pending") {
      await interaction.reply({ content: "This application is no longer pending.", ephemeral: true });
      return true;
    }

    if (!canReviewApplications(interaction.member)) {
      await interaction.reply({
        content: "You need **Manage Roles** or **Manage Server** to review applications.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferUpdate();

    const guild = await interaction.client.guilds.fetch(application.guildId).catch(() => null);
    const member = await guild?.members.fetch(application.userId).catch(() => null);

    if (member && guild) {
      await member.roles.add(roleId).catch((error) => {
        console.error("Failed to assign role:", error);
      });
    }

    application.status = "accepted";
    application.rankLabel = rank?.label ?? "Unknown Rank";
    application.rankId = roleId;
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
            `Congratulations! Your Fast Pass application has been **accepted**.\n\n` +
            `You have been assigned the rank: **${application.rankLabel}**\n\n` +
            `Please read over <#${GUIDE_CHANNEL_ID}> before getting started.`,
        })
        .catch(() => {});
    }

    await interaction.editReply({
      content: `Application accepted. **${application.userTag}** was assigned **${application.rankLabel}**.`,
      components: [],
    });
    return true;
  }

  if (interaction.isButton() && interaction.customId.startsWith(DENY_PREFIX)) {
    const appId = interaction.customId.slice(DENY_PREFIX.length);
    const application = getApplication(appId);

    if (!application || application.status !== "pending") {
      await interaction.reply({ content: "This application is no longer pending.", ephemeral: true });
      return true;
    }

    if (!canReviewApplications(interaction.member)) {
      await interaction.reply({
        content: "You need **Manage Roles** or **Manage Server** to review applications.",
        ephemeral: true,
      });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId(`${MODAL_DENY_PREFIX}${appId}`)
      .setTitle("Deny Application")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("deny_reason")
            .setLabel("Reason for denial")
            .setPlaceholder("Explain why this application was denied...")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000),
        ),
      );

    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(MODAL_DENY_PREFIX)) {
    const appId = interaction.customId.slice(MODAL_DENY_PREFIX.length);
    const application = getApplication(appId);

    if (!application || application.status !== "pending") {
      await interaction.reply({ content: "This application is no longer pending.", ephemeral: true });
      return true;
    }

    if (!canReviewApplications(interaction.member)) {
      await interaction.reply({
        content: "You need **Manage Roles** or **Manage Server** to review applications.",
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
            `Your Fast Pass application has been **denied**.\n\n` +
            `**Reason:** ${denyReason}\n\n` +
            `You may submit a new application after <t:${Math.floor(cooldownEnd / 1000)}:F> (<t:${Math.floor(cooldownEnd / 1000)}:R>).`,
        })
        .catch(() => {});
    }

    await interaction.editReply(`Application denied. **${application.userTag}** was notified and placed on a 4-day cooldown.`);
    return true;
  }

  return false;
}

module.exports = {
  MIN_WORDS,
  handlePanelCommand,
  handleInteraction,
};
