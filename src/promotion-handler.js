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
const { logRosterResultAudit } = require("./roster-audit-log");

const ROLE_REQUEST_DELETE_MS = 3 * 60 * 1000;

function buildPromotionSuccessPayload(parsed, result, nicknameResult) {
  let nicknameField;
  if (nicknameResult.ok && nicknameResult.changed) {
    nicknameField = `Updated to \`${nicknameResult.nickname}\``;
  } else if (nicknameResult.ok && !nicknameResult.changed) {
    nicknameField = "Already had the correct callsign format.";
  } else {
    nicknameField = `Could not update: ${nicknameResult.reason}`;
  }

  return buildV2EditPayload({
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
  });
}

async function runPromotionUpdate({ client, authorMember, targetMember, parsed, staffBypass }) {
  if (!isSheetsConfigured()) {
    return {
      ok: false,
      message: getSheetsConfigHelpMessage() ?? "Google Sheets is not configured on this bot.",
    };
  }

  const requesterCheck = validatePromotionRequester(authorMember, parsed, { staffBypass });
  if (!requesterCheck.ok) {
    return { ok: false, message: requesterCheck.message };
  }

  const memberToUpdate = staffBypass && targetMember ? targetMember : requesterCheck.targetMember;

  if (!memberToUpdate) {
    return {
      ok: false,
      message:
        "Could not find a Discord member for this update. They need `callsign | Name` in their nickname (e.g. `3401 | J. Smith`).",
    };
  }

  const rankCheck = validatePromotionRank(memberToUpdate, parsed.newRank, {
    bypass: staffBypass,
  });

  if (!rankCheck.ok) {
    return { ok: false, message: rankCheck.message };
  }

  try {
    const result = await processPromotion(parsed);

    const nicknameResult = await updateMemberCallsign(
      memberToUpdate,
      result.newCallsign,
      parsed.roleplayName,
    );

    recordMemberRosterLinkFromResult(memberToUpdate, result);

    if (client && memberToUpdate.guild) {
      await logRosterResultAudit(client, memberToUpdate.guild.id, {
        trigger: staffBypass ? "Staff promotion (/database)" : "Promotion channel",
        actor: authorMember,
        target: memberToUpdate,
        roleplayName: parsed.roleplayName,
        rosterResult: result,
      }).catch(() => null);
    }

    return { ok: true, result, nicknameResult, memberToUpdate };
  } catch (error) {
    console.error("Promotion update failed:", error);
    return { ok: false, message: `Roster update failed: ${error.message}` };
  }
}

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
  if (!parsed) {
    if (/roleplay name|rp name|new rank|current callsign/i.test(message.content)) {
      await message.reply(
        "Use **`/database`** instead of typing a formatted message.\n\n" +
          "Pick your **new rank** from the list — your name and callsign are read from your nickname (`callsign | Name`) automatically.",
      );
      return true;
    }
    return false;
  }

  if (hasProcessed(`promotion:${message.id}`)) return true;
  markProcessed(`promotion:${message.id}`);

  const staffBypass = canBypassRankEligibility(message.member);

  const targetMember = staffBypass
    ? await findMemberForRosterEntry(message.guild, parsed)
    : message.member;

  const processingMessage = await message.reply("Updating roster in Google Sheets...");

  const outcome = await runPromotionUpdate({
    client: message.client,
    authorMember: message.member,
    targetMember,
    parsed,
    staffBypass,
  });

  if (!outcome.ok) {
    await processingMessage.edit(outcome.message);
    return true;
  }

  await processingMessage.edit(
    buildPromotionSuccessPayload(parsed, outcome.result, outcome.nicknameResult),
  );
  scheduleRoleRequestCleanup(message);
  return true;
}

module.exports = {
  handlePromotionMessage,
  runPromotionUpdate,
  buildPromotionSuccessPayload,
};
