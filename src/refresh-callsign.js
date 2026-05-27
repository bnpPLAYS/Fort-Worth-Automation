const { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const { EMBED_COLOR, REFRESH_CALLSIGN_ROLE_ID, ROSTER_SYNC_ROLE_ID } = require("./constants");
const { isSheetsConfigured, getSheetsConfigHelpMessage } = require("./google-sheets/client");
const { getNamedRosterEntries, findRosterEntryForMember } = require("./google-sheets/roster-lookup");
const { updateMemberCallsign, formatCallsignForDisplay } = require("./discord-callsign");
const { sendCallsignDm } = require("./member-roster");

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
      "Sync nicknames from the Google roster for all members with the roster sync role",
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

  const guild = interaction.guild;

  try {
    const entries = await getNamedRosterEntries();
    await guild.members.fetch().catch(() => null);

    const membersToSync = guild.members.cache.filter((member) =>
      member.roles.cache.has(ROSTER_SYNC_ROLE_ID),
    );

    const updated = [];
    const unchanged = [];
    const notOnSheet = [];
    const failed = [];

    for (const member of membersToSync.values()) {
      const entry = findRosterEntryForMember(entries, member);

      if (!entry) {
        notOnSheet.push(member.displayName);
        continue;
      }

      const callsign = formatCallsignForDisplay(entry.callsign);
      const nicknameResult = await updateMemberCallsign(member, callsign, entry.name);

      if (!nicknameResult.ok) {
        failed.push(`${member.displayName}: ${nicknameResult.reason}`);
        continue;
      }

      const dmSent = await sendCallsignDm(member.user, {
        callsign,
        roleplayName: entry.name,
        rank: entry.rank,
        isCadet: /^C-/i.test(callsign),
        title: "Your callsign has been synced from the department roster.",
        extraLines:
          nicknameResult.changed && nicknameResult.nickname
            ? [`Your Discord nickname is now \`${nicknameResult.nickname}\`.`]
            : [],
      });

      const label = `${member.displayName} → **${callsign}** | ${entry.name}`;
      if (nicknameResult.changed || dmSent) {
        updated.push(`${label}${dmSent ? "" : " (DM failed)"}`);
      } else {
        unchanged.push(label);
      }
    }

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("Callsign refresh complete")
      .setDescription(
        `Checked **${membersToSync.size}** member(s) with <@&${ROSTER_SYNC_ROLE_ID}> against the Google roster.`,
      )
      .addFields(
        {
          name: `Updated (${updated.length})`,
          value: updated.length > 0 ? updated.slice(0, 15).join("\n") : "None",
          inline: false,
        },
        {
          name: `Already correct (${unchanged.length})`,
          value: unchanged.length > 0 ? unchanged.slice(0, 10).join("\n") : "None",
          inline: false,
        },
        {
          name: `Not found on sheet (${notOnSheet.length})`,
          value:
            notOnSheet.length > 0
              ? notOnSheet.slice(0, 10).join("\n") +
                (notOnSheet.length > 10 ? `\n…and ${notOnSheet.length - 10} more` : "")
              : "None",
          inline: false,
        },
      );

    if (failed.length > 0) {
      embed.addFields({
        name: `Failed (${failed.length})`,
        value: failed.slice(0, 10).join("\n"),
        inline: false,
      });
    }

    if (updated.length > 15) {
      embed.setFooter({ text: `${updated.length - 15} more updates not shown` });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error("Refresh callsign failed:", error);
    await interaction.editReply(`Callsign refresh failed: ${error.message}`);
  }

  return true;
}

module.exports = {
  buildRefreshCallsignCommand,
  handleRefreshCallsignCommand,
  canRunRefreshCallsign,
};
