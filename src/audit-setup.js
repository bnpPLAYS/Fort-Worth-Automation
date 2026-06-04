const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const { ROSTER_ADD_STAFF_ROLE_IDS } = require("./constants");
const { ensureAuditChannel, getAuditChannel, DEFAULT_CHANNEL_NAME } = require("./roster-audit-log");
const { getAuditChannelId } = require("./guild-settings-store");

const COMMAND_NAME = "setupauditlog";

function canManageAuditSetup(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  return ROSTER_ADD_STAFF_ROLE_IDS.some((roleId) => member?.roles?.cache?.has(roleId));
}

function buildSetupAuditLogCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription("Create or verify the roster audit log channel — staff only");
}

async function handleSetupAuditLogCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) {
    return false;
  }

  if (!canManageAuditSetup(interaction.member)) {
    await interaction.reply({
      content: "You do not have permission to set up audit logging.",
      ephemeral: true,
    });
    return true;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const existing = await getAuditChannel(interaction.guild);
  const channel = existing ?? (await ensureAuditChannel(interaction.guild));

  if (!channel) {
    await interaction.editReply(
      "Could not create the audit log channel. The bot needs **Manage Channels** permission.",
    );
    return true;
  }

  const configuredId = getAuditChannelId(interaction.guild.id);

  await interaction.editReply(
    `Audit logging is ready in ${channel} (\`${channel.id}\`).\n\n` +
      `Channel name: **#${DEFAULT_CHANNEL_NAME}**\n` +
      (process.env.ROSTER_AUDIT_CHANNEL_ID
        ? "Using **ROSTER_AUDIT_CHANNEL_ID** from `.env`."
        : configuredId
          ? "Saved in bot data for this server."
          : "Set **ROSTER_AUDIT_CHANNEL_ID** in `.env` to pin this across redeploys.") +
      `\n\nRoster changes, Quiz acceptances, promotions, and sync events will be logged here.`,
  );

  return true;
}

module.exports = {
  buildSetupAuditLogCommand,
  handleSetupAuditLogCommand,
};
