const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { RA_STAFF_ROLE_IDS, PROBATIONARY_OFFICER_ROLE_ID, CADET_ENROLL_COOLDOWN_MS, BOT_NAME } = require("./constants");
const { buildV2Payload, buildV2EditPayload } = require("./v2-message");
const { hasProcessed, markProcessed } = require("./panel-dedupe");
const { isOnCooldown, setCooldown, getCooldownRemainingMs } = require("./cooldowns");
const { getRoleplayNameFromMember, updateMemberCallsign } = require("./discord-callsign");
const {
  assignMemberRosterRoles,
  sendCallsignDm,
  isBlockedFromRecruitmentFlows,
  RECRUITMENT_BLOCKED_MESSAGE,
} = require("./member-roster");
const { pauseRoleSyncForMember, pauseRoleSyncGlobally } = require("./role-sync-guard");
const { formatRoleplayInitials } = require("./roleplay-name");
const {
  isSheetsConfigured,
  assignCadetCallsign,
  clearRosterForName,
} = require("./google-sheets/roster-assign");
const {
  resolveRoleplayNameForMember,
  promoteToProbationaryOnRoster,
} = require("./google-sheets/roster-sync");
const { getRosterCallsignForMember } = require("./google-sheets/roster-match");
const { logRosterAudit, logRosterResultAudit } = require("./roster-audit-log");
const {
  recordMemberRosterLinkFromResult,
  removeMemberRosterLink,
} = require("./roster-member-link");
const {
  getRideAlongRequest,
  saveRideAlongRequest,
  listActiveRideAlongRequests,
} = require("./ride-along-store");

const CADET_ENROLL_COOLDOWN_TYPE = "cadet-enroll";

const RA_CLAIM_PREFIX = "ra_claim:";
const RA_START_PREFIX = "ra_start:";
const RA_START_MODAL_PREFIX = "ra_start_modal:";
const RA_SCREENSHOT_UPLOAD_ID = "ridealong_screenshot";
const RA_NOTES_PREFIX = "ra_notes:";
const RA_END_PREFIX = "ra_end:";
const RA_SCORE_BUTTON_PREFIX = "ra_score_btn:";
const RA_NOTES_MODAL_PREFIX = "ra_notes_modal:";
const RA_SCORE_MODAL_PREFIX = "ra_score_modal:";
const RIDEALONG_DURATION_MS = 30 * 60 * 1000;
const RIDEALONG_PASSING_SCORE = 7.5;

const CADET_PANEL_COMMAND = "-becomecadetpanel";
const CADET_ENROLL_BUTTON_ID = "cadet_enroll";
const CADET_ENROLL_MODAL_ID = "cadet_enroll_modal";
const RIDEALONG_COMMAND_NAME = "ridealong";
const RIDEALONG_MODAL_ID = "ridealong_modal";

const { CADET_ROLE_IDS } = require("./rank-options");

/** Cadets use /ridealong here; request posts appear in this channel */
const RA_REQUEST_CHANNEL_ID = "1501730869961031770";
/** Staff Claim / Start / Notes / End buttons and pings */
const RA_NOTIFICATION_CHANNEL_ID = "1509320569852661891";
const RA_PING_ROLE_IDS = RA_STAFF_ROLE_IDS;

const rideAlongReminderTimeouts = new Map();

function persistRideAlongRequest(request) {
  if (!request?.requestId) return;
  saveRideAlongRequest(request.requestId, request);
}

function walkMessageComponents(components, matches = []) {
  for (const component of components ?? []) {
    if (component.customId) {
      matches.push(component);
    }
    if (component.components?.length) {
      walkMessageComponents(component.components, matches);
    }
  }
  return matches;
}

function extractTextFromMessageComponents(components) {
  const parts = [];

  for (const component of components ?? []) {
    const content = component.content ?? component.data?.content;
    if (content) {
      parts.push(content);
    }
    if (component.components?.length) {
      parts.push(extractTextFromMessageComponents(component.components));
    }
  }

  return parts.filter(Boolean).join("\n");
}

function parseRideAlongField(text, fieldName) {
  const pattern = new RegExp(`\\*\\*${fieldName}\\*\\*\\n([^\\n*]+)`, "i");
  return text.match(pattern)?.[1]?.trim() ?? "";
}

function parseRideAlongRequestFromText(text, { requestId, requestUrl, guildId }) {
  const applicantId = text.match(/<@(\d+)>/)?.[1];
  if (!applicantId) return null;

  const claimedById = text.match(/\*\*Claimed By\*\*\n<@(\d+)>/i)?.[1] ?? null;
  const startedById = text.match(/\*\*Ride-Along Started\*\*\n<@(\d+)>/i)?.[1] ?? null;

  return {
    requestId,
    applicantId,
    applicantTag: "",
    guildId,
    requestUrl,
    roleplayName: parseRideAlongField(text, "Roster Name") || undefined,
    robloxUser: parseRideAlongField(text, "Roblox User"),
    discordUser: parseRideAlongField(text, "Discord User"),
    availableFor: parseRideAlongField(text, "Available For"),
    status: "pending",
    claimedById,
    startedById,
    startedAt: startedById ? Date.now() : null,
    notes: [],
    score: null,
    resolvedById: null,
  };
}

async function findRideAlongNotificationMessage(client, requestId) {
  const notificationChannel = await client.channels
    .fetch(RA_NOTIFICATION_CHANNEL_ID)
    .catch(() => null);

  if (!notificationChannel?.isTextBased()) return null;

  const claimCustomId = `${RA_CLAIM_PREFIX}${requestId}`;
  const messages = await notificationChannel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return null;

  for (const message of messages.values()) {
    const buttons = walkMessageComponents(message.components);
    if (buttons.some((component) => component.customId === claimCustomId)) {
      return message;
    }
  }

  return null;
}

async function recoverRideAlongRequest(client, requestId) {
  const requestChannel = await client.channels.fetch(RA_REQUEST_CHANNEL_ID).catch(() => null);
  const requestMessage = await requestChannel?.messages.fetch(requestId).catch(() => null);
  if (!requestMessage) return null;

  const text = extractTextFromMessageComponents(requestMessage.components);
  const request = parseRideAlongRequestFromText(text, {
    requestId,
    requestUrl: requestMessage.url,
    guildId: requestMessage.guildId,
  });

  if (!request) return null;

  const notificationMessage = await findRideAlongNotificationMessage(client, requestId);
  if (notificationMessage) {
    request.notificationMessageId = notificationMessage.id;
    request.notificationChannelId = notificationMessage.channel.id;
  }

  return request;
}

async function resolveRideAlongRequest(client, requestId) {
  const existing = getRideAlongRequest(requestId);
  if (existing) return existing;

  const recovered = await recoverRideAlongRequest(client, requestId);
  if (recovered) {
    persistRideAlongRequest(recovered);
  }
  return recovered;
}

function restoreRideAlongReminders(client) {
  for (const request of listActiveRideAlongRequests()) {
    if (request.startedById && !rideAlongReminderTimeouts.has(request.requestId)) {
      scheduleRideAlongEndReminder(client, request);
    }
  }
}

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

function isImageAttachment(attachment) {
  const contentType = attachment.contentType ?? "";
  if (contentType.startsWith("image/")) {
    return true;
  }

  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment.name ?? "");
}

function buildRideAlongStartModal(requestId) {
  const fileUpload = new FileUploadBuilder()
    .setCustomId(RA_SCREENSHOT_UPLOAD_ID)
    .setRequired(true)
    .setMinValues(1)
    .setMaxValues(1);

  const label = new LabelBuilder()
    .setLabel("Screenshot of you and your cadet")
    .setDescription("Upload a screenshot showing you and the cadet together before the ride-along begins.")
    .setFileUploadComponent(fileUpload);

  return new ModalBuilder()
    .setCustomId(`${RA_START_MODAL_PREFIX}${requestId}`)
    .setTitle("Start Ride-Along")
    .addLabelComponents(label);
}

function getUploadedScreenshotFromModal(interaction) {
  const files = interaction.fields.getUploadedFiles(RA_SCREENSHOT_UPLOAD_ID);

  if (!files || files.size === 0) {
    return {
      ok: false,
      message: "Please upload a screenshot of you and your cadet.",
    };
  }

  const attachment = files.first();

  if (!isImageAttachment(attachment)) {
    return {
      ok: false,
      message: "The upload must be an image file (PNG, JPG, GIF, or WebP).",
    };
  }

  return {
    ok: true,
    url: attachment.url,
    attachmentId: attachment.id,
  };
}

async function completeRideAlongStart(interaction, request) {
  request.startedById = interaction.user.id;
  request.startedAt = Date.now();
  if (!request.notes) request.notes = [];
  scheduleRideAlongEndReminder(interaction.client, request);
  persistRideAlongRequest(request);
  await updateRideAlongNotification(interaction.client, request);

  await interaction.editReply({
    content:
      "**Ride-along started.**\n\n" +
      "Remember to **supervise your cadet at all times** and ensure they meet our standards.\n\n" +
      "Use **Notes** during the ride-along, then click **End Ride Along** when finished to review notes and submit a score.\n\n" +
      "You will be pinged here in **30 minutes** as a reminder to end the ride-along.",
  });
}

function buildRideAlongPayload(
  request,
  { headerText, actionRows, forEdit = false, allowedMentions } = {},
) {
  const title =
    request.status === "passed"
      ? "Ride-Along — Passed"
      : request.status === "failed"
        ? "Ride-Along — Failed"
        : "Ride-Along Request";

  let description = headerText ? `${headerText}\n\n` : "";
  description +=
    `Submitted by <@${request.applicantId}> in <#${RA_REQUEST_CHANNEL_ID}>` +
    (request.requestUrl ? `\n[View request](${request.requestUrl})` : "");

  const fields = [
    { name: "Roblox User", value: request.robloxUser },
    { name: "Discord User", value: request.discordUser },
    { name: "Available For", value: request.availableFor },
  ];

  if (request.roleplayName) {
    fields.push({ name: "Roster Name", value: request.roleplayName });
  }

  if (request.claimedById) {
    fields.push({ name: "Claimed By", value: `<@${request.claimedById}>` });
  }

  if (request.startedById) {
    fields.push({ name: "Ride-Along Started", value: `<@${request.startedById}>` });
  }

  const noteCount = request.notes?.length ?? 0;
  if (noteCount > 0) {
    fields.push({ name: "Notes", value: `${noteCount} note(s) recorded` });
  }

  if (request.score != null) {
    fields.push({ name: "Score", value: `${request.score}/10` });
  }

  if (request.status === "passed") {
    fields.push({ name: "Result", value: `Passed by <@${request.resolvedById}>` });
    if (request.rosterCallsign) {
      fields.push({
        name: "Assigned Callsign",
        value: `**${request.rosterCallsign}** (${request.rosterRank ?? "Probationary Officer"})`,
      });
    }
  } else if (request.status === "failed") {
    const failReason =
      request.score != null && request.score < RIDEALONG_PASSING_SCORE
        ? `Failed by <@${request.resolvedById}> (score **${request.score}/10** — below **${RIDEALONG_PASSING_SCORE}**)`
        : `Failed by <@${request.resolvedById}>`;
    fields.push({ name: "Result", value: failReason });
  }

  const builder = forEdit ? buildV2EditPayload : buildV2Payload;

  return builder({
    title,
    description,
    fields,
    imageUrls: request.screenshotUrl ? [request.screenshotUrl] : [],
    actionRows: actionRows ?? [],
    allowedMentions,
  });
}

function buildRideAlongEmbed(request) {
  return buildRideAlongPayload(request);
}

function clearRideAlongEndReminder(request) {
  const timeout = rideAlongReminderTimeouts.get(request.requestId);
  if (timeout) {
    clearTimeout(timeout);
    rideAlongReminderTimeouts.delete(request.requestId);
  }
}

function scheduleRideAlongEndReminder(client, request) {
  clearRideAlongEndReminder(request);

  const timeout = setTimeout(async () => {
    rideAlongReminderTimeouts.delete(request.requestId);

    if (request.status === "passed" || request.status === "failed" || !request.startedById) {
      return;
    }

    const channel = await client.channels.fetch(request.notificationChannelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    await channel
      .send({
        content:
          `<@${request.startedById}> It is now time to **end the ride-along**.\n\n` +
          "Click **End Ride Along** on the request, review your notes, and submit a score out of 10.",
        allowedMentions: { users: [request.startedById] },
      })
      .catch((error) => {
        console.error("Failed to send ride-along end reminder:", error);
      });
  }, RIDEALONG_DURATION_MS);

  rideAlongReminderTimeouts.set(request.requestId, timeout);
}

function formatRideAlongNotes(request) {
  if (!request.notes?.length) {
    return "*No notes recorded yet.*";
  }

  return request.notes
    .map((note, index) => {
      const timestamp = Math.floor(note.at / 1000);
      return `**${index + 1}.** <t:${timestamp}:t> — ${note.text}`;
    })
    .join("\n\n");
}

function truncateEmbedField(value) {
  return value.length > 1024 ? `${value.slice(0, 1021)}...` : value;
}

function parseRideAlongScore(raw) {
  const score = Number.parseFloat(String(raw).trim().replace(/,/g, "."));

  if (Number.isNaN(score) || score < 1 || score > 10) {
    throw new Error("Enter a score between **1** and **10** (decimals allowed, e.g. `7.5`).");
  }

  return Math.round(score * 10) / 10;
}

function buildRideAlongNotesModal(requestId) {
  return new ModalBuilder()
    .setCustomId(`${RA_NOTES_MODAL_PREFIX}${requestId}`)
    .setTitle("Ride-Along Note")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("note_text")
          .setLabel("Note")
          .setPlaceholder("Document observations about this cadet...")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

function buildRideAlongScoreModal(requestId) {
  return new ModalBuilder()
    .setCustomId(`${RA_SCORE_MODAL_PREFIX}${requestId}`)
    .setTitle("Ride-Along Score")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("score")
          .setLabel("Score out of 10")
          .setPlaceholder("e.g. 8 or 7.5 — below 7.5 is a fail")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(4),
      ),
    );
}

function buildRideAlongEndReviewPayload(request) {
  return buildV2Payload({
    title: "End Ride-Along — Review Notes",
    description:
      "Review your notes below, then submit a score out of 10.\n\n" +
      `**Passing score:** ${RIDEALONG_PASSING_SCORE} or higher`,
    fields: [
      {
        name: "Your Notes",
        value: truncateEmbedField(formatRideAlongNotes(request)),
      },
    ],
    actionRows: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${RA_SCORE_BUTTON_PREFIX}${request.requestId}`)
          .setLabel("Submit Score")
          .setStyle(ButtonStyle.Primary),
      ),
    ],
    ephemeral: true,
    includeFiles: false,
  });
}

function buildRideAlongButtons(request) {
  if (request.status === "passed" || request.status === "failed") {
    return [];
  }

  const canStart = Boolean(request.claimedById) && !request.startedById;
  const inProgress = Boolean(request.startedById) && request.status === "pending";

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RA_CLAIM_PREFIX}${request.requestId}`)
      .setLabel(request.claimedById ? "Claimed" : "Claim")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(Boolean(request.claimedById)),
    new ButtonBuilder()
      .setCustomId(`${RA_START_PREFIX}${request.requestId}`)
      .setLabel(request.startedById ? "Started" : "Start Ride Along")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canStart),
    new ButtonBuilder()
      .setCustomId(`${RA_NOTES_PREFIX}${request.requestId}`)
      .setLabel("Notes")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!inProgress),
    new ButtonBuilder()
      .setCustomId(`${RA_END_PREFIX}${request.requestId}`)
      .setLabel("End Ride Along")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!inProgress),
  );

  return [row];
}

async function executeRideAlongPass(interaction, request, applicant, score) {
  if (score < RIDEALONG_PASSING_SCORE) {
    await interaction.editReply(
      `Score **${score}/10** is below **${RIDEALONG_PASSING_SCORE}**. Use **End Ride Along** and submit a failing score instead.`,
    );
    return;
  }

  if (!isSheetsConfigured()) {
    await interaction.editReply(
      "Cannot pass ride-along — Google Sheets is not configured on the bot.",
    );
    return;
  }

  const roleplayName = await resolveRoleplayNameForMember(
    applicant,
    request.roleplayName || getRoleplayNameFromMember(applicant),
  );

  if (!roleplayName) {
    await interaction.editReply(
      "Could not determine this member's roster name. They need their RP name in their nickname (e.g. `C-3 | J. Smith`) or a row on the cadet section of the sheet.",
    );
    return;
  }

  let rosterResult;
  try {
    pauseRoleSyncGlobally(45_000);
    pauseRoleSyncForMember(applicant, 120_000);

    rosterResult = await promoteToProbationaryOnRoster(roleplayName, {
      currentCallsign: getRosterCallsignForMember(applicant),
      member: applicant,
    });
  } catch (error) {
    console.error("Ride-along pass roster assignment failed:", error);
    await interaction.editReply(
      `Could not pass ride-along — roster update failed.\n\n${error.message}\n\n` +
        "Add open **Probationary Officer** rows on the sheet (4-digit callsign, empty RP NAME), then try again.",
    );
    return;
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
  clearRideAlongEndReminder(request);
  persistRideAlongRequest(request);
  await updateRideAlongNotification(interaction.client, request);

  await logRosterResultAudit(interaction.client, interaction.guild.id, {
    trigger: "Ride-along pass",
    actor: interaction.member,
    target: applicant,
    roleplayName,
    rosterResult,
    notes: `Score ${score}/10`,
  }).catch(() => null);

  let staffNote =
    `**Passed** with a score of **${score}/10**.\n` +
    `Moved **${roleplayName}** from **${rosterResult.previousCallsign ?? "cadet"}** to **${rosterResult.newCallsign}** (${rosterResult.newRank}).`;

  if (!nicknameResult.ok) {
    staffNote += `\nNickname not updated: ${nicknameResult.reason}`;
  } else if (nicknameResult.changed) {
    staffNote += `\nNickname: \`${nicknameResult.nickname}\`.`;
  }

  await sendCallsignDm(applicant.user, {
    callsign: rosterResult.newCallsign,
    roleplayName,
    rank: rosterResult.newRank,
    title:
      `Your ride-along has been marked **Passed** (score: **${score}/10**).\n\n` +
      "You have been promoted to **Probationary Officer**.",
    extraLines:
      nicknameResult.ok && nicknameResult.changed
        ? [`Your Discord nickname is now \`${nicknameResult.nickname}\`.`]
        : [],
  });

  recordMemberRosterLinkFromResult(applicant, rosterResult);

  await interaction.editReply(`Marked **Passed** for ${applicant}.\n${staffNote}`);
}

async function executeRideAlongFail(interaction, request, applicant, score) {
  if (score >= RIDEALONG_PASSING_SCORE) {
    await interaction.editReply(
      `Score **${score}/10** meets the passing threshold (**${RIDEALONG_PASSING_SCORE}**). Use the pass flow instead.`,
    );
    return;
  }

  pauseRoleSyncGlobally(45_000);
  pauseRoleSyncForMember(applicant, 120_000);

  await applicant.roles.remove(CADET_ROLE_IDS).catch((error) => {
    console.error("Failed to remove cadet roles on fail:", error);
  });
  await applicant.roles.remove(PROBATIONARY_OFFICER_ROLE_ID).catch((error) => {
    console.error("Failed to remove probationary officer role on fail:", error);
  });
  setCooldown(applicant.id, CADET_ENROLL_COOLDOWN_MS, CADET_ENROLL_COOLDOWN_TYPE);

  if (isSheetsConfigured()) {
    try {
      const roleplayName = await resolveRoleplayNameForMember(
        applicant,
        request.roleplayName || getRoleplayNameFromMember(applicant),
      );
      if (roleplayName) {
        await clearRosterForName(roleplayName, {
          currentCallsign: getRosterCallsignForMember(applicant),
          member: applicant,
        });
      }
      removeMemberRosterLink(applicant);
    } catch (error) {
      console.error("Ride-along fail roster clear failed:", error);
    }
  }

  request.status = "failed";
  request.resolvedById = interaction.user.id;
  clearRideAlongEndReminder(request);
  persistRideAlongRequest(request);
  await updateRideAlongNotification(interaction.client, request);

  await applicant.user
    .send(
      `Your ride-along has been marked **Failed** (score: **${score}/10**).\n\n` +
        "Your cadet and probationary roles were removed. You may try again in **3 days** using **Become Cadet**.",
    )
    .catch(() => null);

  await interaction.editReply(
    `Marked **Failed** for ${applicant} (score **${score}/10** — below **${RIDEALONG_PASSING_SCORE}**).\n` +
      "They cannot re-enroll as cadet for 3 days.",
  );
}

function buildCadetPanelPayload() {
  return buildV2Payload({
    title: "Become a Cadet",
    description:
      "Click the button below to receive your **Cadet** roles and begin the ride-along process.\n\n" +
      "You will be asked for your **full roleplay name** (e.g. John Smith). The roster will list you as **J. Smith**.\n\n" +
      "After enrolling, you must complete **2 ride-alongs** before you can become a **Probationary Officer**.\n\n" +
      `When you are ready, go to <#${RA_REQUEST_CHANNEL_ID}> and run **/ridealong** to request a ride-along.`,
    footer: BOT_NAME,
    actionRows: [buildCadetEnrollButton()],
  });
}

function buildCadetPanelEmbed() {
  return buildCadetPanelPayload();
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

  await message.channel.send(buildCadetPanelPayload());

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
  const rideAlongHandled = await handleRideAlongCommand(interaction);
  if (rideAlongHandled) return true;

  if (interaction.isButton() && interaction.customId === CADET_ENROLL_BUTTON_ID) {
    const member = interaction.member;
    if (!member) {
      await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
      return true;
    }

    if (isBlockedFromRecruitmentFlows(member)) {
      await interaction.reply({ content: RECRUITMENT_BLOCKED_MESSAGE, ephemeral: true });
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

  if (isBlockedFromRecruitmentFlows(member)) {
    await interaction.editReply(RECRUITMENT_BLOCKED_MESSAGE);
    return true;
  }

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
    `When you are ready, go to <#${RA_REQUEST_CHANNEL_ID}> and run **/ridealong** to request a ride-along.`;

  if (isSheetsConfigured()) {
    try {
      const cadetAssignment = await assignCadetCallsign(roleplayName, {
        currentCallsign: getRosterCallsignForMember(member),
      });
      const nicknameResult = await updateMemberCallsign(
        member,
        cadetAssignment.callsign,
        roleplayName,
      );

      reply +=
        `\n\nYour assigned **cadet callsign** is **${cadetAssignment.callsign}**.` +
        "\n**Do not use this callsign in-game.** You are not officially part of the department until you pass the Quiz and receive a department callsign.";

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

      recordMemberRosterLinkFromResult(member, cadetAssignment);

      await logRosterAudit(interaction.client, interaction.guild.id, {
        title: "Cadet enrolled",
        actor: member,
        target: member,
        roleplayName,
        rank: cadetAssignment.rank,
        callsign: cadetAssignment.callsign,
        rowNumber: cadetAssignment.rowNumber,
        trigger: "Become Cadet",
      }).catch(() => null);
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

function buildRideAlongModal() {
  return new ModalBuilder()
    .setCustomId(RIDEALONG_MODAL_ID)
    .setTitle("Ride-Along Request")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("roblox_user")
          .setLabel("Roblox Username")
          .setPlaceholder("Your Roblox username")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(64),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("discord_user")
          .setLabel("Discord Username")
          .setPlaceholder("Leave blank to use your Discord name")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(64),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("available_for")
          .setLabel("Available For")
          .setPlaceholder("When are you available for a ride-along?")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(1000),
      ),
    );
}

function buildRideAlongCommand() {
  return new SlashCommandBuilder()
    .setName(RIDEALONG_COMMAND_NAME)
    .setDescription("Request a ride-along with the Houston Police Department");
}

async function submitRideAlongRequest(client, { guild, member, robloxUser, discordUser, availableFor }) {
  const requestChannel = await client.channels.fetch(RA_REQUEST_CHANNEL_ID).catch(() => null);
  if (!requestChannel?.isTextBased()) {
    return {
      ok: false,
      message: "The ride-along request channel is not available. Contact staff.",
    };
  }

  const notificationChannel = await client.channels
    .fetch(RA_NOTIFICATION_CHANNEL_ID)
    .catch(() => null);

  if (!notificationChannel?.isTextBased()) {
    console.error("Ride-along notification channel not found:", RA_NOTIFICATION_CHANNEL_ID);
    return {
      ok: false,
      message: "Staff notification channel is not available. Contact staff.",
    };
  }

  const request = {
    requestId: null,
    applicantId: member.id,
    applicantTag: member.user.tag,
    guildId: guild.id,
    requestUrl: null,
    roleplayName: getRoleplayNameFromMember(member),
    robloxUser,
    discordUser,
    availableFor,
    status: "pending",
    claimedById: null,
    startedById: null,
    startedAt: null,
    endReminderTimeout: null,
    notes: [],
    score: null,
    resolvedById: null,
  };

  const requestMessage = await requestChannel.send(
    buildRideAlongPayload(request, {
      headerText: `<@${member.id}> submitted a **ride-along request**.`,
      allowedMentions: { users: [member.id] },
    }),
  );

  request.requestId = requestMessage.id;
  request.requestUrl = requestMessage.url;
  persistRideAlongRequest(request);

  const rolePings = RA_PING_ROLE_IDS.map((id) => `<@&${id}>`).join(" ");
  const notificationMessage = await notificationChannel.send(
    buildRideAlongPayload(request, {
      headerText: `${rolePings}\n\nA **ride-along request** is pending.\n[Jump to request](${requestMessage.url})`,
      actionRows: buildRideAlongButtons(request),
      allowedMentions: { roles: RA_PING_ROLE_IDS },
    }),
  );

  request.notificationMessageId = notificationMessage.id;
  request.notificationChannelId = notificationMessage.channel.id;
  persistRideAlongRequest(request);

  return {
    ok: true,
    message:
      `Your ride-along request has been submitted in <#${RA_REQUEST_CHANNEL_ID}>.\n\n` +
      "Staff will review it shortly. You will be pinged when someone claims your ride-along.",
    requestUrl: requestMessage.url,
  };
}

async function handleRideAlongCommand(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === RIDEALONG_COMMAND_NAME) {
    if (!interaction.guild) {
      await interaction.reply({
        content: `Use this command in the server, in <#${RA_REQUEST_CHANNEL_ID}>.`,
        ephemeral: true,
      });
      return true;
    }

    if (interaction.channelId !== RA_REQUEST_CHANNEL_ID) {
      await interaction.reply({
        content: `Ride-along requests must be submitted in <#${RA_REQUEST_CHANNEL_ID}>.`,
        ephemeral: true,
      });
      return true;
    }

    await interaction.showModal(buildRideAlongModal());
    return true;
  }

  if (interaction.isModalSubmit() && interaction.customId === RIDEALONG_MODAL_ID) {
    const member = interaction.member;
    if (!member) {
      await interaction.reply({ content: "This can only be used in a server.", ephemeral: true });
      return true;
    }

    if (interaction.channelId !== RA_REQUEST_CHANNEL_ID) {
      await interaction.reply({
        content: `Ride-along requests must be submitted in <#${RA_REQUEST_CHANNEL_ID}>.`,
        ephemeral: true,
      });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    const robloxUser = interaction.fields.getTextInputValue("roblox_user").trim();
    const discordUserInput = interaction.fields.getTextInputValue("discord_user").trim();
    const availableFor = interaction.fields.getTextInputValue("available_for").trim();
    const discordUser = discordUserInput || member.user.username;

    if (!robloxUser || !availableFor) {
      await interaction.editReply("Roblox username and availability are required.");
      return true;
    }

    const result = await submitRideAlongRequest(interaction.client, {
      guild: interaction.guild,
      member,
      robloxUser,
      discordUser,
      availableFor,
    });

    if (!result.ok) {
      await interaction.editReply(result.message);
      return true;
    }

    await interaction.editReply(result.message);
    return true;
  }

  return false;
}

async function handleRideAlongMessage(message) {
  if (message.author.bot || !message.guild) return false;
  if (message.channel.id !== RA_REQUEST_CHANNEL_ID) return false;

  const parsed = parseRideAlongMessage(message.content);
  if (!parsed) return false;

  if (hasProcessed(`ra-hint:${message.id}`)) return true;
  markProcessed(`ra-hint:${message.id}`);

  await message
    .reply("Ride-along requests now use the **/ridealong** command. Please run that instead.")
    .catch(() => null);

  return true;
}

async function updateRideAlongNotification(client, request) {
  if (!request.notificationChannelId || !request.notificationMessageId) return;

  const channel = await client.channels.fetch(request.notificationChannelId).catch(() => null);
  const notificationMessage = await channel?.messages
    .fetch(request.notificationMessageId)
    .catch(() => null);

  if (!notificationMessage) return;

  await notificationMessage.edit(
    buildRideAlongPayload(request, {
      forEdit: true,
      actionRows: buildRideAlongButtons(request),
    }),
  );
}

function getRideAlongRequestIdFromCustomId(prefix, customId) {
  return customId.slice(prefix.length);
}

async function handleRideAlongInteraction(interaction) {
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith(RA_START_MODAL_PREFIX)) {
      const requestId = getRideAlongRequestIdFromCustomId(RA_START_MODAL_PREFIX, interaction.customId);
      const request = await resolveRideAlongRequest(interaction.client, requestId);

      if (!request || request.status === "passed" || request.status === "failed") {
        await interaction.reply({ content: "This ride-along is no longer active.", ephemeral: true });
        return true;
      }

      if (request.claimedById !== interaction.user.id) {
        await interaction.reply({
          content: "Only the staff member who claimed this ride-along can start it.",
          ephemeral: true,
        });
        return true;
      }

      if (request.startedById) {
        await interaction.reply({ content: "This ride-along has already been started.", ephemeral: true });
        return true;
      }

      const screenshot = getUploadedScreenshotFromModal(interaction);
      if (!screenshot.ok) {
        await interaction.reply({ content: screenshot.message, ephemeral: true });
        return true;
      }

      request.screenshotUrl = screenshot.url;
      request.screenshotAttachmentId = screenshot.attachmentId;

      persistRideAlongRequest(request);
      await interaction.deferReply({ ephemeral: true });
      await completeRideAlongStart(interaction, request);
      return true;
    }

    if (interaction.customId.startsWith(RA_NOTES_MODAL_PREFIX)) {
      const requestId = getRideAlongRequestIdFromCustomId(RA_NOTES_MODAL_PREFIX, interaction.customId);
      const request = await resolveRideAlongRequest(interaction.client, requestId);

      if (!request || request.status === "passed" || request.status === "failed") {
        await interaction.reply({ content: "This ride-along is no longer active.", ephemeral: true });
        return true;
      }

      if (request.claimedById !== interaction.user.id) {
        await interaction.reply({
          content: "Only the staff member who claimed this ride-along can add notes.",
          ephemeral: true,
        });
        return true;
      }

      if (!request.startedById) {
        await interaction.reply({
          content: "Start the ride-along before adding notes.",
          ephemeral: true,
        });
        return true;
      }

      const noteText = interaction.fields.getTextInputValue("note_text").trim();
      if (!noteText) {
        await interaction.reply({ content: "Note cannot be empty.", ephemeral: true });
        return true;
      }

      if (!request.notes) request.notes = [];
      request.notes.push({
        text: noteText,
        at: Date.now(),
        authorId: interaction.user.id,
      });

      persistRideAlongRequest(request);
      await updateRideAlongNotification(interaction.client, request);
      await interaction.reply({
        content: `Note **#${request.notes.length}** saved. You have **${request.notes.length}** note(s) on this ride-along.`,
        ephemeral: true,
      });
      return true;
    }

    if (interaction.customId.startsWith(RA_SCORE_MODAL_PREFIX)) {
      const requestId = getRideAlongRequestIdFromCustomId(RA_SCORE_MODAL_PREFIX, interaction.customId);
      const request = await resolveRideAlongRequest(interaction.client, requestId);

      if (!request || request.status === "passed" || request.status === "failed") {
        await interaction.reply({ content: "This ride-along is no longer active.", ephemeral: true });
        return true;
      }

      if (request.claimedById !== interaction.user.id) {
        await interaction.reply({
          content: "Only the staff member who claimed this ride-along can submit a score.",
          ephemeral: true,
        });
        return true;
      }

      let score;
      try {
        score = parseRideAlongScore(interaction.fields.getTextInputValue("score"));
      } catch (error) {
        await interaction.reply({ content: error.message, ephemeral: true });
        return true;
      }

      request.score = score;
      persistRideAlongRequest(request);

      await interaction.deferReply({ ephemeral: true });

      const guild = await interaction.client.guilds.fetch(request.guildId).catch(() => null);
      const applicant = await guild?.members.fetch(request.applicantId).catch(() => null);

      if (!applicant) {
        await interaction.editReply("Could not find the applicant in this server.");
        return true;
      }

      if (score < RIDEALONG_PASSING_SCORE) {
        await executeRideAlongFail(interaction, request, applicant, score);
      } else {
        await executeRideAlongPass(interaction, request, applicant, score);
      }

      return true;
    }

    return false;
  }

  if (!interaction.isButton()) {
    return false;
  }

  if (interaction.customId.startsWith(RA_SCORE_BUTTON_PREFIX)) {
    const requestId = getRideAlongRequestIdFromCustomId(RA_SCORE_BUTTON_PREFIX, interaction.customId);
    const request = await resolveRideAlongRequest(interaction.client, requestId);

    if (!request || request.status === "passed" || request.status === "failed") {
      await interaction.reply({ content: "This ride-along is no longer active.", ephemeral: true });
      return true;
    }

    if (request.claimedById !== interaction.user.id) {
      await interaction.reply({
        content: "Only the staff member who claimed this ride-along can submit a score.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.showModal(buildRideAlongScoreModal(requestId));
    return true;
  }

  let action = null;
  let requestId = null;

  if (interaction.customId.startsWith(RA_CLAIM_PREFIX)) {
    action = "claim";
    requestId = interaction.customId.slice(RA_CLAIM_PREFIX.length);
  } else if (interaction.customId.startsWith(RA_START_PREFIX)) {
    action = "start";
    requestId = interaction.customId.slice(RA_START_PREFIX.length);
  } else if (interaction.customId.startsWith(RA_NOTES_PREFIX)) {
    action = "notes";
    requestId = interaction.customId.slice(RA_NOTES_PREFIX.length);
  } else if (interaction.customId.startsWith(RA_END_PREFIX)) {
    action = "end";
    requestId = interaction.customId.slice(RA_END_PREFIX.length);
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

  const request = await resolveRideAlongRequest(interaction.client, requestId);
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

  if (action === "notes") {
    if (request.claimedById !== interaction.user.id) {
      await interaction.reply({
        content: "Only the staff member who claimed this ride-along can add notes.",
        ephemeral: true,
      });
      return true;
    }

    if (!request.startedById) {
      await interaction.reply({
        content: "Start the ride-along before adding notes.",
        ephemeral: true,
      });
      return true;
    }

    await interaction.showModal(buildRideAlongNotesModal(requestId));
    return true;
  }

  if (action === "end") {
    if (request.claimedById !== interaction.user.id) {
      await interaction.reply({
        content: "Only the staff member who claimed this ride-along can end it.",
        ephemeral: true,
      });
      return true;
    }

    if (!request.startedById) {
      await interaction.reply({
        content: "Start the ride-along before ending it.",
        ephemeral: true,
      });
      return true;
    }

    clearRideAlongEndReminder(request);

    await interaction.reply(buildRideAlongEndReviewPayload(request));
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
    persistRideAlongRequest(request);
    await updateRideAlongNotification(interaction.client, request);

    const claimNotice =
      `<@${request.applicantId}> Your ride-along has been claimed by **${interaction.user.displayName}** (<@${interaction.user.id}>).\n\n` +
      "Please head onto the **Police team** and wait at the **police station**.\n\n" +
      "Make sure you have a **blocky avatar** and **no unrealistic accessories** before you join.";

    const requestChannel = await interaction.client.channels
      .fetch(RA_REQUEST_CHANNEL_ID)
      .catch(() => null);

    if (requestChannel?.isTextBased()) {
      const requestMessage = await requestChannel.messages.fetch(request.requestId).catch(() => null);

      if (requestMessage) {
        await requestMessage
          .reply({
            content: claimNotice,
            allowedMentions: { users: [request.applicantId] },
          })
          .catch((error) => {
            console.error("Failed to notify applicant on ride-along claim:", error);
          });
      } else {
        await requestChannel
          .send({
            content: claimNotice,
            allowedMentions: { users: [request.applicantId] },
          })
          .catch((error) => {
            console.error("Failed to notify applicant on ride-along claim:", error);
          });
      }
    }

    await interaction.reply({
      content:
        "You claimed this ride-along. The applicant has been notified.\n\n" +
        "Click **Start Ride Along** when you begin — you will be prompted to **upload a screenshot** of you and your cadet.",
      ephemeral: true,
    });
    return true;
  }

  if (action === "start") {
    if (request.claimedById !== interaction.user.id) {
      await interaction.reply({
        content: "Only the staff member who claimed this ride-along can start it.",
        ephemeral: true,
      });
      return true;
    }

    if (request.startedById) {
      await interaction.reply({ content: "This ride-along has already been started.", ephemeral: true });
      return true;
    }

    await interaction.showModal(buildRideAlongStartModal(requestId));
    return true;
  }

  return false;
}

module.exports = {
  buildRideAlongCommand,
  handleCadetPanelCommand,
  handleCadetInteraction,
  handleRideAlongMessage,
  handleRideAlongInteraction,
  restoreRideAlongReminders,
};
