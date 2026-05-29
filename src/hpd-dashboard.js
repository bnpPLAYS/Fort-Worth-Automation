const path = require("path");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const { EMBED_COLOR } = require("./constants");
const { hasProcessed, markProcessed } = require("./panel-dedupe");

const DASHBOARD_COMMAND = "-hpddashboard";
const CADET_ENROLL_BUTTON_ID = "cadet_enroll";
const FASTPASS_BUTTON_ID = "fastpass_apply";

const BANNER_FILENAME = "hpd-dashboard-banner.png";
const FOOTER_FILENAME = "hpd-dashboard-footer.png";
const BANNER_PATH = path.join(__dirname, "..", "assets", BANNER_FILENAME);
const FOOTER_PATH = path.join(__dirname, "..", "assets", FOOTER_FILENAME);

function buildDashboardDescription() {
  return (
    "> **Service with Respect, Dedicated to Protect.**\n\n" +
    "> Welcome to the **Houston Police Department!** In this dashboard you will be able to find all important information regarding the Houston Police Department.\n\n" +
    "`Frequently Asked Questions`\n\n" +
    "1. *Is there an application?* Use the **Become a Cadet** or **Fast Pass** buttons below to apply.\n" +
    "2. *Where do I report an Officer?* You can report an officer by opening an **Internal Affairs** ticket through **Contact Support → Report**.\n" +
    "3. *What are your callsigns for unranked?* If you are unranked, your callsign is between the numbers of **400–500**."
  );
}

function buildDashboardButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CADET_ENROLL_BUTTON_ID)
      .setLabel("Become a Cadet")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(FASTPASS_BUTTON_ID)
      .setLabel("Fast Pass")
      .setStyle(ButtonStyle.Secondary),
  );
}

function buildHpdDashboardPayload() {
  const bannerEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setImage(`attachment://${BANNER_FILENAME}`);

  const mainEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Houston Police Department Dashboard")
    .setDescription(buildDashboardDescription());

  const footerEmbed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setImage(`attachment://${FOOTER_FILENAME}`);

  return {
    embeds: [bannerEmbed, mainEmbed, footerEmbed],
    components: [buildDashboardButtons()],
    files: [
      new AttachmentBuilder(BANNER_PATH, { name: BANNER_FILENAME }),
      new AttachmentBuilder(FOOTER_PATH, { name: FOOTER_FILENAME }),
    ],
  };
}

async function handleHpdDashboardCommand(message) {
  if (message.content.trim().toLowerCase() !== DASHBOARD_COMMAND) return false;
  if (message.author.bot) return false;

  if (hasProcessed(`panel:${message.id}`)) return true;
  markProcessed(`panel:${message.id}`);

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need **Manage Server** permission to post the Houston dashboard.");
    return true;
  }

  if (message.deletable) {
    await message.delete().catch(() => {});
  }

  await message.channel.send(buildHpdDashboardPayload());
  return true;
}

module.exports = {
  DASHBOARD_COMMAND,
  buildHpdDashboardPayload,
  handleHpdDashboardCommand,
};
