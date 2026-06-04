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

function getCooldownKey(userId, type) {
  return type ? `${type}:${userId}` : userId;
}

function getCooldownEnd(userId, type) {
  const cooldowns = loadCooldowns();
  return cooldowns[getCooldownKey(userId, type)] ?? null;
}

function isOnCooldown(userId, type) {
  const end = getCooldownEnd(userId, type);
  if (!end) return false;
  if (Date.now() >= end) {
    const cooldowns = loadCooldowns();
    delete cooldowns[getCooldownKey(userId, type)];
    saveCooldowns(cooldowns);
    return false;
  }
  return true;
}

function setCooldown(userId, durationMs = COOLDOWN_MS, type) {
  const cooldowns = loadCooldowns();
  const key = getCooldownKey(userId, type);
  cooldowns[key] = Date.now() + durationMs;
  saveCooldowns(cooldowns);
  return cooldowns[key];
}

function getCooldownRemainingMs(userId, type) {
  const end = getCooldownEnd(userId, type);
  if (!end) return 0;
  return Math.max(0, end - Date.now());
}

function clearCooldown(userId, type) {
  const cooldowns = loadCooldowns();
  const key = getCooldownKey(userId, type);
  if (!cooldowns[key]) return false;
  delete cooldowns[key];
  saveCooldowns(cooldowns);
  return true;
}

module.exports = {
  COOLDOWN_MS,
  getCooldownEnd,
  isOnCooldown,
  setCooldown,
  getCooldownRemainingMs,
  clearCooldown,
};
