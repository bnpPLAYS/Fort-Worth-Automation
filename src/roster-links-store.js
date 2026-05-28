const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const LINKS_FILE = path.join(DATA_DIR, "roster-links.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadLinks() {
  ensureDataDir();
  if (!fs.existsSync(LINKS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveLinks(links) {
  ensureDataDir();
  fs.writeFileSync(LINKS_FILE, JSON.stringify(links, null, 2));
}

function getRosterLink(userId) {
  if (!userId) return null;
  const links = loadLinks();
  return links[userId] ?? null;
}

function setRosterLink(userId, link) {
  if (!userId || !link?.roleplayName) return null;

  const links = loadLinks();
  const existing = links[userId];
  const now = new Date().toISOString();

  const next = {
    roleplayName: String(link.roleplayName).trim(),
    callsign: String(link.callsign ?? "").trim(),
    rank: String(link.rank ?? "").trim(),
    rowNumber: Number.isFinite(link.rowNumber) ? link.rowNumber : null,
    linkedAt: existing?.linkedAt ?? now,
    updatedAt: now,
  };

  links[userId] = next;
  saveLinks(links);
  return next;
}

function clearRosterLink(userId) {
  if (!userId) return false;
  const links = loadLinks();
  if (!links[userId]) return false;
  delete links[userId];
  saveLinks(links);
  return true;
}

module.exports = {
  getRosterLink,
  setRosterLink,
  clearRosterLink,
};
