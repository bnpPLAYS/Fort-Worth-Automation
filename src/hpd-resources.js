const path = require("path");
const fs = require("fs");
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
const { getErrorMessage } = require("./embed-utils");

const RESOURCES_COMMAND = "-hpdresources";

const BANNER_FILENAME = "hpd-dashboard-banner.png";
const BANNER_PATH = path.join(__dirname, "..", "assets", BANNER_FILENAME);

const RESOURCE_LINKS = [
  {
    fieldName: "Department Policies & Standards",
    buttonLabel: "Policies",
    url: "https://docs.google.com/document/d/11GeHSvOX1u2OaN_8coUs6XiT7DPpWhFo7ZPU683zneQ/edit?usp=sharing",
  },
  {
    fieldName: "Roster & Database",
    buttonLabel: "Database",
    url: "https://docs.google.com/spreadsheets/d/1IP4D1aJTywXfojyNSRoQPdpfoQ4oLveABQs0JFDy8Vw/edit?usp=sharing",
  },
  {
    fieldName: "Penal Codes",
    buttonLabel: "Penal Codes",
    url: "https://docs.google.com/document/d/1GEgoFE2319t_mtOtoPIZ8x54i5x14oK8vmtGJsp7Z50/edit?tab=t.0",
  },
  {
    fieldName: "Pursuit Policy",
    buttonLabel: "Pursuit Policy",
    url: "https://docs.google.com/document/d/1h6h6S1paBQEqYRxguVN8fOiko4U_vC3KAtNjCteGxlg/edit?usp=sharing",
  },
  {
    fieldName: "Jurisdiction & Patrol Areas",
    buttonLabel: "Jurisdiction",
    url: "https://cdn.discordapp.com/attachments/1501336834628915231/1509657863717388348/SPOILER_image.png?ex=6a1b4b72&is=6a19f9f2&hm=8fae54d3258f1338f33228fd4ab6e6172314acac30c902648642604ed0cb3f98&animated=true",
  },
  {
    fieldName: "Melonly",
    buttonLabel: "Melonly Link",
    url: "https://melon.ly/join/fwpd",
  },
];

function buildResourceButtonRows() {
  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (const resource of RESOURCE_LINKS) {
    if (currentRow.components.length >= 5) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }

    currentRow.addComponents(
      new ButtonBuilder()
        .setLabel(resource.buttonLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(resource.url),
    );
  }

  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

function buildHpdResourcesPayload() {
  const embeds = [];
  const files = [];

  if (fs.existsSync(BANNER_PATH)) {
    embeds.push(
      new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setImage(`attachment://${BANNER_FILENAME}`),
    );
    files.push(new AttachmentBuilder(BANNER_PATH, { name: BANNER_FILENAME }));
  }

  embeds.push(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("Houston Police Department")
      .setDescription(
        "> All Houston Police Department policies and regulations are housed in this section. " +
          "Personnel are expected to remain in compliance with all department standards at all times.",
      )
      .addFields(
        RESOURCE_LINKS.map((resource) => ({
          name: resource.fieldName,
          value: "\u200b",
          inline: false,
        })),
      ),
  );

  return {
    embeds,
    components: buildResourceButtonRows(),
    files,
  };
}

async function handleHpdResourcesCommand(message) {
  if (message.content.trim().toLowerCase() !== RESOURCES_COMMAND) return false;
  if (message.author.bot) return false;

  if (hasProcessed(`panel:${message.id}`)) return true;

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need **Manage Server** permission to post the Houston resources panel.");
    return true;
  }

  try {
    if (message.deletable) {
      await message.delete().catch(() => {});
    }

    await message.channel.send(buildHpdResourcesPayload());
    markProcessed(`panel:${message.id}`);
  } catch (error) {
    console.error("HPD resources panel failed:", error);
    await message.channel
      .send(`Failed to post the Houston resources panel: ${getErrorMessage(error)}`)
      .catch(() => null);
  }

  return true;
}

module.exports = {
  RESOURCES_COMMAND,
  buildHpdResourcesPayload,
  handleHpdResourcesCommand,
};
