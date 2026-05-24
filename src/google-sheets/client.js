const { google } = require("googleapis");

let sheetsClient = null;

function getSpreadsheetId() {
  return process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
}

function getRosterSheetName() {
  return process.env.GOOGLE_ROSTER_SHEET_NAME || "Roster";
}

function getCredentialsPath() {
  return process.env.GOOGLE_SERVICE_ACCOUNT_PATH || "./credentials/google-service-account.json";
}

function isSheetsConfigured() {
  return Boolean(getSpreadsheetId() && getCredentialsPath());
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
  const range = `${sheetName}!A:D`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range,
  });

  const rows = response.data.values ?? [];
  if (rows.length === 0) {
    throw new Error(`Sheet "${sheetName}" is empty or missing.`);
  }

  const header = rows[0].map((cell) => String(cell).trim().toLowerCase());
  const rankIndex = header.indexOf("rank");
  const callsignIndex = header.indexOf("callsign");
  const nameIndex = header.indexOf("name");
  const divisionIndex = header.indexOf("division");

  if (rankIndex === -1 || callsignIndex === -1 || nameIndex === -1) {
    throw new Error('Roster sheet must have header row: Rank | Callsign | Name | Division');
  }

  const entries = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    entries.push({
      rowNumber: rowIndex + 1,
      rank: String(row[rankIndex] ?? "").trim(),
      callsign: String(row[callsignIndex] ?? "").trim(),
      name: String(row[nameIndex] ?? "").trim(),
      division: divisionIndex === -1 ? "" : String(row[divisionIndex] ?? "").trim(),
    });
  }

  return { sheetName, entries };
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
  getRosterRows,
  batchUpdateCells,
  getRosterSheetName,
};
