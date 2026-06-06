const path = require("path");
const fs = require("fs");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} = require("discord.js");
const { STAFF_PING_ROLE_ID, ROSTER_SYNC_ROLE_ID, HPD_EMOJI } = require("./constants");
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
const ATTENDING_DISPLAY_BUTTON_ID = "mass_shift_attending_display";
const BOT_AVATAR_FILENAME = "bot-avatar.png";
const BOT_AVATAR_PATH = path.join(__dirname, "..", "assets", BOT_AVATAR_FILENAME);

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

function buildMassShiftAnnouncement(startedAt, { includePing = false } = {}) {
  const timeLabel = formatShiftTime(new Date(startedAt));
  const leadLine = includePing
    ? `<@&${ROSTER_SYNC_ROLE_ID}> ${HPD_EMOJI}\n\n`
    : `${HPD_EMOJI}\n\n`;

  return (
    leadLine +
    "## Mass Shift\n\n" +
    "• A **mass shift** is now in effect as of `" +
    `${timeLabel}\`. All available **Houston Police Department** personnel are expected in-game immediately. ` +
    "High command appreciates your dedication and service to the department."
  );
}

function buildAttendingBlock(responders) {
  if (!responders?.length) {
    return "**Attending Personnel**\n*No personnel marked attending yet.*";
  }

  const lines = responders.map((entry, index) => `${index + 1}. ${entry.name}`);
  return `**Attending Personnel (${responders.length})**\n${lines.join("\n")}`;
}

function addBotAvatarAttachment(files) {
  if (!fs.existsSync(BOT_AVATAR_PATH)) {
    return false;
  }

  if (!files.some((file) => file.name === BOT_AVATAR_FILENAME)) {
    files.push(new AttachmentBuilder(BOT_AVATAR_PATH, { name: BOT_AVATAR_FILENAME }));
  }

  return true;
}

function buildAnnouncementSection(content, files) {
  const section = new SectionBuilder().addTextDisplayComponents(
    new TextDisplayBuilder().setContent(content),
  );

  if (!addBotAvatarAttachment(files)) {
    return null;
  }

  return section.setThumbnailAccessory(
    new ThumbnailBuilder()
      .setURL(`attachment://${BOT_AVATAR_FILENAME}`)
      .setDescription("Houston Police Department"),
  );
}

function buildMassShiftButtonRow(responderCount) {
  const attendingLabel =
    responderCount > 0 ? `Attending · ${responderCount}` : "Attending";

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(RESPOND_BUTTON_ID)
      .setLabel("Attend")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(ATTENDING_DISPLAY_BUTTON_ID)
      .setLabel(attendingLabel)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

function buildMassShiftContainer(shift, { includePing = false } = {}) {
  const { container, files } = createHpdContainer();
  const announcement = buildMassShiftAnnouncement(shift.startedAt, { includePing });
  const announcementSection = buildAnnouncementSection(announcement, files);

  if (announcementSection) {
    container.addSectionComponents(announcementSection);
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(announcement));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(buildAttendingBlock(shift.responders)),
  );
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addActionRowComponents(buildMassShiftButtonRow(shift.responders.length));
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
      content: "You have been marked as **attending** this mass shift.",
      ephemeral: true,
    });
  } catch (error) {
    console.error("Mass shift respond failed:", error);
    await interaction.reply({
      content: `Could not update the attending list: ${getErrorMessage(error)}`,
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
