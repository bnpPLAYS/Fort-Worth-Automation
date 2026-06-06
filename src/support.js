const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require("discord.js");
const { buildPanelButton } = require("./quiz");
const { promptInterviewRoleplayName, buildInterviewPanelButton } = require("./interview");
const { getTicket, saveTicket, deleteTicket, resolveOpenTicket } = require("./tickets-store");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { closeTicket } = require("./transcripts");
const { getErrorMessage } = require("./embed-utils");
const { TYPE_SUPERVISOR_EXAM_ID, handleSupervisorExamInteraction } = require("./supervisor-exam");
const { buildV2Payload } = require("./v2-message");
const { HPD_EMOJI } = require("./constants");
const {
  createHpdContainer,
  appendHpdFooter,
  buildHpdComponentsPayload,
} = require("./hpd-components");

const SUPPORT_PANEL_COMMAND = "-supportpanel";

const CONTACT_BUTTON_ID = "support_contact";
const TYPE_QUIZ_ID = "support_type_quiz";
const LEGACY_TYPE_QUIZ_ID = "support_type_fastpass";
const TYPE_INTERVIEW_ID = "support_type_interview";
const TYPE_REPORT_ID = "support_type_report";
const TYPE_OTHER_ID = "support_type_other";
const REPORT_USER_SELECT_ID = "support_report_user";
const REPORT_MODAL_PREFIX = "support_report_modal:";
const STAFF_CLOSE_BUTTON_ID = "staff_close_ticket";
const STAFF_CLOSE_REQUEST_ID = "staff_close_request";
const STAFF_ADVANCE_ID = "staff_ticket_advance";
const STAFF_CLOSE_MODAL_ID = "staff_close_modal";
const TICKET_USER_CLOSE_ID = "ticket_user_close";

const REPORT_CATEGORY_ID = "1485029849855824113";
const OTHER_CATEGORY_ID = "1485029796697342032";
const ADVANCED_CATEGORY_ID = "1485030429848240188";
const STAFF_ROLE_ID = "1484950025472704643";

const pendingReports = new Map();

function sanitizeChannelName(value) {
  const cleaned = value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return (cleaned || "ticket").slice(0, 90);
}

async function uniqueChannelName(guild, baseName) {
  let name = baseName;
  let suffix = 1;

  while (guild.channels.cache.some((channel) => channel.name === name)) {
    name = `${baseName}-${suffix}`;
    suffix += 1;
  }

  return name.slice(0, 100);
}

async function setupTicketChannel(guild, { name, parentId, openerId, reportedUserId, reason }) {
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parentId,
    reason,
  });

  await channel.lockPermissions();

  await channel.permissionOverwrites.edit(openerId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
  });

  if (reportedUserId) {
    await channel.permissionOverwrites.edit(reportedUserId, {
      ViewChannel: false,
    });
  }

  return channel;
}

function isStaff(member) {
  return (
    member?.roles?.cache?.has(STAFF_ROLE_ID) ||
    member?.permissions?.has(PermissionFlagsBits.ManageChannels) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

function truncateField(value) {
  return value.length > 1024 ? value.slice(0, 1021) + "..." : value;
}

function buildInternalAffairsPayload(opener, reportedUser, whatHappened) {
  return buildV2Payload({
    withTicketBanner: true,
    description: `${opener}\n\nThank you for contacting our Internal Affairs Unit, ${opener}. Our support team will be with you shortly. In the mean time, please review the report details below:`,
    title: "Internal Affairs",
    fields: [
      { name: "Reported Member", value: `${reportedUser}` },
      { name: "Submitted By", value: `${opener}` },
      { name: "What Happened", value: truncateField(whatHappened) },
    ],
    allowedMentions: { users: [opener.id] },
  });
}

function buildGeneralSupportPayload(opener) {
  return buildV2Payload({
    withTicketBanner: true,
    description:
      `@here ${opener}\n\nWelcome to your General Support Ticket, ${opener}. Our support team will be with you shortly. ` +
      "In the mean time, please provide as much information about your issue, question, or concern. " +
      "If you have opened the wrong type of ticket by accident, please let us know and we can switch the ticket panel for you. " +
      "Ensure you do not ping any ticket staff as they are volunteers and may have other responsibilities. " +
      "We ask that you remain patient and considerate.",
    title: "General Support",
    allowedMentions: { parse: ["everyone", "users"] },
  });
}

function buildStaffPanelPayload() {
  return buildV2Payload({
    title: "Staff Ticket Panel",
    description:
      "Use the controls below to manage this ticket.\n\n" +
      "• **Close Ticket** — closes the ticket and DMs the opener with your reason\n" +
      "• **Close Request** — asks the opener if the ticket is resolved with a self-close button\n" +
      "• **Ticket Advance** — escalates the ticket to High Command",
    actionRows: [buildStaffPanelButtons()],
    ephemeral: true,
    includeFiles: false,
  });
}

const ASSISTANCE_OPTIONS = [
  {
    emoji: "🎫",
    title: "Other",
    description: "General questions, help, or issues that do not fit another category.",
  },
  {
    emoji: "📝",
    title: "Quiz",
    description: "Start the department quiz / fast-track application.",
  },
  {
    emoji: "🎙️",
    title: "Voice Interview",
    description: "Apply through the voice interview process (join the waiting VC first).",
  },
  {
    emoji: "⚠️",
    title: "Report",
    description: "Report a member or officer to Internal Affairs.",
  },
  {
    emoji: "⭐",
    title: "Supervisor Exam",
    description: "Supervisor promotion exam for eligible personnel.",
  },
];

function buildAssistanceIntroContent() {
  return (
    `## ${HPD_EMOJI} Houston Police Department\n` +
    "### Assistance Hub\n\n" +
    "> **Service with Respect, Dedicated to Protect.**\n\n" +
    "Welcome to the **Assistance Hub**. Click **Contact Support** below, choose the option that fits your request, and follow the prompts.\n\n" +
    "*Please remain patient — ticket staff are volunteers and will respond as soon as they can.*"
  );
}

function buildAssistanceOptionSection(option) {
  return new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `${option.emoji} **${option.title}**\n-# ${option.description}`,
    ),
  );
}

function buildAssistanceHubPayload() {
  const { container, files } = createHpdContainer();

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(buildAssistanceIntroContent()));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("### Available Options"),
  );

  for (const option of ASSISTANCE_OPTIONS) {
    container.addSectionComponents(buildAssistanceOptionSection(option));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addActionRowComponents(buildContactSupportButton());
  appendHpdFooter(container, files);

  return buildHpdComponentsPayload(container, files);
}

function buildContactSupportButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CONTACT_BUTTON_ID)
      .setLabel("Contact Support")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildSupportTypeButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(TYPE_QUIZ_ID)
        .setLabel("Quiz")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(TYPE_INTERVIEW_ID)
        .setLabel("Voice Interview")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(TYPE_REPORT_ID)
        .setLabel("Report")
        .setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(TYPE_OTHER_ID)
        .setLabel("Other")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(TYPE_SUPERVISOR_EXAM_ID)
        .setLabel("Supervisor Exam")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function buildReportUserSelect() {
  return new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId(REPORT_USER_SELECT_ID)
      .setPlaceholder("Select who you are reporting")
      .setMinValues(1)
      .setMaxValues(1),
  );
}

function buildStaffPanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(STAFF_CLOSE_BUTTON_ID)
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(STAFF_CLOSE_REQUEST_ID)
      .setLabel("Close Request")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(STAFF_ADVANCE_ID)
      .setLabel("Ticket Advance")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildUserCloseButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_USER_CLOSE_ID)
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger),
  );
}


async function createReportTicket(interaction, reportedUser, whatHappened) {
  const guild = interaction.guild;
  const opener = interaction.user;
  const existing = await resolveOpenTicket(guild, opener.id, "report");

  if (existing) {
    await interaction.editReply(
      `You already have an open report ticket: <#${existing[0]}>. Please use that ticket or wait for it to be closed.`,
    );
    return;
  }

  const baseName = `${sanitizeChannelName(reportedUser.username)}-report`;
  const channelName = await uniqueChannelName(guild, baseName);

  const channel = await setupTicketChannel(guild, {
    name: channelName,
    parentId: REPORT_CATEGORY_ID,
    openerId: opener.id,
    reportedUserId: reportedUser.id,
    reason: `Report ticket opened by ${opener.tag}`,
  });

  saveTicket(channel.id, {
    type: "report",
    openerId: opener.id,
    openerTag: opener.tag,
    reportedUserId: reportedUser.id,
    reportedUserTag: reportedUser.tag,
    whatHappened,
    awaitingResponse: true,
    createdAt: Date.now(),
    closed: false,
  });

  await channel.send(buildInternalAffairsPayload(opener, reportedUser, whatHappened));
  await channel.send(
    "Please **link any clips or evidence** you have regarding this incident. Staff will be notified once you send a message in this channel.",
  );

  await interaction.editReply(`Your report ticket has been opened: ${channel}`);
}

async function createOtherTicket(interaction) {
  const guild = interaction.guild;
  const opener = interaction.member;
  const existing = await resolveOpenTicket(guild, opener.id, "other");

  if (existing) {
    await interaction.editReply(
      `You already have an open support ticket: <#${existing[0]}>. Please use that ticket or wait for it to be closed.`,
    );
    return;
  }

  const displayName = opener.displayName || opener.user.username;
  const baseName = `${sanitizeChannelName(displayName)}-support`;
  const channelName = await uniqueChannelName(guild, baseName);

  const channel = await setupTicketChannel(guild, {
    name: channelName,
    parentId: OTHER_CATEGORY_ID,
    openerId: opener.id,
    reason: `Support ticket opened by ${opener.user.tag}`,
  });

  saveTicket(channel.id, {
    type: "other",
    openerId: opener.id,
    openerTag: opener.user.tag,
    awaitingResponse: false,
    createdAt: Date.now(),
    closed: false,
  });

  await channel.send(buildGeneralSupportPayload(opener));

  await interaction.editReply(`Your support ticket has been opened: ${channel}`);
}

async function handleSupportPanelCommand(message) {
  if (message.content.trim().toLowerCase() !== SUPPORT_PANEL_COMMAND) return false;
  if (message.author.bot) return false;

  if (hasProcessed(`panel:${message.id}`)) return true;
  markProcessed(`panel:${message.id}`);

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need **Manage Server** permission to post the Assistance Hub.");
    return true;
  }

  if (message.deletable) {
    await message.delete().catch(() => {});
  }

  try {
    await message.channel.send(buildAssistanceHubPayload());
  } catch (error) {
    console.error("Assistance hub panel failed:", error);
    await message.channel
      .send(`Failed to post the Assistance Hub: ${getErrorMessage(error)}`)
      .catch(() => null);
  }

  return true;
}

async function handleStaffPanelCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "staffpanel") {
    return false;
  }

  const ticket = getTicket(interaction.channelId);
  if (!ticket || ticket.closed) {
    await interaction.reply({
      content: "This command can only be used inside an active support ticket channel.",
      ephemeral: true,
    });
    return true;
  }

  if (!isStaff(interaction.member)) {
    await interaction.reply({
      content: "You do not have permission to use the staff ticket panel.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.reply(buildStaffPanelPayload());

  return true;
}

async function handleSupportInteraction(interaction) {
  const examHandled = await handleSupervisorExamInteraction(interaction);
  if (examHandled) return true;

  if (interaction.isButton() && interaction.customId === CONTACT_BUTTON_ID) {
    await interaction.reply({
      content: "Select the type of support you need:",
      components: buildSupportTypeButtons(),
      ephemeral: true,
    });
    return true;
  }

  if (
    interaction.isButton() &&
    (interaction.customId === TYPE_QUIZ_ID || interaction.customId === LEGACY_TYPE_QUIZ_ID)
  ) {
    await interaction.update({
      content:
        "## Quiz Application\n\nUse the **Quiz** button below to begin your application.",
      embeds: [],
      components: [buildPanelButton()],
    });
    return true;
  }

  if (interaction.isButton() && interaction.customId === TYPE_INTERVIEW_ID) {
    if (!interaction.guild) {
      await interaction.update({
        content: "Voice interviews can only be started in a server.",
        embeds: [],
        components: [],
      });
      return true;
    }

    const member = interaction.member;
    if (!member) {
      await interaction.update({
        content: "Could not resolve your server membership.",
        embeds: [],
        components: [],
      });
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
      await interaction
        .update({
          content: error.message ?? "Could not start the voice interview.",
          embeds: [],
          components: [buildInterviewPanelButton()],
        })
        .catch(() =>
          interaction.reply({
            content: error.message ?? "Could not start the voice interview.",
            ephemeral: true,
          }),
        );
    }

    return true;
  }

  if (interaction.isButton() && interaction.customId === TYPE_REPORT_ID) {
    await interaction.update({
      content: "Select the member you are reporting:",
      embeds: [],
      components: [buildReportUserSelect()],
    });
    return true;
  }

  if (interaction.isButton() && interaction.customId === TYPE_OTHER_ID) {
    await interaction.deferReply({ ephemeral: true });
    await createOtherTicket(interaction);
    return true;
  }

  if (interaction.isUserSelectMenu() && interaction.customId === REPORT_USER_SELECT_ID) {
    const reportedUserId = interaction.values[0];
    const reportedMember = await interaction.guild.members.fetch(reportedUserId).catch(() => null);

    if (!reportedMember) {
      await interaction.update({
        content: "That member could not be found. Please try again.",
        components: [],
      });
      return true;
    }

    pendingReports.set(interaction.user.id, {
      reportedUserId: reportedMember.id,
      reportedUserTag: reportedMember.user.tag,
    });

    const modal = new ModalBuilder()
      .setCustomId(`${REPORT_MODAL_PREFIX}${reportedMember.id}`)
      .setTitle("Officer Report")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("what_happened")
            .setLabel("What happened?")
            .setPlaceholder("Describe the incident in detail...")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(4000),
        ),
      );

    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId.startsWith(REPORT_MODAL_PREFIX)) {
    const reportedUserId = interaction.customId.slice(REPORT_MODAL_PREFIX.length);
    const whatHappened = interaction.fields.getTextInputValue("what_happened");
    const pending = pendingReports.get(interaction.user.id);

    if (!pending || pending.reportedUserId !== reportedUserId) {
      await interaction.reply({
        content: "Your report session expired. Please start again from **Contact Support**.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });
    pendingReports.delete(interaction.user.id);

    const reportedUser = await interaction.client.users.fetch(reportedUserId).catch(() => null);
    if (!reportedUser) {
      await interaction.editReply("The reported member could not be found. Please try again.");
      return true;
    }

    await createReportTicket(interaction, reportedUser, whatHappened);
    return true;
  }

  if (interaction.isButton() && interaction.customId === STAFF_CLOSE_BUTTON_ID) {
    const ticket = getTicket(interaction.channelId);
    if (!ticket || ticket.closed) {
      await interaction.reply({ content: "This is not an active ticket channel.", ephemeral: true });
      return true;
    }

    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: "You do not have permission to close tickets.", ephemeral: true });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId(STAFF_CLOSE_MODAL_ID)
      .setTitle("Close Ticket")
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("close_reason")
            .setLabel("Reason for closing")
            .setPlaceholder("This reason will be sent to the ticket opener via DM...")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMaxLength(1000),
        ),
      );

    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === STAFF_CLOSE_MODAL_ID) {
    const ticket = getTicket(interaction.channelId);
    if (!ticket || ticket.closed) {
      await interaction.reply({ content: "This is not an active ticket channel.", ephemeral: true });
      return true;
    }

    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: "You do not have permission to close tickets.", ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const reason = interaction.fields.getTextInputValue("close_reason");
    const channel = interaction.channel;

    await channel.send(
      `Ticket closed by ${interaction.user}. Reason sent to the ticket opener via DM. This channel will be deleted shortly.`,
    );

    await interaction.editReply("Ticket closed successfully.");

    setTimeout(async () => {
      await closeTicket(interaction.client, channel, ticket, {
        closedBy: interaction.user.tag,
        reason,
      });
    }, 5000);

    return true;
  }

  if (interaction.isButton() && interaction.customId === TICKET_USER_CLOSE_ID) {
    const ticket = getTicket(interaction.channelId);
    if (!ticket || ticket.closed) {
      await interaction.reply({ content: "This ticket is no longer active.", ephemeral: true });
      return true;
    }

    if (interaction.user.id !== ticket.openerId) {
      await interaction.reply({
        content: "Only the person who opened this ticket can close it with this button.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply("Closing your ticket...");

    const channel = interaction.channel;
    await channel.send(`${interaction.user} closed this ticket. Saving transcript...`);

    setTimeout(async () => {
      await closeTicket(interaction.client, channel, ticket, {
        closedBy: interaction.user.tag,
        closedByUserId: interaction.user.id,
      });
    }, 3000);

    return true;
  }

  if (interaction.isButton() && interaction.customId === STAFF_CLOSE_REQUEST_ID) {
    const ticket = getTicket(interaction.channelId);
    if (!ticket || ticket.closed) {
      await interaction.reply({ content: "This is not an active ticket channel.", ephemeral: true });
      return true;
    }

    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: "You do not have permission to manage tickets.", ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    await interaction.channel.send({
      content:
        `<@${ticket.openerId}> Is this ticket resolved? If you no longer need assistance, you can close it using the button below.`,
      components: [buildUserCloseButton()],
      allowedMentions: { users: [ticket.openerId] },
    });

    await interaction.editReply("Close request sent.");
    return true;
  }

  if (interaction.isButton() && interaction.customId === STAFF_ADVANCE_ID) {
    const ticket = getTicket(interaction.channelId);
    if (!ticket || ticket.closed) {
      await interaction.reply({ content: "This is not an active ticket channel.", ephemeral: true });
      return true;
    }

    if (!isStaff(interaction.member)) {
      await interaction.reply({ content: "You do not have permission to manage tickets.", ephemeral: true });
      return true;
    }

    await interaction.deferReply();

    await interaction.channel.setParent(ADVANCED_CATEGORY_ID, {
      lockPermissions: false,
      sync: true,
    });

    ticket.advanced = true;
    saveTicket(interaction.channelId, ticket);

    await interaction.channel.send({
      content: `<@&${STAFF_ROLE_ID}> This ticket has been escalated to High Command by ${interaction.user}.`,
      allowedMentions: { roles: [STAFF_ROLE_ID] },
    });

    await interaction.editReply("Ticket advanced to High Command.");
    return true;
  }

  return false;
}

async function handleSupportMessage(message) {
  if (message.author.bot || !message.guild) return false;

  const ticket = getTicket(message.channel.id);
  if (!ticket || ticket.closed || !ticket.awaitingResponse) return false;

  if (message.author.id !== ticket.openerId) return false;

  ticket.awaitingResponse = false;
  saveTicket(message.channel.id, ticket);

  await message.channel.send({
    content: "@here",
    allowedMentions: { parse: ["everyone"] },
  });

  return true;
}

module.exports = {
  handleSupportPanelCommand,
  handleStaffPanelCommand,
  handleSupportInteraction,
  handleSupportMessage,
};
