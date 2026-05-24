const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const { EMBED_COLOR } = require("./constants");
const { hasProcessed, markProcessed } = require("./panel-dedupe");

const CADET_PANEL_COMMAND = "-becomecadetpanel";
const CADET_ENROLL_BUTTON_ID = "cadet_enroll";

const CADET_ROLE_IDS = [
  "1495414411840454676",
  "1484951746852818944",
  "1484951786623205516",
];

const RA_REQUEST_CHANNEL_ID = "1501730869961031770";
const RA_NOTIFICATION_CHANNEL_ID = "1485030495841681408";
const RA_PING_ROLE_IDS = ["1484950653045440532", "1484950025472704643"];

function buildCadetPanelEmbed() {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(
      "# Become a Cadet\n\n" +
        "Click the button below to receive your **Cadet** roles and begin the ride-along process.\n\n" +
        "After enrolling, you must complete **2 ride-alongs** before you can become a **Probationary Officer**.\n\n" +
        `File a ride-along request in <#${RA_REQUEST_CHANNEL_ID}> when you are ready.`,
    )
    .setFooter({ text: "Fort Worth Police Department" });
}

function buildCadetEnrollButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CADET_ENROLL_BUTTON_ID)
      .setLabel("Become Cadet")
      .setStyle(ButtonStyle.Success),
  );
}

async function handleCadetPanelCommand(message) {
  if (message.content.trim().toLowerCase() !== CADET_PANEL_COMMAND) return false;
  if (message.author.bot) return false;

  if (hasProcessed(`panel:${message.id}`)) return true;
  markProcessed(`panel:${message.id}`);

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need **Manage Server** permission to post the cadet panel.");
    return true;
  }

  if (message.deletable) {
    await message.delete().catch(() => {});
  }

  await message.channel.send({
    embeds: [buildCadetPanelEmbed()],
    components: [buildCadetEnrollButton()],
  });

  return true;
}

async function handleCadetInteraction(interaction) {
  if (!interaction.isButton() || interaction.customId !== CADET_ENROLL_BUTTON_ID) {
    return false;
  }

  const member = interaction.member;
  if (!member) {
    await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const rolesToAdd = CADET_ROLE_IDS.filter((roleId) => !member.roles.cache.has(roleId));

  if (rolesToAdd.length > 0) {
    await member.roles.add(rolesToAdd).catch((error) => {
      console.error("Failed to assign cadet roles:", error);
    });
  }

  await interaction.editReply({
    content:
      "You have been enrolled as a **Cadet** and received your cadet roles.\n\n" +
      "You must complete **2 ride-alongs** before you can become a **Probationary Officer**.\n\n" +
      `When you are ready, file a ride-along request in <#${RA_REQUEST_CHANNEL_ID}>.`,
  });

  return true;
}

async function handleRideAlongMessage(message) {
  if (message.author.bot || !message.guild) return false;
  if (message.channel.id !== RA_REQUEST_CHANNEL_ID) return false;
  if (hasProcessed(`ra:${message.id}`)) return false;

  markProcessed(`ra:${message.id}`);

  const notificationChannel = await message.client.channels
    .fetch(RA_NOTIFICATION_CHANNEL_ID)
    .catch(() => null);

  if (!notificationChannel?.isTextBased()) {
    console.error("Ride-along notification channel not found:", RA_NOTIFICATION_CHANNEL_ID);
    return true;
  }

  const rolePings = RA_PING_ROLE_IDS.map((id) => `<@&${id}>`).join(" ");

  await notificationChannel.send({
    content:
      `${rolePings}\n\n` +
      `A **ride-along request** is pending from ${message.author} in <#${RA_REQUEST_CHANNEL_ID}>.\n` +
      `[Jump to request](${message.url})`,
    allowedMentions: { roles: RA_PING_ROLE_IDS },
  });

  return true;
}

module.exports = {
  handleCadetPanelCommand,
  handleCadetInteraction,
  handleRideAlongMessage,
};
