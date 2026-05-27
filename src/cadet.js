const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { EMBED_COLOR, RA_STAFF_ROLE_IDS, PROBATIONARY_OFFICER_ROLE_ID, CADET_ENROLL_COOLDOWN_MS } = require("./constants");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { isOnCooldown, setCooldown, getCooldownRemainingMs } = require("./cooldowns");
const { getRoleplayNameFromMember, updateMemberCallsign } = require("./discord-callsign");
const { assignMemberRosterRoles, sendCallsignDm } = require("./member-roster");
const { formatRoleplayInitials } = require("./roleplay-name");
const {
  isSheetsConfigured,
  assignMemberToOpenRank,
  assignCadetCallsign,
  clearRosterForName,
} = require("./google-sheets/roster-assign");
const { getProbationaryRankName } = require("./google-sheets/client");

const RA_COOLDOWN_MS = 15 * 60 * 1000;
const RA_COOLDOWN_TYPE = "ride-along";
const CADET_ENROLL_COOLDOWN_TYPE = "cadet-enroll";

const RA_CLAIM_PREFIX = "ra_claim:";
const RA_PASS_PREFIX = "ra_pass:";
const RA_FAIL_PREFIX = "ra_fail:";

const CADET_PANEL_COMMAND = "-becomecadetpanel";
const CADET_ENROLL_BUTTON_ID = "cadet_enroll";
const CADET_ENROLL_MODAL_ID = "cadet_enroll_modal";

const { CADET_ROLE_IDS } = require("./rank-options");

const RA_REQUEST_CHANNEL_ID = "1501730869961031770";
const RA_NOTIFICATION_CHANNEL_ID = "1485030495841681408";
const RA_PING_ROLE_IDS = RA_STAFF_ROLE_IDS;

const rideAlongRequests = new Map();

function canManageRideAlong(member) {
  return RA_STAFF_ROLE_IDS.some((roleId) => member?.roles?.cache?.has(roleId));
}

function formatCooldownDuration(remainingMs) {
  const totalMinutes = Math.ceil(remainingMs / 60000);
  if (totalMinutes >= 1440) {
    const days = Math.ceil(totalMinutes / 1440);
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (totalMinutes >= 60) {
    const hours = Math.ceil(totalMinutes / 60);
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return totalMinutes <= 1 ? "1 minute" : `${totalMinutes} minutes`;
}

function getRideAlongRequest(requestId) {
  return rideAlongRequests.get(requestId) ?? null;
}

function buildRideAlongEmbed(request) {
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Ride-Along Request")
    .setDescription(`Submitted by <@${request.applicantId}> in <#${RA_REQUEST_CHANNEL_ID}>`)
    .addFields(
      { name: "Roblox User", value: request.robloxUser, inline: true },
      { name: "Discord User", value: request.discordUser, inline: true },
      { name: "Available For", value: request.availableFor, inline: false },
    )
    .setURL(request.requestUrl);

  if (request.roleplayName) {
    embed.addFields({ name: "Roster Name", value: request.roleplayName, inline: true });
  }

  if (request.claimedById) {
    embed.addFields({
      name: "Claimed By",
      value: `<@${request.claimedById}>`,
      inline: true,
    });
  }

  if (request.status === "passed") {
    embed.setTitle("Ride-Along — Passed");
    embed.addFields({ name: "Result", value: `Passed by <@${request.resolvedById}>`, inline: false });
    if (request.rosterCallsign) {
      embed.addFields({
        name: "Assigned Callsign",
        value: `**${request.rosterCallsign}** (${request.rosterRank ?? "Probationary Officer"})`,
        inline: false,
      });
    }
  } else if (request.status === "failed") {
    embed.setTitle("Ride-Along — Failed");
    embed.addFields({ name: "Result", value: `Failed by <@${request.resolvedById}>`, inline: false });
  }

  return embed;
}

function buildRideAlongButtons(request) {
  if (request.status === "passed" || request.status === "failed") {
    return [];
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RA_CLAIM_PREFIX}${request.requestId}`)
      .setLabel(request.claimedById ? "Claimed" : "Claim")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(Boolean(request.claimedById)),
    new ButtonBuilder()
      .setCustomId(`${RA_PASS_PREFIX}${request.requestId}`)
      .setLabel("Pass")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!request.claimedById),
    new ButtonBuilder()
      .setCustomId(`${RA_FAIL_PREFIX}${request.requestId}`)
      .setLabel("Fail")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!request.claimedById),
  );

  return [row];
}

function buildCadetPanelEmbed() {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(
      "# Become a Cadet\n\n" +
        "Click the button below to receive your **Cadet** roles and begin the ride-along process.\n\n" +
        "You will be asked for your **full roleplay name** (e.g. John Smith). The roster will list you as **J. Smith**.\n\n" +
        "After enrolling, you must complete **2 ride-alongs** before you can become a **Probationary Officer**.\n\n" +
        `File a ride-along request in <#${RA_REQUEST_CHANNEL_ID}> when you are ready.\n\n` +
        "**Format:**\n" +
        "```\nRoblox User:\nDiscord User:\nAvailable For:\n```",
    )
    .setFooter({ text: "Fort Worth Police Department" });
}

function buildCadetEnrollButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CADET_ENROLL_BUTTON_ID)
      .setLabel("Become Cadet")
      .setStyle(ButtonStyle.Success),
  );
}

async function handleCadetPanelCommand(message) {
  if (message.content.trim().toLowerCase() !== CADET_PANEL_COMMAND) return false;
  if (message.author.bot) return false;

  if (hasProcessed(`panel:${message.id}`)) return true;
  markProcessed(`panel:${message.id}`);

  if (!message.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    await message.reply("You need **Manage Server** permission to post the cadet panel.");
    return true;
  }

  if (message.deletable) {
    await message.delete().catch(() => {});
  }

  await message.channel.send({
    embeds: [buildCadetPanelEmbed()],
    components: [buildCadetEnrollButton()],
  });

  return true;
}

function buildCadetEnrollModal() {
  return new ModalBuilder()
    .setCustomId(CADET_ENROLL_MODAL_ID)
    .setTitle("Become Cadet")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("roleplay_name")
          .setLabel("Full roleplay name")
          .setPlaceholder("e.g. John Smith")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64),
      ),
    );
}

async function handleCadetInteraction(interaction) {
  if (interaction.isButton() && interaction.customId === CADET_ENROLL_BUTTON_ID) {
    const member = interaction.member;
    if (!member) {
      await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
      return true;
    }

    if (isOnCooldown(member.id, CADET_ENROLL_COOLDOWN_TYPE)) {
      const remainingMs = getCooldownRemainingMs(member.id, CADET_ENROLL_COOLDOWN_TYPE);
      await interaction.reply({
        content: `You cannot become a cadet again yet. Try again in **${formatCooldownDuration(remainingMs)}**.`,
        ephemeral: true,
      });
      return true;
    }

    await interaction.showModal(buildCadetEnrollModal());
    return true;
  }

  if (!interaction.isModalSubmit() || interaction.customId !== CADET_ENROLL_MODAL_ID) {
    return false;
  }

  const member = interaction.member;
  if (!member) {
    await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  if (isOnCooldown(member.id, CADET_ENROLL_COOLDOWN_TYPE)) {
    const remainingMs = getCooldownRemainingMs(member.id, CADET_ENROLL_COOLDOWN_TYPE);
    await interaction.editReply(
      `You cannot become a cadet again yet. Try again in **${formatCooldownDuration(remainingMs)}**.`,
    );
    return true;
  }

  let roleplayName;
  let roleplayNameRaw;
  try {
    roleplayNameRaw = interaction.fields.getTextInputValue("roleplay_name").trim();
    roleplayName = formatRoleplayInitials(roleplayNameRaw);
  } catch (error) {
    await interaction.editReply(error.message);
    return true;
  }

  const rolesToAdd = CADET_ROLE_IDS.filter((roleId) => !member.roles.cache.has(roleId));

  if (rolesToAdd.length > 0) {
    await member.roles.add(rolesToAdd, "Become Cadet").catch((error) => {
      console.error("Failed to assign cadet roles:", error);
    });
  }

  await assignMemberRosterRoles(member, "Become Cadet");

  let reply =
    `You have been enrolled as a **Cadet** and received your cadet roles.\n\n` +
    `Your roster name is **${roleplayName}** (from *${roleplayNameRaw}*).\n\n` +
    "You must complete **2 ride-alongs** before you can become a **Probationary Officer**.\n\n" +
    `When you are ready, file a ride-along request in <#${RA_REQUEST_CHANNEL_ID}> using this format:\n` +
    "```\nRoblox User:\nDiscord User:\nAvailable For:\n```";

  if (isSheetsConfigured()) {
    try {
      const cadetAssignment = await assignCadetCallsign(roleplayName);
      const nicknameResult = await updateMemberCallsign(
        member,
        cadetAssignment.callsign,
        roleplayName,
      );

      reply +=
        `\n\nYour assigned **cadet callsign** is **${cadetAssignment.callsign}**.` +
        "\n**Do not use this callsign in-game.** You are not officially part of the department until you pass Fast Pass and receive a department callsign.";

      if (nicknameResult.ok && nicknameResult.changed) {
        reply += `\nYour Discord nickname was updated to \`${nicknameResult.nickname}\`.`;
      }

      await sendCallsignDm(member.user, {
        callsign: cadetAssignment.callsign,
        roleplayName,
        rank: cadetAssignment.rank,
        isCadet: true,
        title: "You have been enrolled as a **Cadet**.",
        extraLines: nicknameResult.ok && nicknameResult.changed
          ? [`Your Discord nickname is now \`${nicknameResult.nickname}\`.`]
          : [],
      });
    } catch (error) {
      console.error("Cadet callsign assignment failed:", error);
      reply += `\n\nCould not assign a cadet callsign on the roster: ${error.message}`;
    }
  } else {
    reply += "\n\nRoster assignment is not configured yet. Contact staff for your cadet callsign.";
  }

  await interaction.editReply({ content: reply });

  return true;
}

function parseRideAlongMessage(content) {
  const block = content.trim();

  const labeledMatch = block.match(
    /Roblox User:\s*(.+?)\s*Discord User:\s*(.+?)\s*Available For:\s*(.+)/is,
  );

  if (labeledMatch) {
    return {
      robloxUser: labeledMatch[1].trim(),
      discordUser: labeledMatch[2].trim(),
      availableFor: labeledMatch[3].trim(),
    };
  }

  const robloxMatch = block.match(/Roblox User:\s*([\s\S]*?)(?=\r?\n\s*Discord User:|$)/i);
  const discordMatch = block.match(/Discord User:\s*([\s\S]*?)(?=\r?\n\s*Available For:|$)/i);
  const availableMatch = block.match(/Available For:\s*([\s\S]*?)$/i);

  if (!robloxMatch || !discordMatch || !availableMatch) {
    return null;
  }

  return {
    robloxUser: robloxMatch[1].trim(),
    discordUser: discordMatch[1].trim(),
    availableFor: availableMatch[1].trim(),
  };
}

function formatCooldownMinutes(remainingMs) {
  const minutes = Math.ceil(remainingMs / 60000);
  return minutes <= 1 ? "1 minute" : `${minutes} minutes`;
}

async function handleRideAlongMessage(message) {
  if (message.author.bot || !message.guild) return false;
  if (message.channel.id !== RA_REQUEST_CHANNEL_ID) return false;
  if (hasProcessed(`ra:${message.id}`)) return false;

  markProcessed(`ra:${message.id}`);

  const parsed = parseRideAlongMessage(message.content);
  if (!parsed || !parsed.robloxUser || !parsed.discordUser || !parsed.availableFor) {
    return true;
  }

  if (isOnCooldown(message.author.id, RA_COOLDOWN_TYPE)) {
    const remainingMs = getCooldownRemainingMs(message.author.id, RA_COOLDOWN_TYPE);
    await message
      .reply(
        `You can only send one ride-along request every **15 minutes**. Try again in **${formatCooldownMinutes(remainingMs)}**.`,
      )
      .catch(() => null);
    return true;
  }

  const notificationChannel = await message.client.channels
    .fetch(RA_NOTIFICATION_CHANNEL_ID)
    .catch(() => null);

  if (!notificationChannel?.isTextBased()) {
    console.error("Ride-along notification channel not found:", RA_NOTIFICATION_CHANNEL_ID);
    return true;
  }

  const rolePings = RA_PING_ROLE_IDS.map((id) => `<@&${id}>`).join(" ");
  const requestId = message.id;

  const request = {
    requestId,
    applicantId: message.author.id,
    applicantTag: message.author.tag,
    guildId: message.guild.id,
    requestUrl: message.url,
    roleplayName: getRoleplayNameFromMember(message.member),
    robloxUser: parsed.robloxUser,
    discordUser: parsed.discordUser,
    availableFor: parsed.availableFor,
    status: "pending",
    claimedById: null,
    resolvedById: null,
  };

  rideAlongRequests.set(requestId, request);

  const notificationMessage = await notificationChannel.send({
    content: `${rolePings}\n\nA **ride-along request** is pending.\n[Jump to request](${message.url})`,
    embeds: [buildRideAlongEmbed(request)],
    components: buildRideAlongButtons(request),
    allowedMentions: { roles: RA_PING_ROLE_IDS },
  });

  request.notificationMessageId = notificationMessage.id;
  request.notificationChannelId = notificationMessage.channel.id;

  setCooldown(message.author.id, RA_COOLDOWN_MS, RA_COOLDOWN_TYPE);

  return true;
}

async function updateRideAlongNotification(client, request) {
  if (!request.notificationChannelId || !request.notificationMessageId) return;

  const channel = await client.channels.fetch(request.notificationChannelId).catch(() => null);
  const notificationMessage = await channel?.messages
    .fetch(request.notificationMessageId)
    .catch(() => null);

  if (!notificationMessage) return;

  await notificationMessage.edit({
    embeds: [buildRideAlongEmbed(request)],
    components: buildRideAlongButtons(request),
  });
}

async function handleRideAlongInteraction(interaction) {
  if (!interaction.isButton()) return false;

  let action = null;
  let requestId = null;

  if (interaction.customId.startsWith(RA_CLAIM_PREFIX)) {
    action = "claim";
    requestId = interaction.customId.slice(RA_CLAIM_PREFIX.length);
  } else if (interaction.customId.startsWith(RA_PASS_PREFIX)) {
    action = "pass";
    requestId = interaction.customId.slice(RA_PASS_PREFIX.length);
  } else if (interaction.customId.startsWith(RA_FAIL_PREFIX)) {
    action = "fail";
    requestId = interaction.customId.slice(RA_FAIL_PREFIX.length);
  } else {
    return false;
  }

  if (!canManageRideAlong(interaction.member)) {
    await interaction.reply({
      content: "You do not have permission to manage ride-along requests.",
      ephemeral: true,
    });
    return true;
  }

  const request = getRideAlongRequest(requestId);
  if (!request) {
    await interaction.reply({
      content: "This ride-along request is no longer active.",
      ephemeral: true,
    });
    return true;
  }

  if (request.status === "passed" || request.status === "failed") {
    await interaction.reply({ content: "This ride-along has already been resolved.", ephemeral: true });
    return true;
  }

  if (action === "claim") {
    if (request.claimedById) {
      await interaction.reply({
        content: `Already claimed by <@${request.claimedById}>.`,
        ephemeral: true,
      });
      return true;
    }

    request.claimedById = interaction.user.id;
    await updateRideAlongNotification(interaction.client, request);
    await interaction.reply({ content: "You claimed this ride-along.", ephemeral: true });
    return true;
  }

  if (request.claimedById !== interaction.user.id) {
    await interaction.reply({
      content: "Only the staff member who claimed this ride-along can pass or fail it.",
      ephemeral: true,
    });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const guild = await interaction.client.guilds.fetch(request.guildId).catch(() => null);
  const applicant = await guild?.members.fetch(request.applicantId).catch(() => null);

  if (!applicant) {
    await interaction.editReply("Could not find the applicant in this server.");
    return true;
  }

  if (action === "pass") {
    const roleplayName = request.roleplayName || getRoleplayNameFromMember(applicant);
    const probationaryRank = getProbationaryRankName();

    if (!isSheetsConfigured()) {
      await interaction.editReply(
        "Cannot pass ride-along — Google Sheets is not configured on the bot.",
      );
      return true;
    }

    let rosterResult;
    try {
      rosterResult = await assignMemberToOpenRank(roleplayName, probationaryRank);
    } catch (error) {
      console.error("Ride-along pass roster assignment failed:", error);
      await interaction.editReply(
        `Could not pass ride-along — roster update failed.\n\n${error.message}\n\n` +
          "Add open **Probationary Officer** rows on the sheet (4-digit callsign, empty RP NAME), then try again.",
      );
      return true;
    }

    await applicant.roles.remove(CADET_ROLE_IDS).catch((error) => {
      console.error("Failed to remove cadet roles on pass:", error);
    });
    await applicant.roles.add(PROBATIONARY_OFFICER_ROLE_ID).catch((error) => {
      console.error("Failed to assign probationary officer role:", error);
    });
    await assignMemberRosterRoles(applicant, "Ride-along pass");

    const nicknameResult = await updateMemberCallsign(
      applicant,
      rosterResult.newCallsign,
      roleplayName,
    );

    request.status = "passed";
    request.resolvedById = interaction.user.id;
    request.rosterCallsign = rosterResult.newCallsign;
    request.rosterRank = rosterResult.newRank;
    request.roleplayName = roleplayName;
    await updateRideAlongNotification(interaction.client, request);

    let staffNote = `Moved **${roleplayName}** from **${rosterResult.previousCallsign ?? "cadet"}** to **${rosterResult.newCallsign}** (${rosterResult.newRank}).`;
    if (!nicknameResult.ok) {
      staffNote += ` Nickname not updated: ${nicknameResult.reason}`;
    } else if (nicknameResult.changed) {
      staffNote += ` Nickname: \`${nicknameResult.nickname}\`.`;
    }

    await sendCallsignDm(applicant.user, {
      callsign: rosterResult.newCallsign,
      roleplayName,
      rank: rosterResult.newRank,
      title:
        "Your ride-along has been marked **Passed**.\n\nYou have been promoted to **Probationary Officer**.",
      extraLines:
        nicknameResult.ok && nicknameResult.changed
          ? [`Your Discord nickname is now \`${nicknameResult.nickname}\`.`]
          : [],
    });

    await interaction.editReply(`Marked **Passed** for ${applicant}.\n${staffNote}`);
    return true;
  }

  await applicant.roles.remove(CADET_ROLE_IDS).catch((error) => {
    console.error("Failed to remove cadet roles on fail:", error);
  });
  setCooldown(applicant.id, CADET_ENROLL_COOLDOWN_MS, CADET_ENROLL_COOLDOWN_TYPE);

  if (isSheetsConfigured()) {
    try {
      await clearRosterForName(getRoleplayNameFromMember(applicant));
    } catch (error) {
      console.error("Ride-along fail roster clear failed:", error);
    }
  }

  request.status = "failed";
  request.resolvedById = interaction.user.id;
  await updateRideAlongNotification(interaction.client, request);

  await applicant.user
    .send(
      "Your ride-along has been marked **Failed**.\n\n" +
        "Your cadet roles were removed. You may try again in **3 days** using **Become Cadet**.",
    )
    .catch(() => null);

  await interaction.editReply(`Marked **Failed** for ${applicant}. They cannot re-enroll as cadet for 3 days.`);
  return true;
}

module.exports = {
  handleCadetPanelCommand,
  handleCadetInteraction,
  handleRideAlongMessage,
  handleRideAlongInteraction,
};
