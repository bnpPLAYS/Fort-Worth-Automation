const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const RECORDS_FILE = path.join(DATA_DIR, "cadet-inactivity.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadRecords() {
  ensureDataDir();
  if (!fs.existsSync(RECORDS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(RECORDS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveRecords(records) {
  ensureDataDir();
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2));
}

function getCadetInactivityRecord(userId) {
  if (!userId) return null;
  return loadRecords()[userId] ?? null;
}

function recordCadetEnrollment(userId, { guildId, roleplayName, enrolledAt } = {}) {
  if (!userId || !guildId) return null;

  const records = loadRecords();
  const now = new Date().toISOString();

  records[userId] = {
    userId,
    guildId,
    roleplayName: String(roleplayName ?? "").trim(),
    enrolledAt: enrolledAt ?? now,
    rideAlongRequestedAt: null,
    terminatedAt: null,
    terminationReason: null,
  };

  saveRecords(records);
  return records[userId];
}

function markCadetRideAlongRequested(userId) {
  if (!userId) return null;

  const records = loadRecords();
  const record = records[userId];
  if (!record || record.terminatedAt) return null;

  record.rideAlongRequestedAt = new Date().toISOString();
  records[userId] = record;
  saveRecords(records);
  return record;
}

function markCadetInactivityTerminated(userId, reason) {
  if (!userId) return null;

  const records = loadRecords();
  const record = records[userId];
  if (!record) return null;

  record.terminatedAt = new Date().toISOString();
  record.terminationReason = reason;
  records[userId] = record;
  saveRecords(records);
  return record;
}

function clearCadetInactivityRecord(userId) {
  if (!userId) return false;
  const records = loadRecords();
  if (!records[userId]) return false;
  delete records[userId];
  saveRecords(records);
  return true;
}

function listCadetInactivityRecords() {
  return Object.values(loadRecords());
}

module.exports = {
  getCadetInactivityRecord,
  recordCadetEnrollment,
  markCadetRideAlongRequested,
  markCadetInactivityTerminated,
  clearCadetInactivityRecord,
  listCadetInactivityRecords,
};
