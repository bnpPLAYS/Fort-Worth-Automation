const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SeparatorBuilder,
  TextDisplayBuilder,
} = require("discord.js");
const { STAFF_PING_ROLE_ID, ROSTER_SYNC_ROLE_ID } = require("./constants");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { getErrorMessage } = require("./embed-utils");
const {
  createHpdContainer,
  appendHpdFooter,
  buildHpdComponentsPayload,
} = require("./hpd-components");
const { saveMassShift, addResponder, getMassShift } = require("./mass-shift-store");

const MASS_SHIFT_COMMAND = "-massshift";
const RESPOND_BUTTON_ID = "mass_shift_respond";

function canRunMassShift(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  return member?.roles?.cache?.has(STAFF_PING_ROLE_ID) ?? false;
}

function formatShiftTime(date = new Date()) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Chicago",
  });
}

function formatShiftFooterTime(date = new Date()) {
  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Chicago",
  });
}

function buildRespondersBlock(responders) {
  if (!responders?.length) {
    return "**Responders**\n*No responses yet.*";
  }

  const lines = responders.map((entry, index) => `${index + 1}. ${entry.name}`);
  return `**Responders (${responders.length})**\n${lines.join("\n")}`;
}

function buildMassShiftBody(startedAt, responders, { includePing = false } = {}) {
  const timeLabel = formatShiftTime(new Date(startedAt));
  const footerTime = formatShiftFooterTime(new Date(startedAt));
  const pingLine = includePing ? `<@&${ROSTER_SYNC_ROLE_ID}>\n\n` : "";

  return (
    pingLine +
    "## Mass Shift\n\n" +
    `A *mass shift* is now in effect, as of \`${timeLabel}\`. All online **Houston Police Officers** are required to get in-game!\n\n` +
    "### 📋 Steps\n" +
    "Make sure you:\n" +
    "- Have the correct vehicle preset\n" +
    "- Have the correct uniform\n" +
    "- Have the correct utilities\n" +
    "- Are following department procedures\n\n" +
    "Failure to abide by the **Mass Shift** guidelines may result in a dismissal from duty, or further administrative action.\n\n" +
    `${buildRespondersBlock(responders)}\n\n` +
    `— *Houston Police Department • ${footerTime}*`
  );
}

function buildRespondButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(RESPOND_BUTTON_ID)
      .setLabel("Respond")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildMassShiftContainer(shift, { includePing = false } = {}) {
  const { container, files } = createHpdContainer();

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      buildMassShiftBody(shift.startedAt, shift.responders, { includePing }),
    ),
  );
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addActionRowComponents(buildRespondButtonRow());
  appendHpdFooter(container, files);

  return { container, files };
}

function buildMassShiftPayload(shift) {
  const { container, files } = buildMassShiftContainer(shift, { includePing: true });
  return {
    allowedMentions: { roles: [ROSTER_SYNC_ROLE_ID] },
    ...buildHpdComponentsPayload(container, files),
  };
}

function buildMassShiftEditPayload(shift) {
  const { container, files } = buildMassShiftContainer(shift);
  return buildHpdComponentsPayload(container, files);
}

async function handleMassShiftCommand(message) {
  if (message.content.trim().toLowerCase() !== MASS_SHIFT_COMMAND) return false;
  if (message.author.bot) return false;

  if (hasProcessed(`panel:${message.id}`)) return true;

  if (!canRunMassShift(message.member)) {
    await message.reply("You do not have permission to run this command.");
    return true;
  }

  try {
    if (message.deletable) {
      await message.delete().catch(() => {});
    }

    const startedAt = new Date().toISOString();
    const shift = {
      startedAt,
      startedById: message.author.id,
      channelId: message.channel.id,
      responders: [],
    };

    const sent = await message.channel.send(buildMassShiftPayload(shift));

    saveMassShift(sent.id, shift);
    markProcessed(`panel:${message.id}`);
  } catch (error) {
    console.error("Mass shift command failed:", error);
    await message.channel
      .send(`Failed to post mass shift: ${getErrorMessage(error)}`)
      .catch(() => null);
  }

  return true;
}

async function handleMassShiftInteraction(interaction) {
  if (!interaction.isButton() || interaction.customId !== RESPOND_BUTTON_ID) {
    return false;
  }

  const shift = getMassShift(interaction.message.id);
  if (!shift) {
    await interaction.reply({
      content: "This mass shift is no longer active.",
      ephemeral: true,
    });
    return true;
  }

  if (!interaction.member?.roles?.cache?.has(ROSTER_SYNC_ROLE_ID)) {
    await interaction.reply({
      content: "Only department personnel can respond to a mass shift.",
      ephemeral: true,
    });
    return true;
  }

  const result = addResponder(interaction.message.id, interaction.member);

  if (!result.ok && result.reason?.includes("already")) {
    await interaction.reply({ content: result.reason, ephemeral: true });
    return true;
  }

  if (!result.ok) {
    await interaction.reply({ content: result.reason, ephemeral: true });
    return true;
  }

  try {
    await interaction.message.edit(buildMassShiftEditPayload(result.shift));
    await interaction.reply({
      content: "You have been added to the **responders** list.",
      ephemeral: true,
    });
  } catch (error) {
    console.error("Mass shift respond failed:", error);
    await interaction.reply({
      content: `Could not update the responders list: ${getErrorMessage(error)}`,
      ephemeral: true,
    });
  }

  return true;
}

module.exports = {
  MASS_SHIFT_COMMAND,
  handleMassShiftCommand,
  handleMassShiftInteraction,
};
