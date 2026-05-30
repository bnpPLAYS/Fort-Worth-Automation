const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const { REFRESH_CALLSIGN_ROLE_ID, ROSTER_SYNC_ROLE_ID } = require("./constants");
const { formatEmbedList, getErrorMessage } = require("./embed-utils");
const { buildV2Payload } = require("./v2-message");
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
    const failures = [...poFix.failed, ...callsignRefresh.failed];

    await interaction.editReply(
      buildV2Payload({
        title: "Roster sync complete",
        description:
          "Moved Probationary Officers still on cadet rows, then synced nicknames for members with the roster role. " +
          "DMs were sent only to members whose callsign or nickname changed.",
        fields: [
          {
            name: `PO roster moves (${poFix.moved.length})`,
            value: formatEmbedList(poFix.moved, {
              maxItems: 10,
              emptyLabel: `None (${poFix.checked} PO role member(s) checked)`,
            }),
          },
          {
            name: `Callsign updates (${callsignRefresh.updated.length})`,
            value: formatEmbedList(callsignRefresh.updated, {
              maxItems: 10,
              emptyLabel: `None (${callsignRefresh.checked} member(s) with <@&${ROSTER_SYNC_ROLE_ID}> checked)`,
            }),
          },
          {
            name: `Already correct (${callsignRefresh.unchanged.length})`,
            value: formatEmbedList(callsignRefresh.unchanged, { maxItems: 8 }),
          },
          {
            name: `Not on sheet (${callsignRefresh.notOnSheet.length})`,
            value: formatEmbedList(callsignRefresh.notOnSheet, { maxItems: 8 }),
          },
          ...(failures.length > 0
            ? [
                {
                  name: `Failed (${failures.length})`,
                  value: formatEmbedList(failures, { maxItems: 8 }),
                },
              ]
            : []),
        ],
        footer:
          poFix.skipped.length > 0
            ? `${poFix.skipped.length} PO member(s) already on the correct roster row`
            : undefined,
        ephemeral: true,
        includeFiles: false,
      }),
    );
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
