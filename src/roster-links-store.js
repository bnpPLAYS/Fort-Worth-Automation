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

const { callsignsMatch } = require("./discord-callsign");

function findUserIdByCallsign(callsign) {
  if (!callsign) return null;

  const links = loadLinks();
  for (const [userId, link] of Object.entries(links)) {
    if (link?.callsign && callsignsMatch(callsign, link.callsign)) {
      return userId;
    }
  }

  return null;
}

function purgeRosterLinks(guild, shouldKeepLink) {
  const links = loadLinks();
  let removed = 0;

  for (const userId of Object.keys(links)) {
    const member = guild.members.cache.get(userId);
    if (!shouldKeepLink(member, userId)) {
      delete links[userId];
      removed += 1;
    }
  }

  if (removed > 0) {
    saveLinks(links);
  }

  return removed;
}

module.exports = {
  getRosterLink,
  setRosterLink,
  clearRosterLink,
  findUserIdByCallsign,
  purgeRosterLinks,
};
