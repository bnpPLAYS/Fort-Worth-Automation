const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");
const { EMBED_COLOR, STAFF_PING_ROLE_ID } = require("./constants");
const { runRosterDiagnostics } = require("./google-sheets/diagnostics");

function canRunRosterCheck(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  return interaction.member?.roles?.cache?.has(STAFF_PING_ROLE_ID) ?? false;
}

async function handleRosterCheckCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "rostercheck") {
    return false;
  }

  if (!canRunRosterCheck(interaction)) {
    await interaction.reply({
      content: "You need **Manage Server** permission or the staff role to run this command.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const rankToCheck = interaction.options.getString("rank");

  try {
    const result = await runRosterDiagnostics({ rankToCheck });

    const embed = new EmbedBuilder()
      .setColor(result.ok ? 0x57f287 : 0xed4245)
      .setTitle(result.ok ? "Roster connection OK" : "Roster connection issues")
      .setDescription(result.lines.join("\n\n"));

    if (result.serviceAccountEmail) {
      embed.setFooter({
        text: "Share the Google Sheet with the service account email above (Editor access).",
      });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error("Roster check failed:", error);
    await interaction.editReply({
      content: `Roster check failed: ${error.message}`,
    });
  }

  return true;
}

module.exports = {
  handleRosterCheckCommand,
};
