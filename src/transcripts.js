const { AttachmentBuilder } = require("discord.js");
const { saveTicket, deleteTicket } = require("./tickets-store");

const TRANSCRIPT_CHANNEL_ID = "1485036121673961512";

async function fetchAllMessages(channel) {
  const allMessages = [];
  let before;

  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });

    if (batch.size === 0) break;

    allMessages.push(...batch.values());
    before = batch.last().id;

    if (batch.size < 100) break;
  }

  return allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function formatEmbedLine(embed) {
  const parts = [];
  if (embed.title) parts.push(embed.title);
  if (embed.description) parts.push(embed.description);

  for (const field of embed.fields ?? []) {
    parts.push(`${field.name}: ${field.value}`);
  }

  if (embed.image?.url) parts.push(`Image: ${embed.image.url}`);
  if (embed.thumbnail?.url) parts.push(`Thumbnail: ${embed.thumbnail.url}`);

  return parts.join(" | ") || "Embed (no text content)";
}

async function buildTranscriptText(channel, ticket, closedBy) {
  const messages = await fetchAllMessages(channel);

  const lines = [
    "Houston Police Department — Ticket Transcript",
    "=".repeat(60),
    `Channel: #${channel.name} (${channel.id})`,
    `Ticket Type: ${ticket.type}`,
    `Opener: ${ticket.openerTag} (${ticket.openerId})`,
  ];

  if (ticket.reportedUserTag) {
    lines.push(`Reported Member: ${ticket.reportedUserTag} (${ticket.reportedUserId})`);
  }

  if (ticket.whatHappened) {
    lines.push(`Initial Report: ${ticket.whatHappened}`);
  }

  lines.push(`Created: ${new Date(ticket.createdAt).toISOString()}`);
  lines.push(`Closed By: ${closedBy}`);
  lines.push(`Closed At: ${new Date().toISOString()}`);
  lines.push("=".repeat(60));
  lines.push("");

  for (const message of messages) {
    const timestamp = new Date(message.createdTimestamp).toISOString();
    lines.push(`[${timestamp}] ${message.author.tag} (${message.author.id})`);

    if (message.content) {
      lines.push(message.content);
    }

    for (const attachment of message.attachments.values()) {
      lines.push(`[Attachment] ${attachment.name ?? "file"}: ${attachment.url}`);
    }

    for (const embed of message.embeds) {
      lines.push(`[Embed] ${formatEmbedLine(embed)}`);
    }

    if (message.stickers?.size) {
      for (const sticker of message.stickers.values()) {
        lines.push(`[Sticker] ${sticker.name}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

async function sendTranscript(client, channel, ticket, closedBy) {
  const transcriptChannel = await client.channels.fetch(TRANSCRIPT_CHANNEL_ID).catch(() => null);
  if (!transcriptChannel?.isTextBased()) {
    console.error("Transcript channel not found:", TRANSCRIPT_CHANNEL_ID);
    return;
  }

  const transcriptText = await buildTranscriptText(channel, ticket, closedBy);
  const filename = `${channel.name}-${channel.id}.txt`;

  await transcriptChannel.send({
    content:
      `**Ticket Transcript**\n` +
      `Channel: #${channel.name}\n` +
      `Opener: <@${ticket.openerId}>\n` +
      `Type: ${ticket.type}\n` +
      `Closed by: ${closedBy}`,
    files: [new AttachmentBuilder(Buffer.from(transcriptText, "utf8"), { name: filename })],
  });
}

async function closeTicket(client, channel, ticket, { closedBy, reason = null, closedByUserId = null }) {
  if (ticket.closed) return false;

  ticket.closed = true;
  saveTicket(channel.id, ticket);

  await sendTranscript(client, channel, ticket, closedBy);

  const opener = await client.users.fetch(ticket.openerId).catch(() => null);
  if (opener) {
    const ticketLabel = ticket.type === "report" ? "report" : "support";

    if (reason) {
      await opener
        .send({
          content:
            `Your **${ticketLabel}** ticket has been closed.\n\n` +
            `**Reason:** ${reason}`,
        })
        .catch(() => {});
    } else if (closedByUserId === ticket.openerId) {
      await opener
        .send({
          content: `You closed your **${ticketLabel}** ticket. Thank you for contacting support.`,
        })
        .catch(() => {});
    }
  }

  deleteTicket(channel.id);
  await channel.delete().catch(() => {});
  return true;
}

module.exports = {
  closeTicket,
  sendTranscript,
};
