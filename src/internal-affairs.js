const {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require("discord.js");
const {
  EMBED_COLOR,
  INFRACTION_ROLE_ID,
  IA_RELEASE_CHANNEL_ID,
  ROSTER_SYNC_ROLE_ID,
  MEMBER_ROSTER_ROLE_IDS,
} = require("./constants");
const { ranksMatch } = require("./rank-matching");
const {
  formatCallsignForDisplay,
  getRoleplayNameFromMember,
  updateMemberCallsign,
} = require("./discord-callsign");
const { getRosterCallsignForMember } = require("./google-sheets/roster-match");
const {
  recordMemberRosterLinkFromResult,
  removeMemberRosterLink,
} = require("./roster-member-link");
const { getRosterLink } = require("./roster-links-store");
const {
  isSheetsConfigured,
  getSheetsConfigHelpMessage,
  getRosterRows,
} = require("./google-sheets/client");
const {
  assignMemberToOpenRank,
  clearRosterForName,
} = require("./google-sheets/roster-assign");
const { getNamedRosterEntries, findRosterEntryForMember } = require("./google-sheets/roster-lookup");
const { getRosterRanksWithOpenSlots } = require("./google-sheets/roster-ranks");
const {
  getOrderedRanksFromEntries,
  resolveRoleplayNameForMember,
} = require("./google-sheets/roster-sync");
const { addInfraction, getInfractionsForUser } = require("./infractions-store");

const INFRACTION_COMMAND = "infraction";
const INFO_COMMAND = "info";
const AUTOCOMPLETE_MAX = 25;

const INFRACTION_TYPES = ["Warning", "Strike", "Suspension", "Demotion", "Termination"];

const EXCLUDED_RANK_ROLE_IDS = new Set([
  ROSTER_SYNC_ROLE_ID,
  INFRACTION_ROLE_ID,
  ...MEMBER_ROSTER_ROLE_IDS,
]);

function canRunInfraction(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  return member?.roles?.cache?.has(INFRACTION_ROLE_ID) ?? false;
}

function canRunInfo(member) {
  if (
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild)
  ) {
    return true;
  }

  return member?.roles?.cache?.has(ROSTER_SYNC_ROLE_ID) ?? false;
}

function getHighestRankRoleName(member) {
  const fallbackRole = [...member.roles.cache.values()]
    .filter((role) => role.id !== member.guild.id && !EXCLUDED_RANK_ROLE_IDS.has(role.id))
    .sort((left, right) => right.position - left.position)[0];

  return fallbackRole?.name ?? "Unknown Rank";
}

async function getMemberRankDisplay(member) {
  if (isSheetsConfigured()) {
    try {
      const { entries } = await getRosterRows();
      const orderedRanks = getOrderedRanksFromEntries(entries);

      for (const sheetRank of orderedRanks) {
        const role = member.roles.cache.find(
          (entry) =>
            entry.id !== member.guild.id &&
            !EXCLUDED_RANK_ROLE_IDS.has(entry.id) &&
            ranksMatch(sheetRank, entry.name),
        );

        if (role) {
          return role.name;
        }
      }
    } catch (error) {
      console.warn("Rank lookup from sheet failed, using Discord roles:", error.message);
    }
  }

  return getHighestRankRoleName(member);
}

function buildIAReleaseMessage({ rankLabel, userId, type, reason, newRank }) {
  const header = "**:FWPD: | Internal Affairs Release**";
  const mention = `<@${userId}>`;
  let body;

  switch (type) {
    case "Warning":
      body = `${rankLabel}, ${mention} has received a warning for, **${reason}**.`;
      break;
    case "Strike":
      body = `${rankLabel}, ${mention} has received a strike for, **${reason}**.`;
      break;
    case "Suspension":
      body = `${rankLabel}, ${mention} is being suspended for, **${reason}**.`;
      break;
    case "Demotion":
      body = `${rankLabel}, ${mention} is being demoted to ${newRank} for, **${reason}**.`;
      break;
    case "Termination":
      body =
        `${rankLabel}, ${mention} is being terminated for, **${reason}**. ` +
        "We thank you for all you have done for the department and wish you well on your future endeavors.";
      break;
    default:
      body = `${rankLabel}, ${mention} — **${type}** for, **${reason}**.`;
  }

  return `${header}\n\n${body}`;
}

async function sendInfractionDm(targetUser, { type, reason, rankLabel, rosterResult }) {
  const lines = [
    "**Internal Affairs Notice**",
    "",
    `You have received a department **${type}**.`,
    "",
    `**Rank:** ${rankLabel}`,
    `**Reason:** ${reason}`,
  ];

  if (type === "Demotion" && rosterResult) {
    lines.push(
      "",
      `You have been demoted to **${rosterResult.newRank}**.`,
      `**New callsign:** ${formatCallsignForDisplay(rosterResult.newCallsign)}`,
    );
  }

  if (type === "Termination") {
    lines.push("", "You have been removed from the department roster.");
  }

  try {
    await targetUser.send(lines.join("\n"));
    return true;
  } catch {
    return false;
  }
}

async function clearMemberNicknameCallsign(member, roleplayName) {
  if (!member?.manageable) {
    return { ok: false, reason: "Bot cannot change this member's nickname." };
  }

  const nickname = String(roleplayName ?? getRoleplayNameFromMember(member)).trim().slice(0, 32);
  if (!nickname || nickname === member.displayName) {
    return { ok: true, changed: false };
  }

  try {
    await member.setNickname(nickname, "Roster removal after termination");
    return { ok: true, changed: true, nickname };
  } catch (error) {
    return { ok: false, reason: error.message ?? "Failed to set nickname." };
  }
}

function buildInfractionCommand() {
  return new SlashCommandBuilder()
    .setName(INFRACTION_COMMAND)
    .setDescription("Issue an Internal Affairs infraction and post a department release")
    .addUserOption((option) =>
      option.setName("member").setDescription("Member receiving the infraction").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("Infraction type")
        .setRequired(true)
        .addChoices(
          ...INFRACTION_TYPES.map((type) => ({ name: type, value: type })),
        ),
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Reason for the infraction (shown in the release)")
        .setRequired(true)
        .setMaxLength(500),
    )
    .addStringOption((option) =>
      option
        .setName("new_rank")
        .setDescription("Required for demotions — roster rank to move them to")
        .setRequired(false)
        .setAutocomplete(true),
    );
}

function buildInfoCommand() {
  return new SlashCommandBuilder()
    .setName(INFO_COMMAND)
    .setDescription("View a member's roster details and infraction history")
    .addUserOption((option) =>
      option.setName("member").setDescription("Member to look up").setRequired(true),
    );
}

function formatRankChoiceName(rank, openCount) {
  const label = `${rank} (${openCount} open)`;
  return label.length > 100 ? `${rank.slice(0, 90)}… (${openCount} open)` : label;
}

async function handleInternalAffairsAutocomplete(interaction) {
  if (!interaction.isAutocomplete()) {
    return false;
  }

  if (interaction.commandName !== INFRACTION_COMMAND) {
    return false;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== "new_rank") {
    return false;
  }

  if (!canRunInfraction(interaction.member)) {
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
    console.error("Infraction autocomplete failed:", error);
    await interaction.respond([]);
  }

  return true;
}

async function handleInfractionCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== INFRACTION_COMMAND) {
    return false;
  }

  if (!canRunInfraction(interaction.member)) {
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

  const targetUser = interaction.options.getUser("member", true);
  const type = interaction.options.getString("type", true);
  const reason = interaction.options.getString("reason", true).trim();
  const newRank = interaction.options.getString("new_rank")?.trim() ?? "";

  if (!reason) {
    await interaction.reply({ content: "A reason is required.", ephemeral: true });
    return true;
  }

  if (type === "Demotion" && !newRank) {
    await interaction.reply({
      content: "Demotions require the **new_rank** option (roster rank with an open slot).",
      ephemeral: true,
    });
    return true;
  }

  if ((type === "Demotion" || type === "Termination") && !isSheetsConfigured()) {
    await interaction.reply({
      content: getSheetsConfigHelpMessage() ?? "Google Sheets is not configured on this bot.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const targetMember =
      (await interaction.guild.members.fetch(targetUser.id).catch(() => null)) ??
      interaction.guild.members.cache.get(targetUser.id);

    if (!targetMember) {
      await interaction.editReply({ content: "That member is not in this server." });
      return true;
    }

    const rankLabel = await getMemberRankDisplay(targetMember);
    let rosterResult = null;
    let nicknameResult = null;

    if (type === "Demotion" || type === "Termination") {
      const roleplayName = await resolveRoleplayNameForMember(targetMember, targetUser.username);
      const currentCallsign = getRosterCallsignForMember(targetMember);

      if (type === "Demotion") {
        rosterResult = await assignMemberToOpenRank(roleplayName, newRank, { currentCallsign });
        nicknameResult = await updateMemberCallsign(
          targetMember,
          rosterResult.newCallsign,
          rosterResult.roleplayName,
        );
        recordMemberRosterLinkFromResult(targetMember, rosterResult);
      } else {
        const clearedCount = await clearRosterForName(roleplayName, { currentCallsign });
        rosterResult = { cleared: true, clearedCount, roleplayName };
        removeMemberRosterLink(targetMember);
        nicknameResult = await clearMemberNicknameCallsign(targetMember, roleplayName);

        if (clearedCount === 0) {
          rosterResult.notOnSheet = true;
        }
      }
    }

    const releaseMessage = buildIAReleaseMessage({
      rankLabel,
      userId: targetUser.id,
      type,
      reason,
      newRank: rosterResult?.newRank ?? newRank,
    });

    const releaseChannel = await interaction.client.channels
      .fetch(IA_RELEASE_CHANNEL_ID)
      .catch(() => null);

    if (!releaseChannel?.isTextBased()) {
      await interaction.editReply({
        content: "Infraction recorded, but the Internal Affairs release channel could not be found.",
      });
      return true;
    }

    await releaseChannel.send(releaseMessage);

    const infractionRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      reason,
      rankAtTime: rankLabel,
      issuedById: interaction.user.id,
      issuedByTag: interaction.user.tag,
      issuedAt: new Date().toISOString(),
      rosterUpdate: rosterResult,
    };

    addInfraction(targetUser.id, infractionRecord);

    const dmSent = await sendInfractionDm(targetUser, {
      type,
      reason,
      rankLabel,
      rosterResult,
    });

    const summaryLines = [
      `**${type}** issued for ${targetMember}.`,
      `Release posted in <#${IA_RELEASE_CHANNEL_ID}>.`,
      dmSent ? "DM sent to the member." : "Could not DM the member (DMs may be closed).",
    ];

    if (type === "Demotion" && rosterResult) {
      summaryLines.push(
        "",
        `Roster updated: **${formatCallsignForDisplay(rosterResult.newCallsign)}** at **${rosterResult.newRank}**.`,
      );
      if (nicknameResult?.ok && nicknameResult.changed) {
        summaryLines.push(`Nickname updated to \`${nicknameResult.nickname}\`.`);
      } else if (nicknameResult && !nicknameResult.ok) {
        summaryLines.push(`Nickname not updated: ${nicknameResult.reason}`);
      }
    }

    if (type === "Termination" && rosterResult) {
      if (rosterResult.notOnSheet) {
        summaryLines.push("", "Member was not found on the roster (no sheet row cleared).");
      } else {
        summaryLines.push("", "Member removed from the Google roster.");
      }
      if (nicknameResult?.ok && nicknameResult.changed) {
        summaryLines.push(`Nickname reset to \`${nicknameResult.nickname}\`.`);
      }
    }

    await interaction.editReply({ content: summaryLines.join("\n") });
  } catch (error) {
    console.error("Infraction command failed:", error);
    await interaction.editReply({
      content: `Failed to issue infraction: ${error.message ?? "Unknown error"}`,
    });
  }

  return true;
}

function formatInfractionHistory(infractions) {
  if (infractions.length === 0) {
    return "No infractions on record.";
  }

  return infractions
    .slice(0, 10)
    .map((entry, index) => {
      const date = new Date(entry.issuedAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      return `**${index + 1}. ${entry.type}** — ${date}\n${entry.reason}\n*By ${entry.issuedByTag ?? entry.issuedById} · Rank at time: ${entry.rankAtTime}*`;
    })
    .join("\n\n");
}

async function handleInfoCommand(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== INFO_COMMAND) {
    return false;
  }

  if (!canRunInfo(interaction.member)) {
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

  const targetUser = interaction.options.getUser("member", true);

  await interaction.deferReply({ ephemeral: true });

  try {
    const targetMember =
      (await interaction.guild.members.fetch(targetUser.id).catch(() => null)) ??
      interaction.guild.members.cache.get(targetUser.id);

    const infractions = getInfractionsForUser(targetUser.id);
    const discordRank = targetMember ? await getMemberRankDisplay(targetMember) : "Not in server";
    const roleplayNameFromDiscord = targetMember
      ? getRoleplayNameFromMember(targetMember)
      : targetUser.username;
    const callsignFromDiscord = targetMember ? getRosterCallsignForMember(targetMember) : "";
    const rosterLink = getRosterLink(targetUser.id);

    let rosterEntry = null;
    if (isSheetsConfigured()) {
      const namedEntries = await getNamedRosterEntries();
      if (targetMember) {
        rosterEntry = findRosterEntryForMember(namedEntries, targetMember);
      }

      if (!rosterEntry && roleplayNameFromDiscord) {
        const byName = namedEntries.filter(
          (entry) => entry.name.toLowerCase() === roleplayNameFromDiscord.toLowerCase(),
        );
        if (byName.length === 1) {
          rosterEntry = byName[0];
        }
      }
    }

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(`Member info — ${targetUser.tag}`)
      .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
      .addFields(
        {
          name: "Discord",
          value: `${targetUser} (\`${targetUser.id}\`)`,
          inline: false,
        },
        {
          name: "Roleplay name",
          value: rosterEntry?.name ?? roleplayNameFromDiscord ?? "Unknown",
          inline: true,
        },
        {
          name: "Callsign",
          value: rosterEntry?.callsign
            ? formatCallsignForDisplay(rosterEntry.callsign)
            : callsignFromDiscord
              ? formatCallsignForDisplay(callsignFromDiscord)
              : "None",
          inline: true,
        },
        {
          name: "Roster rank",
          value: rosterEntry?.rank ?? "Not on roster",
          inline: true,
        },
        {
          name: "Discord rank",
          value: discordRank,
          inline: true,
        },
        {
          name: "Discord ↔ roster link",
          value: rosterLink
            ? `**${rosterLink.roleplayName}** · ${formatCallsignForDisplay(rosterLink.callsign)}` +
              (rosterLink.rowNumber ? ` · sheet row ${rosterLink.rowNumber}` : "")
            : "Not linked — use `/rosteradd` or any roster sync to link this account",
          inline: false,
        },
        {
          name: `Infractions (${infractions.length})`,
          value: formatInfractionHistory(infractions).slice(0, 1024),
          inline: false,
        },
      );

    if (rosterEntry?.rolls) {
      embed.addFields({
        name: "Rolls",
        value: String(rosterEntry.rolls).slice(0, 1024),
        inline: false,
      });
    }

    if (!isSheetsConfigured()) {
      embed.setFooter({ text: "Google Sheets is not configured — roster fields may be incomplete." });
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error("Info command failed:", error);
    await interaction.editReply({
      content: `Failed to load member info: ${error.message ?? "Unknown error"}`,
    });
  }

  return true;
}

module.exports = {
  buildInfractionCommand,
  buildInfoCommand,
  handleInternalAffairsAutocomplete,
  handleInfractionCommand,
  handleInfoCommand,
};
