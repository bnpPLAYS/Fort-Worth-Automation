const fs = require("fs");
const path = require("path");

const COOLDOWN_MS = 4 * 24 * 60 * 60 * 1000;
const DATA_DIR = path.join(__dirname, "..", "data");
const COOLDOWN_FILE = path.join(DATA_DIR, "cooldowns.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadCooldowns() {
  ensureDataDir();
  if (!fs.existsSync(COOLDOWN_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(COOLDOWN_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveCooldowns(cooldowns) {
  ensureDataDir();
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(cooldowns, null, 2));
}

function getCooldownEnd(userId) {
  const cooldowns = loadCooldowns();
  return cooldowns[userId] ?? null;
}

function isOnCooldown(userId) {
  const end = getCooldownEnd(userId);
  if (!end) return false;
  if (Date.now() >= end) {
    const cooldowns = loadCooldowns();
    delete cooldowns[userId];
    saveCooldowns(cooldowns);
    return false;
  }
  return true;
}

function setCooldown(userId) {
  const cooldowns = loadCooldowns();
  cooldowns[userId] = Date.now() + COOLDOWN_MS;
  saveCooldowns(cooldowns);
  return cooldowns[userId];
}

module.exports = {
  COOLDOWN_MS,
  getCooldownEnd,
  isOnCooldown,
  setCooldown,
};
