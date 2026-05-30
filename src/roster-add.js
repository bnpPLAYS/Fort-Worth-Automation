const { PermissionFlagsBits, SlashCommandBuilder } = require("discord.js");
const { ROSTER_ADD_STAFF_ROLE_IDS } = require("./constants");
const { formatRoleplayInitials } = require("./roleplay-name");
const { updateMemberCallsign } = require("./discord-callsign");
const { resolveRankForRosterAdd } = require("./rank-options");
const { MEMBER_ROSTER_ROLE_IDS } = require("./constants");
const { sendCallsignDm, mergeRoleIds } = require("./member-roster");
const { getRosterCallsignForMember } = require("./google-sheets/roster-match");
const { recordMemberRosterLink } = require("./roster-member-link");
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
const { buildV2Payload } = require("./v2-message");

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
    const memberCallsign = getRosterCallsignForMember(member);
    const existing = await findRosterEntriesForName(roleplayName, { callsign: memberCallsign, member });

    if (existing.length > 0) {
      const slots = existing.map((entry) => `${entry.rank} / ${entry.callsign}`).join(", ");
      await interaction.editReply(
        `**${roleplayName}** is already on the roster (${slots}).\n\n` +
          "Use the promotion channel or clear their row manually before adding them again.",
      );
      return true;
    }

    if (!memberCallsign) {
      const allWithName = await findRosterEntriesForName(roleplayName);
      if (allWithName.length > 1) {
        await interaction.editReply(
          `Multiple people named **${roleplayName}** are on the roster. ` +
            "Set their Discord nickname to `callsign | Name` first, or clear the duplicate row manually.",
        );
        return true;
      }
    }

    let rosterResult;
    if (rankConfig.useCadetCallsign) {
      rosterResult = await assignCadetCallsign(roleplayName, { currentCallsign: memberCallsign });
    } else {
      rosterResult = await assignMemberToOpenRank(roleplayName, rankConfig.sheetRank, {
        currentCallsign: memberCallsign,
      });
    }

    const callsign = rosterResult.newCallsign ?? rosterResult.callsign;
    const sheetRank = rosterResult.newRank ?? rosterResult.rank;

    const roleIds = mergeRoleIds(rankConfig.discordRoleIds, MEMBER_ROSTER_ROLE_IDS);
    const roleResult =
      roleIds.length > 0
        ? await assignRolesToMember(member, roleIds)
        : { added: [], failed: [], skipped: true };

    const nicknameResult = await updateMemberCallsign(member, callsign, roleplayName);

    const fields = [
      { name: "Roster Name", value: roleplayName },
      { name: "Callsign", value: callsign },
      { name: "Rank", value: sheetRank },
      { name: "Added by", value: `<@${interaction.user.id}>` },
    ];

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
      fields.push({ name: "Nickname", value: nicknameResult.nickname });
    }

    if (notes.length > 0) {
      fields.push({ name: "Notes", value: notes.join("\n") });
    }

    await interaction.editReply(
      buildV2Payload({
        title: "Member added to roster",
        description: `Linked <@${member.id}> to the Google roster.`,
        fields,
        ephemeral: true,
        includeFiles: false,
      }),
    );

    await sendCallsignDm(member.user, {
      callsign,
      roleplayName,
      rank: sheetRank,
      isCadet: rankConfig.useCadetCallsign,
      title: "You have been added to the **Fort Worth Police Department** roster.",
      extraLines:
        nicknameResult.ok && nicknameResult.changed
          ? [`Your Discord nickname is now \`${nicknameResult.nickname}\`.`]
          : [],
    });

    recordMemberRosterLink(member, {
      name: roleplayName,
      callsign,
      rank: sheetRank,
      rowNumber: rosterResult.rowNumber,
    });
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
