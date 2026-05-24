const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require("discord.js");
const { buildPanelEmbed, buildPanelButton } = require("./fastpass");
const { getTicket, saveTicket, deleteTicket, findOpenTicketByOpener } = require("./tickets-store");
const { hasProcessed, markProcessed } = require("./panel-dedupe");

const SUPPORT_PANEL_COMMAND = "-supportpanel";

const CONTACT_BUTTON_ID = "support_contact";
const TYPE_SELECT_ID = "support_type_select";
const REPORT_USER_SELECT_ID = "support_report_user";
const REPORT_MODAL_PREFIX = "support_report_modal:";
const STAFF_CLOSE_BUTTON_ID = "staff_close_ticket";
const STAFF_CLOSE_REQUEST_ID = "staff_close_request";
const STAFF_ADVANCE_ID = "staff_ticket_advance";
const STAFF_CLOSE_MODAL_ID = "staff_close_modal";

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

function buildTicketPermissions(guild, openerId) {
  return [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: openerId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: STAFF_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];
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

function buildAssistanceHubEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Assistance Hub")
    .setDescription(
      "**General Support**\n" +
        "• Discord Inquiries\n" +
        "• General Support\n\n" +
        "**Professional Standards Division**\n" +
        "• Officer Reports\n" +
        "• Appealing Infractions\n\n" +
        "**High Command**\n" +
        "• Major concerns\n" +
        "• Supervisory+ Reporting\n" +
        "• Fast Passes\n\n" +
        "_Property of: Texas State Roleplay | Fort Worth Police Department_",
    )
    .setFooter({ text: "Fort Worth Police Department" });
}

function buildContactSupportButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CONTACT_BUTTON_ID)
      .setLabel("Contact Support")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildSupportTypeSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(TYPE_SELECT_ID)
      .setPlaceholder("Choose a support type")
      .addOptions(
        {
          label: "FastPass",
          value: "fastpass",
          description: "Apply for a department Fast Pass",
        },
        {
          label: "Report",
          value: "report",
          description: "Report a member or officer",
        },
        {
          label: "Other",
          value: "other",
          description: "Open a general support ticket",
        },
      ),
  );
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

function buildInternalAffairsEmbed(opener, reportedUser, whatHappened) {
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("Internal Affairs")
    .setDescription(
      `Thank you for contacting our Internal Affairs Unit, ${opener}. Our support team will be with you shortly. ` +
        "In the mean time, please review the report details below:",
    )
    .addFields(
      { name: "Reported Member", value: `${reportedUser}`, inline: true },
      { name: "Submitted By", value: `${opener}`, inline: true },
      { name: "What Happened", value: truncateField(whatHappened) },
    );
}

function buildGeneralSupportEmbed(opener) {
  return new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle("General Support")
    .setDescription(
      `Welcome to your General Support Ticket, ${opener}. Our support team will be with you shortly. ` +
        "In the mean time, please provide as much information about your issue, question, or concern. " +
        "If you have opened the wrong type of ticket by accident, please let us know and we can switch the ticket panel for you. " +
        "Ensure you do not ping any ticket staff as they are volunteers and may have other responsibilities. " +
        "We ask that you remain patient and considerate.",
    );
}

function buildStaffPanelEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Staff Ticket Panel")
    .setDescription(
      "Use the controls below to manage this ticket.\n\n" +
        "• **Close Ticket** — closes the ticket and DMs the opener with your reason\n" +
        "• **Close Request** — asks the opener if the ticket is resolved\n" +
        "• **Ticket Advance** — escalates the ticket to High Command",
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

async function createReportTicket(interaction, reportedUser, whatHappened) {
  const guild = interaction.guild;
  const opener = interaction.user;
  const existing = findOpenTicketByOpener(opener.id, "report");

  if (existing) {
    await interaction.editReply(
      `You already have an open report ticket: <#${existing[0]}>. Please use that ticket or wait for it to be closed.`,
    );
    return;
  }

  const baseName = `${sanitizeChannelName(reportedUser.username)}-report`;
  const channelName = await uniqueChannelName(guild, baseName);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: REPORT_CATEGORY_ID,
    permissionOverwrites: buildTicketPermissions(guild, opener.id),
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

  await channel.send({
    content: `${opener}`,
    embeds: [buildInternalAffairsEmbed(opener, reportedUser, whatHappened)],
  });
  await channel.send(
    "Please **link any clips or evidence** you have regarding this incident. Staff will be notified once you send a message in this channel.",
  );

  await interaction.editReply(`Your report ticket has been opened: ${channel}`);
}

async function createOtherTicket(interaction) {
  const guild = interaction.guild;
  const opener = interaction.member;
  const existing = findOpenTicketByOpener(opener.id, "other");

  if (existing) {
    await interaction.editReply(
      `You already have an open support ticket: <#${existing[0]}>. Please use that ticket or wait for it to be closed.`,
    );
    return;
  }

  const displayName = opener.displayName || opener.user.username;
  const baseName = `${sanitizeChannelName(displayName)}-support`;
  const channelName = await uniqueChannelName(guild, baseName);

  const channel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: OTHER_CATEGORY_ID,
    permissionOverwrites: buildTicketPermissions(guild, opener.id),
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

  await channel.send({
    content: `@here ${opener}`,
    embeds: [buildGeneralSupportEmbed(opener)],
    allowedMentions: { parse: ["everyone", "users"] },
  });

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

  await message.channel.send({
    embeds: [buildAssistanceHubEmbed()],
    components: [buildContactSupportButton()],
  });

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

  await interaction.reply({
    embeds: [buildStaffPanelEmbed()],
    components: [buildStaffPanelButtons()],
  });

  return true;
}

async function handleSupportInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === CONTACT_BUTTON_ID) {
    await interaction.reply({
      content: "Select the type of support you need:",
      components: [buildSupportTypeSelect()],
      ephemeral: true,
    });
    return true;
  }

  if (interaction.isStringSelectMenu() && interaction.customId === TYPE_SELECT_ID) {
    const choice = interaction.values[0];

    if (choice === "fastpass") {
      await interaction.update({
        content: "Use the Fast Pass panel below to begin your application:",
        embeds: [buildPanelEmbed()],
        components: [buildPanelButton()],
      });
      return true;
    }

    if (choice === "report") {
      await interaction.update({
        content: "Select the member you are reporting:",
        components: [buildReportUserSelect()],
      });
      return true;
    }

    if (choice === "other") {
      await interaction.deferReply({ ephemeral: true });
      await createOtherTicket(interaction);
      return true;
    }
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
    ticket.closed = true;
    saveTicket(interaction.channelId, ticket);

    const opener = await interaction.client.users.fetch(ticket.openerId).catch(() => null);
    if (opener) {
      await opener
        .send({
          content:
            `Your **${ticket.type === "report" ? "report" : "support"}** ticket has been closed.\n\n` +
            `**Reason:** ${reason}`,
        })
        .catch(() => {});
    }

    await interaction.channel.send(
      `Ticket closed by ${interaction.user}. Reason sent to the ticket opener via DM. This channel will be deleted shortly.`,
    );

    await interaction.editReply("Ticket closed successfully.");

    setTimeout(async () => {
      deleteTicket(interaction.channelId);
      await interaction.channel.delete().catch(() => {});
    }, 5000);

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

    await interaction.reply({
      content: `<@${ticket.openerId}> Is this ticket resolved? Please let staff know if you need anything else before we close it.`,
      allowedMentions: { users: [ticket.openerId] },
    });

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
