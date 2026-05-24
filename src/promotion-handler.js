const { EmbedBuilder } = require("discord.js");
const { EMBED_COLOR } = require("./constants");
const { isSheetsConfigured, getSheetsConfigHelpMessage } = require("./google-sheets/client");
const {
  PROMOTION_CHANNEL_ID,
  parsePromotionMessage,
  processPromotion,
} = require("./google-sheets/promotion");
const { findMemberForRosterEntry, updateMemberCallsign } = require("./discord-callsign");
const {
  canBypassRankEligibility,
  validatePromotionRequester,
} = require("./promotion-auth");
const { validatePromotionRank } = require("./rank-eligibility");
const { hasProcessed, markProcessed } = require("./panel-dedupe");

const ROLE_REQUEST_DELETE_MS = 3 * 60 * 1000;

function scheduleRoleRequestCleanup(requestMessage) {
  requestMessage.react("✅").catch((error) => {
    console.warn("Could not react to promotion message:", error.message);
  });

  setTimeout(() => {
    requestMessage.delete().catch((error) => {
      console.warn("Could not delete promotion message:", error.message);
    });
  }, ROLE_REQUEST_DELETE_MS);
}

async function handlePromotionMessage(message) {
  if (message.author.bot || !message.guild) return false;
  if (message.channel.id !== PROMOTION_CHANNEL_ID) return false;

  const parsed = parsePromotionMessage(message.content);
  if (!parsed) return false;

  if (hasProcessed(`promotion:${message.id}`)) return true;
  markProcessed(`promotion:${message.id}`);

  if (!isSheetsConfigured()) {
    await message.reply(getSheetsConfigHelpMessage());
    return true;
  }

  const staffBypass = canBypassRankEligibility(message.member);

  const requesterCheck = validatePromotionRequester(message.member, parsed, { staffBypass });
  if (!requesterCheck.ok) {
    await message.reply(requesterCheck.message);
    return true;
  }

  const targetMember = staffBypass
    ? await findMemberForRosterEntry(message.guild, parsed)
    : requesterCheck.targetMember;

  if (!targetMember) {
    await message.reply(
      "Could not find a Discord member for this promotion. They need their callsign or RP name in their nickname (e.g. `3000 | J. Forman`).",
    );
    return true;
  }

  const rankCheck = validatePromotionRank(targetMember, parsed.newRank, {
    bypass: staffBypass,
  });

  if (!rankCheck.ok) {
    await message.reply(rankCheck.message);
    return true;
  }

  const memberToUpdate = targetMember ?? rankCheck.member;
  const processingMessage = await message.reply("Updating roster in Google Sheets...");

  try {
    const result = await processPromotion(parsed);

    const nicknameResult = await updateMemberCallsign(
      memberToUpdate,
      result.newCallsign,
      parsed.roleplayName,
    );

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle("Roster Updated")
      .setDescription(
        `**${parsed.roleplayName}** was moved to a new rank slot in the roster.`,
      )
      .addFields(
        {
          name: "Previous",
          value: `${result.previousRank} — ${result.previousCallsign}`,
          inline: true,
        },
        {
          name: "New",
          value: `${result.newRank} — ${result.newCallsign}`,
          inline: true,
        },
      );

    if (result.rolls) {
      embed.addFields({ name: "Rolls / Role", value: result.rolls, inline: true });
    }

    if (nicknameResult.ok && nicknameResult.changed) {
      embed.addFields({
        name: "Discord nickname",
        value: `Updated to \`${nicknameResult.nickname}\``,
      });
    } else if (nicknameResult.ok && !nicknameResult.changed) {
      embed.addFields({
        name: "Discord nickname",
        value: "Already had the correct callsign format.",
      });
    } else {
      embed.addFields({
        name: "Discord nickname",
        value: `Could not update: ${nicknameResult.reason}`,
      });
    }

    await processingMessage.edit({ content: null, embeds: [embed] });
    scheduleRoleRequestCleanup(message);
  } catch (error) {
    console.error("Promotion update failed:", error);
    await processingMessage.edit(`Roster update failed: ${error.message}`);
  }

  return true;
}

module.exports = {
  handlePromotionMessage,
};
