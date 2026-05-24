const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

let sheetsClient = null;

function normalizeEnv(value) {
  if (!value) return "";
  return String(value).trim().replace(/^["']|["']$/g, "");
}

function getCadetRankName() {
  return normalizeEnv(process.env.GOOGLE_CADET_RANK_NAME) || "Cadet";
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

async function getRosterRows() {
  const sheets = await getSheetsClient();
  const sheetName = getRosterSheetName();
  const range = `${sheetName}!A:H`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range,
  });

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

  return { sheetName, entries, nameColumnLetter, headerRowNumber: headerRowIndex + 1 };
}

async function batchUpdateCells(updates) {
  const sheets = await getSheetsClient();

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: updates,
    },
  });
}

module.exports = {
  isSheetsConfigured,
  getSheetsConfigHelpMessage,
  getSheetsConfigIssues,
  getSpreadsheetId,
  getRosterSheetName,
  getCadetRankName,
  getCredentialsPath,
  getSheetsClient,
  getRosterRows,
  batchUpdateCells,
};
