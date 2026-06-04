const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const { ROSTER_ADD_STAFF_ROLE_IDS } = require("./constants");
const { isSheetsConfigured, getSheetsConfigHelpMessage } = require("./google-sheets/client");
const { reorganizeRosterStructure } = require("./google-sheets/roster-reorganize");
const { buildV2Payload } = require("./v2-message");

const COMMAND_NAME = "rosterlayout";

function canUseRosterLayout(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  return ROSTER_ADD_STAFF_ROLE_IDS.some((roleId) => member?.roles?.cache?.has(roleId));
}

function buildRosterLayoutCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription("Preview or run one-time roster sheet layout fixes — staff only")
    .addBooleanOption((option) =>
      option
        .setName("dry_run")
        .setDescription("Preview changes without editing the sheet")
        .setRequired(false),
    )
    .addBooleanOption((option) =>
      option
        .setName("force")
        .setDescription("Run again even if layout v2 already completed")
        .setRequired(false),
    );
}

async function handleRosterLayoutCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) {
    return false;
  }

  if (!canUseRosterLayout(interaction.member)) {
    await interaction.reply({
      content: "You do not have permission to run roster layout changes.",
      ephemeral: true,
    });
    return true;
  }

  if (!isSheetsConfigured()) {
    await interaction.reply({
      content: getSheetsConfigHelpMessage() ?? "Google Sheets is not configured on this bot.",
      ephemeral: true,
    });
    return true;
  }

  const dryRun = interaction.options.getBoolean("dry_run") ?? false;
  const force = interaction.options.getBoolean("force") ?? false;

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await reorganizeRosterStructure({ dryRun, force });

    await interaction.editReply(
      buildV2Payload({
        title: dryRun ? "Roster layout preview" : "Roster layout update",
        description: "```json\n" + JSON.stringify(result, null, 2).slice(0, 3500) + "\n```",
        ephemeral: true,
        includeFiles: false,
      }),
    );
  } catch (error) {
    console.error("Roster layout command failed:", error);
    await interaction.editReply(`Roster layout failed: ${error.message}`);
  }

  return true;
}

module.exports = {
  buildRosterLayoutCommand,
  handleRosterLayoutCommand,
};
