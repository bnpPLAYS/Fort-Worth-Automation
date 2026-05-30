const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const { PROMOTION_SYNC_ROLE_ID, ROSTER_SYNC_ROLE_ID } = require("./constants");
const { isSheetsConfigured, getSheetsConfigHelpMessage } = require("./google-sheets/client");
const { syncPromotionsFromDiscordForGuild } = require("./google-sheets/roster-sync");
const { formatEmbedList, getErrorMessage } = require("./embed-utils");
const { buildV2Payload } = require("./v2-message");

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
      "Link accounts from nickname callsigns, then update the Google roster from Discord rank roles",
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
    const links = result.links ?? { linked: [], unchanged: [], noCallsign: [], notOnSheet: [], ambiguous: [] };

    const skipped = [
      ...(links.wrongNicknameFormat ?? []).map(
        (name) => `${name} (use \`callsign | Name\` nickname format)`,
      ),
      ...links.noCallsign.map((name) => `${name} (no callsign in nickname)`),
      ...links.notOnSheet.map((name) => `${name} (callsign not on sheet)`),
      ...links.ambiguous.map((name) => `${name} (ambiguous link)`),
      ...result.noRankRole.map((name) => `${name} (no rank role)`),
      ...result.notOnSheet,
    ];

    await interaction.editReply(
      buildV2Payload({
        title: "Promotion roster sync complete",
        description:
          `Only members with <@&${ROSTER_SYNC_ROLE_ID}> and nickname \`callsign | Name\` are processed. ` +
          `Linked **${links.linked.length}** account(s) (${links.unchanged.length} already linked` +
          `${links.purged ? `, ${links.purged} stale link(s) removed` : ""}). ` +
          `Checked **${result.checked}** roster member(s) for rank sync.`,
        fields: [
          {
            name: `Newly linked (${links.linked.length})`,
            value: formatEmbedList(links.linked, { maxItems: 10, maxLength: 900 }),
          },
          {
            name: `Roster updated (${result.updated.length})`,
            value: formatEmbedList(result.updated, { maxItems: 10, maxLength: 900 }),
          },
          {
            name: `Already matched (${result.unchanged.length})`,
            value: formatEmbedList(result.unchanged, { maxItems: 8, maxLength: 900 }),
          },
          {
            name: `Skipped (${skipped.length})`,
            value: formatEmbedList(skipped, { maxItems: 10, maxLength: 900 }),
          },
          ...(result.failed.length > 0
            ? [
                {
                  name: `Failed (${result.failed.length})`,
                  value: formatEmbedList(result.failed, { maxItems: 8, maxLength: 900 }),
                },
              ]
            : []),
        ],
        ephemeral: true,
        includeFiles: false,
      }),
    );
  } catch (error) {
    console.error("Sync promotions failed:", error);
    await interaction.editReply(`Promotion roster sync failed: ${getErrorMessage(error)}`);
  }

  return true;
}

module.exports = {
  buildSyncPromotionsCommand,
  handleSyncPromotionsCommand,
  canRunSyncPromotions,
};
