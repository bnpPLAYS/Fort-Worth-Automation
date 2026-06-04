const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SETTINGS_FILE = path.join(DATA_DIR, "guild-settings.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadSettings() {
  ensureDataDir();
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  ensureDataDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function getGuildSettings(guildId) {
  if (!guildId) return {};
  return loadSettings()[guildId] ?? {};
}

function setGuildSettings(guildId, patch) {
  if (!guildId) return null;

  const settings = loadSettings();
  settings[guildId] = {
    ...(settings[guildId] ?? {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  saveSettings(settings);
  return settings[guildId];
}

function getAuditChannelId(guildId) {
  const fromEnv = String(process.env.ROSTER_AUDIT_CHANNEL_ID ?? "").trim();
  if (fromEnv) return fromEnv;
  return getGuildSettings(guildId).auditChannelId ?? null;
}

function setAuditChannelId(guildId, channelId) {
  return setGuildSettings(guildId, { auditChannelId: channelId });
}

module.exports = {
  getGuildSettings,
  setGuildSettings,
  getAuditChannelId,
  setAuditChannelId,
};
