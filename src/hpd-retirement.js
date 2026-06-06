const {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const {
  HPD_EMOJI,
  HPD_RETIREMENT_KEEP_ROLE_IDS,
  IA_RELEASE_CHANNEL_ID,
  ROSTER_SYNC_ROLE_ID,
} = require("./constants");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { hasRosterSyncRole, isDepartmentMember } = require("./member-roster");
const { getRosterCallsignForMember } = require("./google-sheets/roster-match");
const { removeMemberRosterLink } = require("./roster-member-link");
const { clearCadetInactivityRecord } = require("./cadet-inactivity");
const { pauseRoleSyncForMember, pauseRoleSyncGlobally } = require("./role-sync-guard");
const {
  isSheetsConfigured,
  getSheetsConfigHelpMessage,
} = require("./google-sheets/client");
const { clearRosterForName } = require("./google-sheets/roster-assign");
const { resolveRoleplayNameForMember } = require("./google-sheets/roster-sync");
const { clearMemberNicknameCallsign, getMemberRankDisplay } = require("./internal-affairs");
const { logRosterAudit } = require("./roster-audit-log");
const { buildV2Payload } = require("./v2-message");

const HPD_RETIRE_BUTTON_ID = "hpd_retire";
const HPD_RETIRE_MODAL_ID = "hpd_retire_modal";
const HPD_RETIRE_REASON_FIELD = "retire_reason";

function canMemberRetire(member) {
  if (!member || member.user?.bot) return false;
  return hasRosterSyncRole(member) || isDepartmentMember(member);
}

function buildRetirementModal() {
  return new ModalBuilder()
    .setCustomId(HPD_RETIRE_MODAL_ID)
    .setTitle("Retire from HPD")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(HPD_RETIRE_REASON_FIELD)
          .setLabel("Reason for retiring")
          .setPlaceholder("Briefly explain why you are retiring from HPD")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
}

function buildRetirementReleaseMessage({ rankLabel, userId, reason }) {
  return buildV2Payload({
    title: `${HPD_EMOJI} | Retirement Notice`,
    description:
      `${rankLabel}, <@${userId}> is retiring from the Houston Police Department for, **${reason}**. ` +
      "We thank them for their service and wish them well in their future endeavors.",
    allowedMentions: { users: [userId] },
  });
}

async function applyRetirementRoles(member) {
  const keepRoleIds = new Set([member.guild.id, ...HPD_RETIREMENT_KEEP_ROLE_IDS]);
  const toRemove = member.roles.cache
    .filter((role) => !keepRoleIds.has(role.id))
    .map((role) => role.id);

  if (toRemove.length > 0) {
    await member.roles.remove(toRemove, "HPD retirement");
  }

  const toAdd = HPD_RETIREMENT_KEEP_ROLE_IDS.filter((roleId) => !member.roles.cache.has(roleId));
  if (toAdd.length > 0) {
    await member.roles.add(toAdd, "HPD retirement — restore member role");
  }

  return { removed: toRemove.length, kept: [...keepRoleIds].filter((id) => id !== member.guild.id) };
}

async function processMemberRetirement(client, member, reason) {
  if (!canMemberRetire(member)) {
    throw new Error("You are not on the department roster and cannot retire through this panel.");
  }

  if (!isSheetsConfigured()) {
    throw new Error(getSheetsConfigHelpMessage() ?? "Google Sheets is not configured on this bot.");
  }

  pauseRoleSyncGlobally(45_000);
  pauseRoleSyncForMember(member, 120_000);

  const roleplayName = await resolveRoleplayNameForMember(member, member.user.username);
  const currentCallsign = getRosterCallsignForMember(member);
  const rankLabel = await getMemberRankDisplay(member);

  const clearedCount = await clearRosterForName(roleplayName, { currentCallsign, member });

  removeMemberRosterLink(member);
  clearCadetInactivityRecord(member.id);

  const nicknameResult = await clearMemberNicknameCallsign(member, roleplayName);
  const roleResult = await applyRetirementRoles(await member.guild.members.fetch({ user: member.id, force: true }));

  await logRosterAudit(client, member.guild.id, {
    title: "HPD retirement",
    actor: member,
    target: member,
    roleplayName,
    callsign: currentCallsign || undefined,
    trigger: "Employee resources — Retire",
    notes: `${reason}\nCleared ${clearedCount} roster row(s). Removed ${roleResult.removed} role(s).`,
  }).catch(() => null);

  const releaseChannel = await client.channels.fetch(IA_RELEASE_CHANNEL_ID).catch(() => null);
  if (releaseChannel?.isTextBased()) {
    await releaseChannel
      .send(buildRetirementReleaseMessage({ rankLabel, userId: member.id, reason }))
      .catch(() => null);
  }

  await member.user
    .send(
      "Your **HPD retirement** has been processed.\n\n" +
        `**Reason submitted:** ${reason}\n\n` +
        "Your department roles and roster entry were removed, and your callsign was cleared from your nickname.\n\n" +
        "Thank you for your service with the Houston Police Department.",
    )
    .catch(() => null);

  return {
    roleplayName,
    clearedCount,
    nicknameResult,
    roleResult,
    releasePosted: Boolean(releaseChannel?.isTextBased()),
  };
}

async function handleHpdRetirementInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === HPD_RETIRE_BUTTON_ID) {
    if (!interaction.guild || !interaction.member) {
      await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
      return true;
    }

    if (!canMemberRetire(interaction.member)) {
      await interaction.reply({
        content: "You must be on the department roster to retire through this panel.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.showModal(buildRetirementModal());
    return true;
  }

  if (!interaction.isModalSubmit() || interaction.customId !== HPD_RETIRE_MODAL_ID) {
    return false;
  }

  if (hasProcessed(`interaction:${interaction.id}`)) return true;
  markProcessed(`interaction:${interaction.id}`);

  if (!interaction.guild || !interaction.member) {
    await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
    return true;
  }

  const reason = interaction.fields.getTextInputValue(HPD_RETIRE_REASON_FIELD).trim();
  if (!reason) {
    await interaction.reply({ content: "A reason is required to retire.", ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await processMemberRetirement(interaction.client, interaction.member, reason);

    const lines = [
      "Your retirement from **HPD** has been submitted.",
      "",
      result.clearedCount > 0
        ? "Your roster entry was removed from the database."
        : "No matching roster row was found on the database (roles and nickname were still updated).",
      `Removed **${result.roleResult.removed}** department role(s).`,
    ];

    if (HPD_RETIREMENT_KEEP_ROLE_IDS.length > 0) {
      lines.push(`Kept member role(s): ${HPD_RETIREMENT_KEEP_ROLE_IDS.map((id) => `<@&${id}>`).join(", ")}.`);
    }

    if (result.nicknameResult?.ok && result.nicknameResult.changed) {
      lines.push(`Nickname updated to \`${result.nicknameResult.nickname}\`.`);
    } else if (result.nicknameResult && !result.nicknameResult.ok) {
      lines.push(`Nickname not updated: ${result.nicknameResult.reason}`);
    }

    if (result.releasePosted) {
      lines.push(`A retirement notice was posted in <#${IA_RELEASE_CHANNEL_ID}>.`);
    }

    await interaction.editReply({ content: lines.join("\n") });
  } catch (error) {
    console.error("[hpd-retirement] Failed:", error);
    await interaction.editReply({
      content: error.message ?? "Could not process your retirement. Contact staff for help.",
    });
  }

  return true;
}

module.exports = {
  HPD_RETIRE_BUTTON_ID,
  handleHpdRetirementInteraction,
  canMemberRetire,
  processMemberRetirement,
};
