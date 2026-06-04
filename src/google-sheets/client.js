const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

let sheetsClient = null;

const ROSTER_CACHE_TTL_MS = Number.parseInt(process.env.ROSTER_CACHE_TTL_MS || "90000", 10);
let rosterCache = null;

function invalidateRosterCache() {
  rosterCache = null;
}

function isSheetsQuotaError(error) {
  const message = String(error?.message ?? "");
  return (
    error?.code === 429 ||
    message.includes("Quota exceeded") ||
    message.includes("rateLimitExceeded") ||
    message.includes("RESOURCE_EXHAUSTED")
  );
}

async function withSheetsRetry(operation, { label = "sheets" } = {}) {
  const maxAttempts = 4;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSheetsQuotaError(error) || attempt === maxAttempts - 1) {
        throw error;
      }

      const delayMs = Math.min(30_000, 2000 * 2 ** attempt);
      console.warn(`[${label}] Google Sheets quota hit — retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
}

function normalizeEnv(value) {
  if (!value) return "";
  return String(value).trim().replace(/^["']|["']$/g, "");
}

function getCadetRankName() {
  return normalizeEnv(process.env.GOOGLE_CADET_RANK_NAME) || "Cadet";
}

function getProbationaryRankName() {
  return normalizeEnv(process.env.GOOGLE_PROBATIONARY_RANK_NAME) || "Probationary Officer";
}

function getSpreadsheetId() {
  return normalizeEnv(process.env.GOOGLE_SHEETS_SPREADSHEET_ID);
}

function getRosterSheetName() {
  const sheetName = normalizeEnv(process.env.GOOGLE_ROSTER_SHEET_NAME);
  return sheetName || "Roster";
}

function getCredentialsPath() {
  return process.env.GOOGLE_SERVICE_ACCOUNT_PATH || "./credentials/google-service-account.json";
}

function getSheetsConfigIssues() {
  const issues = [];

  if (!getSpreadsheetId()) {
    issues.push("set **GOOGLE_SHEETS_SPREADSHEET_ID** in `.env` (from your sheet URL)");
  }

  const credentialsPath = path.resolve(getCredentialsPath());
  if (!fs.existsSync(credentialsPath)) {
    issues.push(
      `place the service account JSON at \`${getCredentialsPath()}\` on the machine running the bot`,
    );
  }

  return issues;
}

function isSheetsConfigured() {
  return getSheetsConfigIssues().length === 0;
}

function getSheetsConfigHelpMessage() {
  const issues = getSheetsConfigIssues();
  if (issues.length === 0) return null;

  return [
    "Google Sheets is not fully configured on this bot yet:",
    ...issues.map((issue) => `• ${issue}`),
    "",
    "Also share the roster sheet with **discord-roster-bot@fort-worth-police-497316.iam.gserviceaccount.com** as Editor, then restart the bot.",
    "See `docs/google-sheets-setup.md` for details.",
  ].join("\n");
}

function findColumnIndex(header, aliases) {
  for (const alias of aliases) {
    const normalizedAlias = alias.replace(/\s+/g, " ").trim();
    const index = header.findIndex((cell) => {
      const normalizedCell = String(cell).replace(/\s+/g, " ").trim();
      return normalizedCell === normalizedAlias;
    });
    if (index !== -1) return index;
  }
  return -1;
}

function columnIndexToLetter(index) {
  return String.fromCharCode(65 + index);
}

function parseHeaderRow(row) {
  const header = (row ?? []).map((cell) => String(cell).trim().toUpperCase());
  const rankIndex = findColumnIndex(header, ["RANK"]);
  const nameIndex = findColumnIndex(header, ["RP NAME", "RPNAME", "ROLEPLAY NAME", "NAME"]);
  const callsignIndex = findColumnIndex(header, ["CALLSIGN", "CALL SIGN"]);
  const rollsIndex = findColumnIndex(header, ["ROLLS", "ROLES", "ROLE"]);

  if (rankIndex === -1 || callsignIndex === -1 || nameIndex === -1) {
    return null;
  }

  return { header, rankIndex, nameIndex, callsignIndex, rollsIndex };
}

function findHeaderRowIndex(rows, maxScan = 30) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, maxScan); rowIndex += 1) {
    if (parseHeaderRow(rows[rowIndex])) {
      return rowIndex;
    }
  }

  return -1;
}

function isCadetCallsign(callsign) {
  return /^C-\d{1,3}$/i.test(String(callsign).trim());
}

function isDepartmentCallsign(callsign) {
  return /^\d{3,5}$/.test(String(callsign).replace(/\s/g, ""));
}

function shouldIncludeRosterRow(_rank, callsign) {
  const normalizedCallsign = String(callsign).trim();
  return isDepartmentCallsign(normalizedCallsign) || isCadetCallsign(normalizedCallsign);
}

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.GoogleAuth({
    keyFile: getCredentialsPath(),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth: await auth.getClient() });
  return sheetsClient;
}

async function fetchRosterRowsFromApi() {
  const sheets = await getSheetsClient();
  const sheetName = getRosterSheetName();
  const range = `${sheetName}!A:H`;

  const response = await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: getSpreadsheetId(),
        range,
      }),
    { label: "roster-read" },
  );

  const rows = response.data.values ?? [];
  if (rows.length === 0) {
    throw new Error(`Sheet "${sheetName}" is empty or missing.`);
  }

  const headerRowIndex = findHeaderRowIndex(rows);
  if (headerRowIndex === -1) {
    throw new Error(
      'Could not find a header row with columns RANK | RP NAME | CALLSIGN within the first 30 rows. Add that header row or move it higher in the sheet.',
    );
  }

  const { rankIndex, nameIndex, callsignIndex, rollsIndex } = parseHeaderRow(rows[headerRowIndex]);
  const nameColumnLetter = columnIndexToLetter(nameIndex);
  const entries = [];

  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const rank = String(row[rankIndex] ?? "").trim();
    const name = String(row[nameIndex] ?? "").trim();
    const callsign = String(row[callsignIndex] ?? "").trim().replace(/\s/g, "");
    const rolls = rollsIndex === -1 ? "" : String(row[rollsIndex] ?? "").trim();

    if (!shouldIncludeRosterRow(rank, callsign)) {
      continue;
    }

    entries.push({
      rowNumber: rowIndex + 1,
      rank,
      name,
      callsign,
      rolls,
      nameColumnLetter,
    });
  }

  return {
    sheetName,
    entries,
    nameColumnLetter,
    headerRowNumber: headerRowIndex + 1,
    rankIndex,
    nameIndex,
    callsignIndex,
    rollsIndex,
  };
}

async function getRosterRows({ fresh = false } = {}) {
  if (
    !fresh &&
    rosterCache &&
    Date.now() - rosterCache.fetchedAt < ROSTER_CACHE_TTL_MS
  ) {
    return rosterCache.data;
  }

  const data = await fetchRosterRowsFromApi();
  rosterCache = { data, fetchedAt: Date.now() };
  return data;
}

async function getSheetId(sheetName = getRosterSheetName()) {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId: getSpreadsheetId(),
    fields: "sheets.properties",
  });
  const tab = (response.data.sheets ?? []).find((sheet) => sheet.properties.title === sheetName);

  if (!tab) {
    throw new Error(`Sheet tab "${sheetName}" not found.`);
  }

  return tab.properties.sheetId;
}

async function batchUpdateCells(updates) {
  const sheets = await getSheetsClient();

  await withSheetsRetry(
    () =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: getSpreadsheetId(),
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: updates,
        },
      }),
    { label: "roster-write" },
  );

  invalidateRosterCache();
}

module.exports = {
  isSheetsConfigured,
  getSheetsConfigHelpMessage,
  getSheetsConfigIssues,
  getSpreadsheetId,
  getRosterSheetName,
  getCadetRankName,
  getProbationaryRankName,
  getCredentialsPath,
  getSheetsClient,
  getRosterRows,
  invalidateRosterCache,
  isSheetsQuotaError,
  getSheetId,
  batchUpdateCells,
  columnIndexToLetter,
};
