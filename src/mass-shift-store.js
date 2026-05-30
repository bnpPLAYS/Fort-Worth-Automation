const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SHIFTS_FILE = path.join(DATA_DIR, "mass-shifts.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadShifts() {
  ensureDataDir();
  if (!fs.existsSync(SHIFTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SHIFTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveShifts(shifts) {
  ensureDataDir();
  fs.writeFileSync(SHIFTS_FILE, JSON.stringify(shifts, null, 2));
}

function getMassShift(messageId) {
  return loadShifts()[messageId] ?? null;
}

function saveMassShift(messageId, shift) {
  const shifts = loadShifts();
  shifts[messageId] = shift;
  saveShifts(shifts);
  return shift;
}

function addResponder(messageId, member) {
  const shifts = loadShifts();
  const shift = shifts[messageId];

  if (!shift) {
    return { ok: false, reason: "This mass shift is no longer tracked." };
  }

  if (shift.responders.some((entry) => entry.userId === member.id)) {
    return { ok: false, reason: "You are already on the responders list.", shift };
  }

  shift.responders.push({
    userId: member.id,
    name: member.displayName,
    addedAt: new Date().toISOString(),
  });

  shifts[messageId] = shift;
  saveShifts(shifts);

  return { ok: true, shift };
}

module.exports = {
  getMassShift,
  saveMassShift,
  addResponder,
};
