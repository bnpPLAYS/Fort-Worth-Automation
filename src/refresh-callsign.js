const { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const { EMBED_COLOR, REFRESH_CALLSIGN_ROLE_ID, ROSTER_SYNC_ROLE_ID } = require("./constants");
const { formatEmbedList, getErrorMessage } = require("./embed-utils");
const { isSheetsConfigured, getSheetsConfigHelpMessage } = require("./google-sheets/client");
const {
  fixProbationaryRosterForGuild,
  refreshCallsignsForGuild,
} = require("./google-sheets/roster-sync");

const COMMAND_NAME = "refresh-callsign";

function canRunRefreshCallsign(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  return member?.roles?.cache?.has(REFRESH_CALLSIGN_ROLE_ID) ?? false;
}

function buildRefreshCallsignCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription(
      "Move PO members off cadet rows, sync nicknames from the sheet, and DM anyone whose callsign changed",
    );
}

async function handleRefreshCallsignCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) {
    return false;
  }

  if (!canRunRefreshCallsign(interaction.member)) {
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
    const poFix = await fixProbationaryRosterForGuild(interaction.guild);
    const callsignRefresh = await refreshCallsignsForGuild(interaction.guild);

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("Roster sync complete")
      .setDescription(
        "Moved Probationary Officers still on cadet rows, then synced nicknames for members with the roster role. " +
          "DMs were sent only to members whose callsign or nickname changed.",
      )
      .addFields(
        {
          name: `PO roster moves (${poFix.moved.length})`,
          value: formatEmbedList(poFix.moved, {
            maxItems: 10,
            emptyLabel: `None (${poFix.checked} PO role member(s) checked)`,
          }),
          inline: false,
        },
        {
          name: `Callsign updates (${callsignRefresh.updated.length})`,
          value: formatEmbedList(callsignRefresh.updated, {
            maxItems: 10,
            emptyLabel: `None (${callsignRefresh.checked} member(s) with <@&${ROSTER_SYNC_ROLE_ID}> checked)`,
          }),
          inline: false,
        },
        {
          name: `Already correct (${callsignRefresh.unchanged.length})`,
          value: formatEmbedList(callsignRefresh.unchanged, { maxItems: 8 }),
          inline: false,
        },
        {
          name: `Not on sheet (${callsignRefresh.notOnSheet.length})`,
          value: formatEmbedList(callsignRefresh.notOnSheet, { maxItems: 8 }),
          inline: false,
        },
      );

    const failures = [...poFix.failed, ...callsignRefresh.failed];
    if (failures.length > 0) {
      embed.addFields({
        name: `Failed (${failures.length})`,
        value: formatEmbedList(failures, { maxItems: 8 }),
        inline: false,
      });
    }

    if (poFix.skipped.length > 0) {
      embed.setFooter({
        text: `${poFix.skipped.length} PO member(s) already on the correct roster row`,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error("Refresh callsign failed:", error);
    await interaction.editReply(`Roster sync failed: ${getErrorMessage(error)}`);
  }

  return true;
}

module.exports = {
  buildRefreshCallsignCommand,
  handleRefreshCallsignCommand,
  canRunRefreshCallsign,
};
