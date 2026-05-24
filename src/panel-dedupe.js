const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const PROCESSED_FILE = path.join(DATA_DIR, "processed-panels.json");
const TTL_MS = 5 * 60 * 1000;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadProcessed() {
  ensureDataDir();
  if (!fs.existsSync(PROCESSED_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveProcessed(processed) {
  ensureDataDir();
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(processed, null, 2));
}

function pruneProcessed(processed) {
  const now = Date.now();
  for (const [id, timestamp] of Object.entries(processed)) {
    if (now - timestamp > TTL_MS) {
      delete processed[id];
    }
  }
}

function hasProcessed(messageId) {
  const processed = loadProcessed();
  pruneProcessed(processed);
  return Boolean(processed[messageId]);
}

function markProcessed(messageId) {
  const processed = loadProcessed();
  pruneProcessed(processed);
  processed[messageId] = Date.now();
  saveProcessed(processed);
}

module.exports = {
  hasProcessed,
  markProcessed,
};
