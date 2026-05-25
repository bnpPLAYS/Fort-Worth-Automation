const { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const { EMBED_COLOR, ROSTER_ADD_STAFF_ROLE_IDS } = require("./constants");
const { formatRoleplayInitials } = require("./roleplay-name");
const { updateMemberCallsign } = require("./discord-callsign");
const { resolveRankForRosterAdd } = require("./rank-options");
const {
  isSheetsConfigured,
  getSheetsConfigHelpMessage,
} = require("./google-sheets/client");
const { getRosterRanksWithOpenSlots } = require("./google-sheets/roster-ranks");
const {
  assignMemberToOpenRank,
  assignCadetCallsign,
  findRosterEntriesForName,
} = require("./google-sheets/roster-assign");

const COMMAND_NAME = "rosteradd";
const AUTOCOMPLETE_MAX = 25;

function canUseRosterAdd(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  return ROSTER_ADD_STAFF_ROLE_IDS.some((roleId) => member?.roles?.cache?.has(roleId));
}

function buildRosterAddCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription("Add a member to the Google roster and link their Discord account")
    .addUserOption((option) =>
      option.setName("member").setDescription("Discord member to add to the roster").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("roleplay_name")
        .setDescription("Full roleplay name (e.g. John Smith → J. Smith on the sheet)")
        .setRequired(true)
        .setMaxLength(64),
    )
    .addStringOption((option) =>
      option
        .setName("rank")
        .setDescription("Roster rank from the sheet (type to search ranks with open slots)")
        .setRequired(true)
        .setAutocomplete(true),
    );
}

function formatRankChoiceName(rank, openCount) {
  const label = `${rank} (${openCount} open)`;
  return label.length > 100 ? `${rank.slice(0, 90)}… (${openCount} open)` : label;
}

async function handleRosterAddAutocomplete(interaction) {
  if (!interaction.isAutocomplete() || interaction.commandName !== COMMAND_NAME) {
    return false;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "rank") {
    return false;
  }

  if (!canUseRosterAdd(interaction.member)) {
    await interaction.respond([]);
    return true;
  }

  if (!isSheetsConfigured()) {
    await interaction.respond([]);
    return true;
  }

  try {
    const ranks = await getRosterRanksWithOpenSlots();
    const query = String(focused.value ?? "")
      .trim()
      .toLowerCase();

    const filtered = query
      ? ranks.filter((entry) => entry.rank.toLowerCase().includes(query))
      : ranks;

    const choices = filtered.slice(0, AUTOCOMPLETE_MAX).map((entry) => ({
      name: formatRankChoiceName(entry.rank, entry.openCount),
      value: entry.rank.slice(0, 100),
    }));

    await interaction.respond(choices);
  } catch (error) {
    console.error("Roster add autocomplete failed:", error);
    await interaction.respond([]);
  }

  return true;
}

async function assignRolesToMember(member, roleIds) {
  const toAdd = roleIds.filter((roleId) => !member.roles.cache.has(roleId));
  if (toAdd.length === 0) {
    return { added: [], failed: [] };
  }

  try {
    await member.roles.add(toAdd, "Roster add — initial assignment");
    return { added: toAdd, failed: [] };
  } catch (error) {
    console.error("Roster add role assignment failed:", error);
    return { added: [], failed: toAdd, error: error.message };
  }
}

async function handleRosterAddCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) {
    return false;
  }

  if (!canUseRosterAdd(interaction.member)) {
    await interaction.reply({
      content: "You do not have permission to use this command.",
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

  const targetUser = interaction.options.getUser("member", true);
  const fullName = interaction.options.getString("roleplay_name", true).trim();
  const rankValue = interaction.options.getString("rank", true).trim();

  if (!rankValue) {
    await interaction.reply({
      content: "Pick a **rank** from the autocomplete list (ranks with open callsign slots on the sheet).",
      ephemeral: true,
    });
    return true;
  }

  const rankConfig = resolveRankForRosterAdd(interaction.guild, rankValue);

  let roleplayName;
  try {
    roleplayName = formatRoleplayInitials(fullName);
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    await interaction.editReply("That user is not in this server.");
    return true;
  }

  try {
    const existing = await findRosterEntriesForName(roleplayName);
    if (existing.length > 0) {
      const slots = existing.map((entry) => `${entry.rank} / ${entry.callsign}`).join(", ");
      await interaction.editReply(
        `**${roleplayName}** is already on the roster (${slots}).\n\n` +
          "Use the promotion channel or clear their row manually before adding them again.",
      );
      return true;
    }

    let rosterResult;
    if (rankConfig.useCadetCallsign) {
      rosterResult = await assignCadetCallsign(roleplayName);
    } else {
      rosterResult = await assignMemberToOpenRank(roleplayName, rankConfig.sheetRank);
    }

    const callsign = rosterResult.newCallsign ?? rosterResult.callsign;
    const sheetRank = rosterResult.newRank ?? rosterResult.rank;

    const roleResult =
      rankConfig.discordRoleIds.length > 0
        ? await assignRolesToMember(member, rankConfig.discordRoleIds)
        : { added: [], failed: [], skipped: true };

    const nicknameResult = await updateMemberCallsign(member, callsign, roleplayName);

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("Member added to roster")
      .setDescription(`Linked <@${member.id}> to the Google roster.`)
      .addFields(
        { name: "Roster Name", value: roleplayName, inline: true },
        { name: "Callsign", value: callsign, inline: true },
        { name: "Rank", value: sheetRank, inline: true },
        { name: "Added by", value: `<@${interaction.user.id}>`, inline: false },
      );

    const notes = [];
    if (roleResult.skipped) {
      notes.push(
        "No matching Discord role found for this rank — roster and nickname were still updated.",
      );
    } else if (roleResult.failed.length > 0) {
      notes.push(
        `Could not assign all Discord roles (${roleResult.error ?? "check bot role hierarchy"}).`,
      );
    }
    if (!nicknameResult.ok) {
      notes.push(`Nickname not updated: ${nicknameResult.reason}`);
    } else if (nicknameResult.changed) {
      embed.addFields({ name: "Nickname", value: nicknameResult.nickname, inline: false });
    }

    if (notes.length > 0) {
      embed.addFields({ name: "Notes", value: notes.join("\n"), inline: false });
    }

    await interaction.editReply({ embeds: [embed] });

    const dmLines = [
      `You have been added to the **Fort Worth Police Department** roster.`,
      "",
      `**Roster name:** ${roleplayName}`,
      `**Rank:** ${sheetRank}`,
      `**Callsign:** ${callsign}`,
    ];

    if (rankConfig.useCadetCallsign) {
      dmLines.push("", "Do **not** use your cadet callsign in-game until you are promoted.");
    } else {
      dmLines.push("", "You may use this callsign in-game.");
    }

    if (nicknameResult.ok && nicknameResult.changed) {
      dmLines.push(`Your Discord nickname is now \`${nicknameResult.nickname}\`.`);
    }

    await member.user.send(dmLines.join("\n")).catch(() => null);
  } catch (error) {
    console.error("Roster add failed:", error);
    await interaction.editReply(
      `Could not add member to roster.\n\n${error.message}\n\n` +
        "Check that the rank has open rows on the sheet (callsign filled, RP NAME empty).",
    );
  }

  return true;
}

module.exports = {
  buildRosterAddCommand,
  handleRosterAddCommand,
  handleRosterAddAutocomplete,
  canUseRosterAdd,
};
