const { EmbedBuilder } = require("discord.js");
const { EMBED_COLOR } = require("./constants");
const { isSheetsConfigured } = require("./google-sheets/client");
const {
  PROMOTION_CHANNEL_ID,
  parsePromotionMessage,
  processPromotion,
} = require("./google-sheets/promotion");
const { hasProcessed, markProcessed } = require("./panel-dedupe");

async function handlePromotionMessage(message) {
  if (message.author.bot || !message.guild) return false;
  if (message.channel.id !== PROMOTION_CHANNEL_ID) return false;

  const parsed = parsePromotionMessage(message.content);
  if (!parsed) return false;

  if (hasProcessed(`promotion:${message.id}`)) return true;
  markProcessed(`promotion:${message.id}`);

  if (!isSheetsConfigured()) {
    await message.reply(
      "Google Sheets is not configured on this bot yet. An admin must add the service account credentials (see `docs/google-sheets-setup.md`).",
    );
    return true;
  }

  const processingMessage = await message.reply("Updating roster in Google Sheets...");

  try {
    const result = await processPromotion(parsed);

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

    if (result.division) {
      embed.addFields({ name: "Division", value: result.division, inline: true });
    }

    await processingMessage.edit({ content: null, embeds: [embed] });
  } catch (error) {
    console.error("Promotion update failed:", error);
    await processingMessage.edit(`Roster update failed: ${error.message}`);
  }

  return true;
}

module.exports = {
  handlePromotionMessage,
};
