const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SeparatorBuilder,
  TextDisplayBuilder,
} = require("discord.js");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { getErrorMessage } = require("./embed-utils");
const {
  createHpdContainer,
  appendHpdFooter,
  buildHpdComponentsPayload,
} = require("./hpd-components");

const DASHBOARD_COMMAND = "-hpddashboard";
const CADET_ENROLL_BUTTON_ID = "cadet_enroll";
const FASTPASS_BUTTON_ID = "fastpass_apply";

function buildDashboardContent() {
  return (
    "## Houston Police Department Dashboard\n\n" +
    "> **Service with Respect, Dedicated to Protect.**\n\n" +
    "> Welcome to the **Houston Police Department!** In this dashboard you will be able to find all important information regarding the Houston Police Department.\n\n" +
    "`Frequently Asked Questions`\n\n" +
    "1. *Is there an application?* Use the **Become a Cadet** or **Fast Pass** buttons below to apply.\n" +
    "2. *Where do I report an Officer?* You can report an officer by opening an **Internal Affairs** ticket through **Contact Support → Report**.\n" +
    "3. *What are your callsigns for unranked?* If you are unranked, your callsign is between the numbers of **400–500**."
  );
}

function buildDashboardButtonRow() {
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
  const { container, files } = createHpdContainer();

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(buildDashboardContent()),
  );
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addActionRowComponents(buildDashboardButtonRow());
  appendHpdFooter(container, files);

  return buildHpdComponentsPayload(container, files);
}

async function handleHpdDashboardCommand(message) {
  if (message.content.trim().toLowerCase() !== DASHBOARD_COMMAND) return false;
  if (message.author.bot) return false;

  if (hasProcessed(`panel:${message.id}`)) return true;

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need **Manage Server** permission to post the Houston dashboard.");
    return true;
  }

  try {
    if (message.deletable) {
      await message.delete().catch(() => {});
    }

    await message.channel.send(buildHpdDashboardPayload());
    markProcessed(`panel:${message.id}`);
  } catch (error) {
    console.error("HPD dashboard failed:", error);
    await message.channel
      .send(`Failed to post the Houston dashboard: ${getErrorMessage(error)}`)
      .catch(() => null);
  }

  return true;
}

module.exports = {
  DASHBOARD_COMMAND,
  buildHpdDashboardPayload,
  handleHpdDashboardCommand,
};
