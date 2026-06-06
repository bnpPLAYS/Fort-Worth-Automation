const {
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SectionBuilder,
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
const { HPD_RETIRE_BUTTON_ID } = require("./hpd-retirement");

const RESOURCES_COMMAND = "-hpdresources";

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
    url: "https://melon.ly/join/houstonpd",
  },
  {
    fieldName: "Accessory & Livery Regulations",
    buttonLabel: "Accessory & Livery",
    url: "https://docs.google.com/spreadsheets/d/1aA2gTq7IqzXGSrxJmHidDr0eUeLvrdqnVrxXv2uBnOw/edit?usp=sharing",
  },
  {
    fieldName: "Vehicle Regulation",
    buttonLabel: "Vehicle Regulation",
    url: "https://docs.google.com/spreadsheets/d/1ivUThGBrDmzyp7cNbbEAyAoDP9zZx3KHozjUxvReJ6w/edit?usp=sharing",
  },
];

function buildResourceSection(resource) {
  return new SectionBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`**${resource.fieldName}**`),
    )
    .setButtonAccessory(
      new ButtonBuilder()
        .setLabel(resource.buttonLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(resource.url),
    );
}

function buildHpdResourcesPayload() {
  const { container, files } = createHpdContainer();

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      "## Houston Police Department\n\n" +
        "> All Houston Police Department policies and regulations are housed in this section. " +
        "Personnel are expected to remain in compliance with all department standards at all times.",
    ),
  );

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));

  for (const resource of RESOURCE_LINKS) {
    container.addSectionComponents(buildResourceSection(resource));
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addSectionComponents(
    new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          "**Retire from HPD**\n" +
            "Leave the department voluntarily. Your roles, callsign, and roster entry will be removed.",
        ),
      )
      .setButtonAccessory(
        new ButtonBuilder()
          .setCustomId(HPD_RETIRE_BUTTON_ID)
          .setLabel("Retire")
          .setStyle(ButtonStyle.Danger),
      ),
  );

  appendHpdFooter(container, files);

  return buildHpdComponentsPayload(container, files);
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
