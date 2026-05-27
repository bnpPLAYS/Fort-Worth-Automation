const { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const { EMBED_COLOR, PROMOTION_SYNC_ROLE_ID, ROSTER_SYNC_ROLE_ID } = require("./constants");
const { isSheetsConfigured, getSheetsConfigHelpMessage } = require("./google-sheets/client");
const { syncPromotionsFromDiscordForGuild } = require("./google-sheets/roster-sync");

const COMMAND_NAME = "sync-promotions";

function canRunSyncPromotions(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  return member?.roles?.cache?.has(PROMOTION_SYNC_ROLE_ID) ?? false;
}

function buildSyncPromotionsCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription(
      "After Discord promotions: update the Google roster from members' rank roles and assign new callsigns",
    );
}

async function handleSyncPromotionsCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) {
    return false;
  }

  if (!canRunSyncPromotions(interaction.member)) {
    await interaction.reply({
      content: "You do not have permission to run this command.",
      ephemeral: true,
    });
    return true;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return true;
  }

  if (!isSheetsConfigured()) {
    await interaction.reply({
      content: getSheetsConfigHelpMessage() ?? "Google Sheets is not configured on this bot.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await syncPromotionsFromDiscordForGuild(interaction.guild);

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("Promotion roster sync complete")
      .setDescription(
        `Compared Discord rank roles to the Google roster for **${result.checked}** member(s) with <@&${ROSTER_SYNC_ROLE_ID}>. ` +
          "Members whose Discord rank differs from the sheet were moved to an open callsign in that rank. DMs were sent when callsigns changed.",
      )
      .addFields(
        {
          name: `Roster updated (${result.updated.length})`,
          value:
            result.updated.length > 0
              ? result.updated.slice(0, 12).join("\n")
              : "None",
          inline: false,
        },
        {
          name: `Already matched (${result.unchanged.length})`,
          value:
            result.unchanged.length > 0
              ? result.unchanged.slice(0, 10).join("\n")
              : "None",
          inline: false,
        },
        {
          name: `No rank role found (${result.noRankRole.length})`,
          value:
            result.noRankRole.length > 0
              ? result.noRankRole.slice(0, 10).join("\n")
              : "None",
          inline: false,
        },
        {
          name: `Could not resolve name (${result.notOnSheet.length})`,
          value:
            result.notOnSheet.length > 0
              ? result.notOnSheet.slice(0, 10).join("\n")
              : "None",
          inline: false,
        },
      );

    if (result.failed.length > 0) {
      embed.addFields({
        name: `Failed (${result.failed.length})`,
        value: result.failed.slice(0, 10).join("\n"),
        inline: false,
      });
    }

    if (result.updated.length > 12) {
      embed.setFooter({ text: `${result.updated.length - 12} more updates not shown` });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error("Sync promotions failed:", error);
    await interaction.editReply(`Promotion roster sync failed: ${error.message}`);
  }

  return true;
}

module.exports = {
  buildSyncPromotionsCommand,
  handleSyncPromotionsCommand,
  canRunSyncPromotions,
};
