const {
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  TextDisplayBuilder,
} = require("discord.js");
const { EMBED_COLOR } = require("./constants");
const {
  BANNER_FILENAME,
  buildImageGallery,
  createHpdContainer,
  appendHpdFooter,
  getHpdBannerAttachment,
} = require("./hpd-components");

const MAX_TEXT_DISPLAY = 4000;

function truncateV2Text(text, maxLength = MAX_TEXT_DISPLAY) {
  const value = String(text ?? "").trim();
  if (!value) return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function fieldsToMarkdown(fields) {
  if (!fields?.length) return "";

  return fields
    .map((field) => {
      const name = String(field.name ?? "").trim();
      const value = truncateV2Text(String(field.value ?? "—").trim(), 1020);
      if (!name) return value;
      return `**${name}**\n${value}`;
    })
    .join("\n\n");
}

function buildV2Content({ title, description, fields, footer }) {
  const parts = [];

  if (title) {
    parts.push(`## ${title}`);
  }
  if (description) {
    parts.push(description);
  }

  const fieldBlock = fieldsToMarkdown(fields);
  if (fieldBlock) {
    parts.push(fieldBlock);
  }
  if (footer) {
    parts.push(`— *${footer}*`);
  }

  return parts.join("\n\n");
}

function addTextToContainer(container, text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return;

  let remaining = normalized;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX_TEXT_DISPLAY);
    remaining = remaining.slice(MAX_TEXT_DISPLAY);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(chunk));
  }
}

function buildV2Container(options = {}) {
  const {
    title,
    description,
    fields,
    footer,
    withHpdBranding = false,
    withTicketBanner = false,
    imageUrls = [],
    actionRows = [],
    accentColor = EMBED_COLOR,
  } = options;

  let container;
  let files = [];

  if (withHpdBranding) {
    const branded = createHpdContainer();
    container = branded.container;
    files = branded.files;
  } else {
    container = new ContainerBuilder().setAccentColor(accentColor);
    if (withTicketBanner) {
      const banner = getHpdBannerAttachment();
      if (banner) {
        container.addMediaGalleryComponents(buildImageGallery(BANNER_FILENAME));
        files.push(banner);
      }
    }
  }

  for (const url of imageUrls) {
    if (!url) continue;
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(url)),
    );
  }

  const content = buildV2Content({ title, description, fields, footer });
  addTextToContainer(container, content);

  if (actionRows.length > 0) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    for (const row of actionRows) {
      container.addActionRowComponents(row);
    }
  }

  if (withHpdBranding) {
    appendHpdFooter(container, files);
  }

  return { container, files };
}

function buildV2Payload(options = {}) {
  const { container, files } = buildV2Container(options);
  const { ephemeral = false, allowedMentions, includeFiles = true } = options;

  let flags = MessageFlags.IsComponentsV2;
  if (ephemeral) {
    flags |= MessageFlags.Ephemeral;
  }

  const payload = {
    flags,
    components: [container],
  };

  if (includeFiles && files.length > 0) {
    payload.files = files;
  }
  if (allowedMentions) {
    payload.allowedMentions = allowedMentions;
  }

  return payload;
}

function buildV2EditPayload(options = {}) {
  return buildV2Payload({ ...options, includeFiles: false });
}

/** @deprecated Use buildV2Payload — kept for gradual migration */
function buildV2FromLegacyEmbed(embedLike, options = {}) {
  return buildV2Payload({
    title: embedLike.title,
    description: embedLike.description,
    fields: embedLike.fields,
    footer: embedLike.footer?.text ?? embedLike.footer,
    ...options,
  });
}

module.exports = {
  MAX_TEXT_DISPLAY,
  truncateV2Text,
  fieldsToMarkdown,
  buildV2Content,
  buildV2Container,
  buildV2Payload,
  buildV2EditPayload,
  buildV2FromLegacyEmbed,
};
