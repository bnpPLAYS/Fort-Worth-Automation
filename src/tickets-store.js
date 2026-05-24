const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const TICKETS_FILE = path.join(DATA_DIR, "tickets.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadTickets() {
  ensureDataDir();
  if (!fs.existsSync(TICKETS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(TICKETS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveTickets(tickets) {
  ensureDataDir();
  fs.writeFileSync(TICKETS_FILE, JSON.stringify(tickets, null, 2));
}

function getTicket(channelId) {
  const tickets = loadTickets();
  return tickets[channelId] ?? null;
}

function saveTicket(channelId, ticket) {
  const tickets = loadTickets();
  tickets[channelId] = ticket;
  saveTickets(tickets);
}

function deleteTicket(channelId) {
  const tickets = loadTickets();
  delete tickets[channelId];
  saveTickets(tickets);
}

function findOpenTicketByOpener(userId, type) {
  const tickets = loadTickets();
  return Object.entries(tickets).find(
    ([, ticket]) => ticket.openerId === userId && ticket.type === type && !ticket.closed,
  );
}

async function resolveOpenTicket(guild, userId, type) {
  const existing = findOpenTicketByOpener(userId, type);
  if (!existing) return null;

  const [channelId, ticket] = existing;
  const channel = await guild.channels.fetch(channelId).catch(() => null);

  if (!channel) {
    deleteTicket(channelId);
    return null;
  }

  return [channelId, ticket];
}

module.exports = {
  getTicket,
  saveTicket,
  deleteTicket,
  findOpenTicketByOpener,
  resolveOpenTicket,
};
