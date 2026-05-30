const { buildV2EditPayload } = require("./v2-message");
const { isSheetsConfigured, getSheetsConfigHelpMessage } = require("./google-sheets/client");
const {
  PROMOTION_CHANNEL_ID,
  parsePromotionMessage,
  processPromotion,
} = require("./google-sheets/promotion");
const { findMemberForRosterEntry, updateMemberCallsign } = require("./discord-callsign");
const { recordMemberRosterLinkFromResult } = require("./roster-member-link");
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

    recordMemberRosterLinkFromResult(memberToUpdate, result);

    let nicknameField;
    if (nicknameResult.ok && nicknameResult.changed) {
      nicknameField = `Updated to \`${nicknameResult.nickname}\``;
    } else if (nicknameResult.ok && !nicknameResult.changed) {
      nicknameField = "Already had the correct callsign format.";
    } else {
      nicknameField = `Could not update: ${nicknameResult.reason}`;
    }

    await processingMessage.edit(
      buildV2EditPayload({
        title: "Roster Updated",
        description: `**${parsed.roleplayName}** was moved to a new rank slot in the roster.`,
        fields: [
          {
            name: "Previous",
            value: `${result.previousRank} — ${result.previousCallsign}`,
          },
          {
            name: "New",
            value: `${result.newRank} — ${result.newCallsign}`,
          },
          ...(result.rolls ? [{ name: "Rolls / Role", value: result.rolls }] : []),
          { name: "Discord nickname", value: nicknameField },
        ],
      }),
    );
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
