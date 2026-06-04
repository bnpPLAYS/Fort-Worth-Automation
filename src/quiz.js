const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require("discord.js");
const { getCooldownEnd, isOnCooldown, setCooldown } = require("./cooldowns");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { STAFF_PING_ROLE_ID, BOT_NAME } = require("./constants");
const { buildV2Payload, buildV2EditPayload } = require("./v2-message");
const { extractCallsignFromDisplayName } = require("./discord-callsign");
const { formatRoleplayInitials } = require("./roleplay-name");
const { isSheetsConfigured, isSheetsQuotaError } = require("./google-sheets/client");
const { completeMemberRosterSetup } = require("./roster-onboarding");
const {
  getQuizApplication,
  saveQuizApplication,
  deleteQuizApplication,
  listQuizApplications,
} = require("./quiz-applications-store");
const { logRosterAudit } = require("./roster-audit-log");
const {
  isBlockedFromRecruitmentFlows,
  RECRUITMENT_BLOCKED_MESSAGE,
} = require("./member-roster");

const PANEL_COMMAND = "-panelquiz";
const LEGACY_PANEL_COMMAND = "-panelfastpass";
const BUTTON_CUSTOM_ID = "quiz_apply";
const LEGACY_BUTTON_CUSTOM_ID = "fastpass_apply";
const MODAL_STAGE_ONE_ID = "quiz_modal_stage1";
const MODAL_DENY_PREFIX = "quiz_deny_modal:";
const CONTINUE_PREFIX = "quiz_continue:";
const MODAL_STAGE_TWO_PREFIX = "quiz_modal_stage2:";
const ACCEPT_PREFIX = "quiz_accept:";
const DENY_PREFIX = "quiz_deny:";
const RANK_SELECT_PREFIX = "quiz_rank:";

const MIN_WORDS = 20;
const GUIDE_CHANNEL_ID = "1484990957299564666";
function getQuizPanelChannelId() {
  return (
    process.env.QUIZ_PANEL_CHANNEL_ID ||
    process.env.FASTPASS_PANEL_CHANNEL_ID ||
    "1484948609546846290"
  );
}

const STAGE_ONE_FIELDS = [
  {
    id: "roleplay_name",
    label: "Full roleplay name?",
    question: "Roleplay Name",
    placeholder: "e.g. John Smith",
    style: "short",
    maxLength: 64,
  },
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

const {
  RANK_OPTIONS,
  resolveAssignmentRoleIds,
  assignRankRolesToMember,
} = require("./rank-options");

const RANKS = RANK_OPTIONS.filter((rank) => !rank.useCadetCallsign).map((rank) => ({
  id: rank.id,
  label: rank.label,
}));

const pendingSessions = new Map();
const applications = new Map();

function getSubmissionsChannelId() {
  return (
    process.env.QUIZ_SUBMISSIONS_CHANNEL_ID ||
    process.env.FASTPASS_SUBMISSIONS_CHANNEL_ID ||
    "1498803252626718833"
  );
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
          .setStyle(field.style === "short" ? TextInputStyle.Short : TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(field.maxLength ?? 4000),
      ),
    );
  }

  return modal;
}

function buildPanelPayload() {
  return buildV2Payload({
    title: "Quiz Application",
    description:
      "Click **Quiz** below to begin your application.\n\n" +
      "You will enter your **full roleplay name** first (e.g. John Smith → roster name **J. Smith**).\n\n" +
      "The second part requires detailed answers of at least 20 words each.",
    footer: BOT_NAME,
    actionRows: [buildPanelButton()],
  });
}

function buildSubmissionPayload(application, { actionRows = [], forEdit = false } = {}) {
  const {
    userId,
    userTag,
    stage1,
    stage2,
    durationMs,
    status,
    reviewerTag,
    rankLabel,
    denyReason,
    roleplayName,
    roleplayNameRaw,
    submittedAt,
  } = application;

  const title =
    status === "accepted"
      ? "Quiz Application — Accepted"
      : status === "denied"
        ? "Quiz Application — Denied"
        : "New Quiz Application";

  const fields = [
    {
      name: "Completion Time",
      value: formatDuration(durationMs),
    },
  ];

  if (roleplayName) {
    fields.push({
      name: "Roster Name",
      value: roleplayNameRaw ? `${roleplayName} *(from ${roleplayNameRaw})*` : roleplayName,
    });
  }

  for (const field of STAGE_ONE_FIELDS) {
    if (field.id === "roleplay_name") continue;
    fields.push({
      name: field.question,
      value: truncateField(stage1[field.id]),
    });
  }

  for (const field of STAGE_TWO_FIELDS) {
    fields.push({
      name: field.question,
      value: truncateField(stage2[field.id]),
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

function buildPanelButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(BUTTON_CUSTOM_ID)
      .setLabel("Quiz")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildSubmissionEmbed(application) {
  return buildSubmissionPayload(application);
}

function buildPanelEmbed() {
  return buildPanelPayload();
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

function persistApplication(application) {
  if (!application?.appId) return;
  applications.set(application.appId, application);
  saveQuizApplication(application);
}

function getApplication(appId) {
  if (applications.has(appId)) {
    return applications.get(appId);
  }

  const stored = getQuizApplication(appId);
  if (stored) {
    applications.set(appId, stored);
  }
  return stored ?? null;
}

async function restoreQuizApplications(client) {
  for (const application of listQuizApplications({ status: "pending" })) {
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
      console.warn(`[quiz] Could not restore submission ${application.appId}:`, error.message);
    }
  }

  const pendingCount = listQuizApplications({ status: "pending" }).length;
  if (pendingCount > 0) {
    console.log(`[quiz] Restored ${pendingCount} pending application(s).`);
  }
}

async function handlePanelCommand(message) {
  const command = message.content.trim().toLowerCase();
  if (command !== PANEL_COMMAND && command !== LEGACY_PANEL_COMMAND) return false;
  if (message.author.bot) return false;

  if (hasProcessed(`panel:${message.id}`)) {
    return true;
  }

  markProcessed(`panel:${message.id}`);

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need **Manage Server** permission to post the Quiz panel.");
    return true;
  }

  if (message.deletable) {
    await message.delete().catch(() => {});
  }

  const panelChannel = await message.client.channels.fetch(getQuizPanelChannelId()).catch(() => null);

  if (!panelChannel?.isTextBased()) {
    await message.channel.send(
      "The Quiz panel channel could not be found. Check the bot configuration.",
    );
    return true;
  }

  await panelChannel.send(buildPanelPayload());

  return true;
}

async function handleInteraction(interaction) {
  const dedupeKey = `interaction:${interaction.id}`;
  if (hasProcessed(dedupeKey)) {
    return true;
  }
  markProcessed(dedupeKey);

  if (
    interaction.isButton() &&
    (interaction.customId === BUTTON_CUSTOM_ID || interaction.customId === LEGACY_BUTTON_CUSTOM_ID)
  ) {
    if (isBlockedFromRecruitmentFlows(interaction.member)) {
      await interaction.reply({ content: RECRUITMENT_BLOCKED_MESSAGE, ephemeral: true });
      return true;
    }

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

    await interaction.showModal(buildModal("Quiz — Part 1", MODAL_STAGE_ONE_ID, STAGE_ONE_FIELDS));
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === MODAL_STAGE_ONE_ID) {
    if (isBlockedFromRecruitmentFlows(interaction.member)) {
      await interaction.reply({ content: RECRUITMENT_BLOCKED_MESSAGE, ephemeral: true });
      return true;
    }

    const session = pendingSessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({
        content: "Your session expired. Please click **Quiz** again to restart.",
        ephemeral: true,
      });
      return true;
    }

    session.stage1 = {};
    try {
      const rawRoleplayName = interaction.fields.getTextInputValue("roleplay_name");
      session.roleplayNameRaw = rawRoleplayName.trim();
      session.roleplayName = formatRoleplayInitials(rawRoleplayName);
    } catch (error) {
      pendingSessions.delete(interaction.user.id);
      await interaction.reply({ content: error.message, ephemeral: true });
      return true;
    }

    for (const field of STAGE_ONE_FIELDS) {
      if (field.id === "roleplay_name") continue;
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
        content: "Your session expired. Please click **Quiz** again to restart.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.showModal(
      buildModal(
        "Quiz — Part 2",
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

    if (isBlockedFromRecruitmentFlows(interaction.member)) {
      await interaction.reply({ content: RECRUITMENT_BLOCKED_MESSAGE, ephemeral: true });
      pendingSessions.delete(userId);
      return true;
    }

    const session = pendingSessions.get(userId);
    if (!session?.stage1) {
      await interaction.reply({
        content: "Your session expired. Please click **Quiz** again to restart.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
      await interaction.editReply({
        content:
          `Each answer in Part 2 must be at least **${MIN_WORDS} words**. These answers were too short:\n` +
          tooShort.map(({ question, wordCount }) => `• ${question} — **${wordCount}/${MIN_WORDS} words**`).join("\n") +
          "\n\nClick **Continue** again and resubmit with longer answers.",
      });
      return true;
    }

    const endTime = Date.now();
    const durationMs = endTime - session.startTime;
    const appId = `${userId}-${endTime}`;

    const application = {
      appId,
      userId,
      userTag: interaction.user.tag,
      guildId: session.guildId,
      roleplayName: session.roleplayName,
      roleplayNameRaw: session.roleplayNameRaw,
      stage1: session.stage1,
      stage2,
      durationMs,
      submittedAt: endTime,
      status: "pending",
    };

    persistApplication(application);
    pendingSessions.delete(userId);

    const submissionsChannel = await interaction.client.channels
      .fetch(getSubmissionsChannelId())
      .catch(() => null);

    if (!submissionsChannel?.isTextBased()) {
      deleteQuizApplication(appId);
      applications.delete(appId);
      await interaction.editReply(
        "Your application could not be sent because the submissions channel was not found. Contact an admin.",
      );
      return true;
    }

    let submissionMessage;
    try {
      submissionMessage = await submissionsChannel.send(
        buildSubmissionPayload(application, { actionRows: [buildReviewButtons(appId)] }),
      );
    } catch (sendError) {
      deleteQuizApplication(appId);
      applications.delete(appId);
      console.error("Failed to send Quiz submission:", sendError);
      await interaction.editReply(
        "Your application could not be sent due to a Discord error. Contact an admin.",
      );
      return true;
    }

    application.messageId = submissionMessage.id;
    application.channelId = submissionsChannel.id;
    persistApplication(application);

    try {
      await interaction.editReply(
        `Your Quiz application has been submitted! It took you **${formatDuration(durationMs)}** to complete.`,
      );
    } catch (editError) {
      console.warn("Application submitted, but success reply failed:", editError.message);
    }

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
    const rankValue = interaction.values[0];
    const rank = RANKS.find((entry) => entry.id === rankValue);

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
    const rankLabel = rank?.label ?? "Unknown Rank";
    const { sheetRank, discordRoleIds } = await resolveAssignmentRoleIds(guild, rankValue);

    let roleSummary = "";
    if (member && guild) {
      const roleResult = await assignRankRolesToMember(member, rankValue, "Quiz accepted");
      if (roleResult.error) {
        roleSummary = `\nDiscord roles: assignment failed (${roleResult.error}).`;
      } else if (roleResult.added.length === 0) {
        roleSummary = "\nDiscord roles: member already had the assigned rank roles.";
      }
    }

    let rosterSummary = "";
    let rosterResult = null;
    if (member && isSheetsConfigured() && application.roleplayName) {
      const roleplayName = application.roleplayName;

      try {
        const setup = await completeMemberRosterSetup(member, {
          roleplayName,
          sheetRank,
          reason: "Quiz accepted",
          dmTitle: "Congratulations! Your Quiz application has been **accepted**.",
          dmExtraLines: [`Please read over <#${GUIDE_CHANNEL_ID}> before getting started.`],
          audit: {
            client: interaction.client,
            actor: interaction.member,
            trigger: "Quiz accepted",
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
        console.error("Quiz roster assignment failed:", error);
        rosterSummary = isSheetsQuotaError(error)
          ? "\nRoster assignment failed: Google Sheets read quota was exceeded. Discord roles were still assigned — wait about a minute, then staff can run `/rosteradd` to finish the sheet row."
          : `\nRoster assignment failed: ${error.message}`;
      }
    }

    application.status = "accepted";
    application.rankLabel = rankLabel;
    application.rankId = discordRoleIds[0] ?? rankValue;
    application.reviewerTag = interaction.user.tag;
    persistApplication(application);

    await logRosterAudit(interaction.client, application.guildId, {
      title: "Quiz application accepted",
      actor: interaction.member,
      target: member,
      roleplayName: application.roleplayName,
      rank: rankLabel,
      trigger: "Quiz review",
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
          `Congratulations! Your Quiz application has been **accepted**.\n\n` +
          `You have been assigned the rank: **${application.rankLabel}**\n\n` +
          `Please read over <#${GUIDE_CHANNEL_ID}> before getting started.`;

        if (rosterSummary.includes("Roster assignment failed")) {
          dmContent +=
            "\n\nYour roster callsign could not be assigned automatically. Contact staff to be added to the database.";
        }

        await applicant.send({ content: dmContent }).catch(() => {});
      }
    }

    await interaction.editReply({
      content:
        `Application accepted. **${application.userTag}** was assigned **${application.rankLabel}**.${roleSummary}${rosterSummary}`,
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
    persistApplication(application);

    await logRosterAudit(interaction.client, application.guildId, {
      title: "Quiz application denied",
      actor: interaction.member,
      target: await interaction.client.users.fetch(application.userId).catch(() => null),
      roleplayName: application.roleplayName,
      trigger: "Quiz review",
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
            `Your Quiz application has been **denied**.\n\n` +
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
  BUTTON_CUSTOM_ID,
  LEGACY_BUTTON_CUSTOM_ID,
  buildPanelEmbed,
  buildPanelPayload,
  buildPanelButton,
  handlePanelCommand,
  handleInteraction,
  restoreQuizApplications,
};
