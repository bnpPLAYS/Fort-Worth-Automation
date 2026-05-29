const path = require("path");
const fs = require("fs");
const {
  AttachmentBuilder,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
} = require("discord.js");
const { EMBED_COLOR } = require("./constants");

const BANNER_FILENAME = "hpd-dashboard-banner.png";
const FOOTER_FILENAME = "hpd-dashboard-footer.png";
const BANNER_PATH = path.join(__dirname, "..", "assets", BANNER_FILENAME);
const FOOTER_PATH = path.join(__dirname, "..", "assets", FOOTER_FILENAME);

function buildImageGallery(filename) {
  return new MediaGalleryBuilder().addItems(
    new MediaGalleryItemBuilder().setURL(`attachment://${filename}`),
  );
}

function getHpdBannerAttachment() {
  if (!fs.existsSync(BANNER_PATH)) return null;
  return new AttachmentBuilder(BANNER_PATH, { name: BANNER_FILENAME });
}

function createHpdContainer() {
  const container = new ContainerBuilder().setAccentColor(EMBED_COLOR);
  const files = [];

  if (fs.existsSync(BANNER_PATH)) {
    container.addMediaGalleryComponents(buildImageGallery(BANNER_FILENAME));
    files.push(new AttachmentBuilder(BANNER_PATH, { name: BANNER_FILENAME }));
  }

  return { container, files };
}

function appendHpdFooter(container, files) {
  if (!fs.existsSync(FOOTER_PATH)) {
    return files;
  }

  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
  container.addMediaGalleryComponents(buildImageGallery(FOOTER_FILENAME));

  if (!files.some((file) => file.name === FOOTER_FILENAME)) {
    files.push(new AttachmentBuilder(FOOTER_PATH, { name: FOOTER_FILENAME }));
  }

  return files;
}

function buildHpdComponentsPayload(container, files) {
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [container],
    files,
  };
}

module.exports = {
  BANNER_FILENAME,
  FOOTER_FILENAME,
  BANNER_PATH,
  FOOTER_PATH,
  buildImageGallery,
  getHpdBannerAttachment,
  createHpdContainer,
  appendHpdFooter,
  buildHpdComponentsPayload,
};
