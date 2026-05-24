const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
} = require("discord.js");
const { EMBED_COLOR } = require("./constants");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { isOnCooldown, setCooldown, getCooldownRemainingMs } = require("./cooldowns");
const { getRoleplayNameFromMember, updateMemberCallsign } = require("./discord-callsign");
const { isSheetsConfigured, assignCadetCallsign } = require("./google-sheets/roster-assign");

const RA_COOLDOWN_MS = 15 * 60 * 1000;
const RA_COOLDOWN_TYPE = "ride-along";

const CADET_PANEL_COMMAND = "-becomecadetpanel";
const CADET_ENROLL_BUTTON_ID = "cadet_enroll";

const CADET_ROLE_IDS = [
  "1495414411840454676",
  "1484951746852818944",
  "1484951786623205516",
];

const RA_REQUEST_CHANNEL_ID = "1501730869961031770";
const RA_NOTIFICATION_CHANNEL_ID = "1485030495841681408";
const RA_PING_ROLE_IDS = ["1484950653045440532", "1484950025472704643"];

function buildCadetPanelEmbed() {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setDescription(
      "# Become a Cadet\n\n" +
        "Click the button below to receive your **Cadet** roles and begin the ride-along process.\n\n" +
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

async function handleCadetInteraction(interaction) {
  if (!interaction.isButton() || interaction.customId !== CADET_ENROLL_BUTTON_ID) {
    return false;
  }

  const member = interaction.member;
  if (!member) {
    await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
    return true;
  }

  await interaction.deferReply({ ephemeral: true });

  const rolesToAdd = CADET_ROLE_IDS.filter((roleId) => !member.roles.cache.has(roleId));

  if (rolesToAdd.length > 0) {
    await member.roles.add(rolesToAdd).catch((error) => {
      console.error("Failed to assign cadet roles:", error);
    });
  }

  let reply =
    "You have been enrolled as a **Cadet** and received your cadet roles.\n\n" +
    "You must complete **2 ride-alongs** before you can become a **Probationary Officer**.\n\n" +
    `When you are ready, file a ride-along request in <#${RA_REQUEST_CHANNEL_ID}> using this format:\n` +
    "```\nRoblox User:\nDiscord User:\nAvailable For:\n```";

  if (isSheetsConfigured()) {
    const roleplayName = getRoleplayNameFromMember(member);

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
  const embed = new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle("Ride-Along Request")
    .setDescription(`Submitted by ${message.author} in <#${RA_REQUEST_CHANNEL_ID}>`)
    .addFields(
      { name: "Roblox User", value: parsed.robloxUser, inline: true },
      { name: "Discord User", value: parsed.discordUser, inline: true },
      { name: "Available For", value: parsed.availableFor, inline: false },
    )
    .setURL(message.url);

  await notificationChannel.send({
    content: `${rolePings}\n\nA **ride-along request** is pending.\n[Jump to request](${message.url})`,
    embeds: [embed],
    allowedMentions: { roles: RA_PING_ROLE_IDS },
  });

  setCooldown(message.author.id, RA_COOLDOWN_MS, RA_COOLDOWN_TYPE);

  return true;
}

module.exports = {
  handleCadetPanelCommand,
  handleCadetInteraction,
  handleRideAlongMessage,
};
