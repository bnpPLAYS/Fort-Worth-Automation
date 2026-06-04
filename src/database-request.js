const { SlashCommandBuilder } = require("discord.js");
const { isSheetsConfigured, getSheetsConfigHelpMessage } = require("./google-sheets/client");
const { getRosterRanksWithOpenSlots } = require("./google-sheets/roster-ranks");
const {
  extractDepartmentCallsignFromDisplayName,
  getRoleplayNameFromMember,
  findMemberForRosterEntry,
} = require("./discord-callsign");
const { runPromotionUpdate, buildPromotionSuccessPayload } = require("./promotion-handler");
const { canBypassRankEligibility } = require("./rank-eligibility");

const COMMAND_NAME = "database";
const AUTOCOMPLETE_MAX = 25;

function formatRankChoiceName(rank, openCount) {
  const label = `${rank} (${openCount} open)`;
  return label.length > 100 ? `${rank.slice(0, 90)}… (${openCount} open)` : label;
}

function buildDatabaseCommand() {
  return new SlashCommandBuilder()
    .setName(COMMAND_NAME)
    .setDescription("Update your rank on the department roster (database)")
    .addStringOption((option) =>
      option
        .setName("new_rank")
        .setDescription("The rank you are moving to (must have open slots on the sheet)")
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((option) =>
      option
        .setName("roleplay_name")
        .setDescription("Only if different from your nickname (e.g. J. Smith)")
        .setRequired(false)
        .setMaxLength(64),
    )
    .addStringOption((option) =>
      option
        .setName("current_callsign")
        .setDescription("Only if different from your nickname callsign")
        .setRequired(false)
        .setMaxLength(16),
    )
    .addUserOption((option) =>
      option
        .setName("member")
        .setDescription("Staff only — update another member's roster row")
        .setRequired(false),
    );
}

function resolveDatabaseRequestFields(interaction, targetMember) {
  const roleplayName =
    interaction.options.getString("roleplay_name")?.trim() ||
    getRoleplayNameFromMember(targetMember);
  const callsignRaw =
    interaction.options.getString("current_callsign")?.trim() ||
    extractDepartmentCallsignFromDisplayName(targetMember.displayName);

  const currentCallsign = callsignRaw ? String(callsignRaw).replace(/\D/g, "") : "";

  return { roleplayName, currentCallsign };
}

async function handleDatabaseAutocomplete(interaction) {
  if (!interaction.isAutocomplete() || interaction.commandName !== COMMAND_NAME) {
    return false;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "new_rank") {
    return false;
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
    console.error("Database autocomplete failed:", error);
    await interaction.respond([]);
  }

  return true;
}

async function handleDatabaseCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND_NAME) {
    return false;
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

  const newRank = interaction.options.getString("new_rank", true).trim();
  if (!newRank) {
    await interaction.reply({
      content: "Pick a **new rank** from the autocomplete list (ranks with open callsign slots).",
      ephemeral: true,
    });
    return true;
  }

  const staffBypass = canBypassRankEligibility(interaction.member);
  const targetUser = interaction.options.getUser("member");
  let targetMember = interaction.member;

  if (targetUser) {
    if (!staffBypass) {
      await interaction.reply({
        content: "You can only update **your own** roster entry. Staff can use the **member** option.",
        ephemeral: true,
      });
      return true;
    }

    targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      await interaction.reply({ content: "That member is not in this server.", ephemeral: true });
      return true;
    }
  }

  const { roleplayName, currentCallsign } = resolveDatabaseRequestFields(interaction, targetMember);

  if (!roleplayName || roleplayName.length < 2) {
    await interaction.reply({
      content:
        "Could not read your roster name. Set your nickname to `callsign | Name` (e.g. `3401 | J. Smith`) or enter **roleplay_name** manually.",
      ephemeral: true,
    });
    return true;
  }

  if (!currentCallsign) {
    await interaction.reply({
      content:
        "Could not read your callsign. Set your nickname to `callsign | Name` (e.g. `3401 | J. Smith`) or enter **current_callsign** manually.",
      ephemeral: true,
    });
    return true;
  }

  const parsed = {
    roleplayName,
    currentCallsign,
    newRank,
  };

  if (staffBypass && targetUser) {
    const located = await findMemberForRosterEntry(interaction.guild, parsed);
    if (!located) {
      await interaction.reply({
        content:
          "Could not match that member to the roster. Check their nickname (`callsign | Name`) and the values you entered.",
        ephemeral: true,
      });
      return true;
    }
    targetMember = located;
  }

  await interaction.deferReply({ ephemeral: false });

  const outcome = await runPromotionUpdate({
    client: interaction.client,
    authorMember: interaction.member,
    targetMember,
    parsed,
    staffBypass,
  });

  if (!outcome.ok) {
    await interaction.editReply(outcome.message);
    return true;
  }

  await interaction.editReply(
    buildPromotionSuccessPayload(parsed, outcome.result, outcome.nicknameResult),
  );
  return true;
}

module.exports = {
  COMMAND_NAME,
  buildDatabaseCommand,
  handleDatabaseCommand,
  handleDatabaseAutocomplete,
};
