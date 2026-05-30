const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const REQUESTS_FILE = path.join(DATA_DIR, "ride-alongs.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadRequests() {
  ensureDataDir();
  if (!fs.existsSync(REQUESTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(REQUESTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveRequests(requests) {
  ensureDataDir();
  fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
}

function serializeRequest(request) {
  if (!request) return null;
  const { endReminderTimeout, ...rest } = request;
  return rest;
}

function getRideAlongRequest(requestId) {
  return loadRequests()[requestId] ?? null;
}

function saveRideAlongRequest(requestId, request) {
  const requests = loadRequests();
  requests[requestId] = serializeRequest(request);
  saveRequests(requests);
  return requests[requestId];
}

function listActiveRideAlongRequests() {
  const requests = loadRequests();
  return Object.values(requests).filter(
    (request) => request.status === "pending" && request.requestId,
  );
}

module.exports = {
  getRideAlongRequest,
  saveRideAlongRequest,
  listActiveRideAlongRequests,
};
