const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const APPLICATIONS_FILE = path.join(DATA_DIR, "quiz-applications.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadApplications() {
  ensureDataDir();
  if (!fs.existsSync(APPLICATIONS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(APPLICATIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveApplications(applications) {
  ensureDataDir();
  fs.writeFileSync(APPLICATIONS_FILE, JSON.stringify(applications, null, 2));
}

function getQuizApplication(appId) {
  return loadApplications()[appId] ?? null;
}

function saveQuizApplication(application) {
  if (!application?.appId) return null;

  const applications = loadApplications();
  applications[application.appId] = application;
  saveApplications(applications);
  return application;
}

function deleteQuizApplication(appId) {
  const applications = loadApplications();
  if (!applications[appId]) return false;
  delete applications[appId];
  saveApplications(applications);
  return true;
}

function listQuizApplications({ status } = {}) {
  const applications = Object.values(loadApplications());
  if (!status) return applications;
  return applications.filter((application) => application.status === status);
}

module.exports = {
  getQuizApplication,
  saveQuizApplication,
  deleteQuizApplication,
  listQuizApplications,
};
