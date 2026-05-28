const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const INFRACTIONS_FILE = path.join(DATA_DIR, "infractions.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadInfractionsByUser() {
  ensureDataDir();
  if (!fs.existsSync(INFRACTIONS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(INFRACTIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveInfractionsByUser(data) {
  ensureDataDir();
  fs.writeFileSync(INFRACTIONS_FILE, JSON.stringify(data, null, 2));
}

function getInfractionsForUser(userId) {
  const data = loadInfractionsByUser();
  return data[userId] ?? [];
}

function addInfraction(userId, infraction) {
  const data = loadInfractionsByUser();
  const existing = data[userId] ?? [];
  existing.unshift(infraction);
  data[userId] = existing;
  saveInfractionsByUser(data);
  return infraction;
}

module.exports = {
  getInfractionsForUser,
  addInfraction,
};
