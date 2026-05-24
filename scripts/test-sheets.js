require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const { getGoogleErrorDetails } = require("../src/google-sheets/diagnostics");

function normalizeEnv(value) {
  if (!value) return "";
  return String(value).trim().replace(/^["']|["']$/g, "");
}

async function main() {
  const spreadsheetId = normalizeEnv(process.env.GOOGLE_SHEETS_SPREADSHEET_ID);
  const sheetName = normalizeEnv(process.env.GOOGLE_ROSTER_SHEET_NAME) || "Roster";
  const credentialsPath = path.resolve(
    normalizeEnv(process.env.GOOGLE_SERVICE_ACCOUNT_PATH) ||
      "./credentials/google-service-account.json",
  );

  console.log("Fort Worth roster — Google Sheets test\n");
  console.log("Spreadsheet ID:", spreadsheetId || "(missing)");
  console.log("Tab name:", sheetName);
  console.log("Credentials:", credentialsPath);

  if (!spreadsheetId) {
    console.error("\nERROR: GOOGLE_SHEETS_SPREADSHEET_ID is missing in .env");
    process.exit(1);
  }

  if (!fs.existsSync(credentialsPath)) {
    console.error("\nERROR: credentials file not found at:", credentialsPath);
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  console.log("Service account:", credentials.client_email);
  console.log("Project:", credentials.project_id);
  console.log("");

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth: await auth.getClient() });

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "properties.title,sheets.properties.title",
    });

    const title = meta.data.properties?.title ?? "(unknown)";
    const tabs = (meta.data.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter(Boolean);

    console.log("SUCCESS: Opened spreadsheet");
    console.log("Title:", title);
    console.log("Tabs:", tabs.join(", "));

    if (!tabs.includes(sheetName)) {
      console.error(`\nERROR: Tab "${sheetName}" not found.`);
      console.error("Set GOOGLE_ROSTER_SHEET_NAME in .env to one of the tabs above.");
      process.exit(1);
    }

    const { getRosterRows } = require("../src/google-sheets/client");
    const { entries, headerRowNumber } = await getRosterRows();

    console.log("\nHeader row found on sheet row:", headerRowNumber);
    console.log("Roster slots:", entries.length);
    console.log("\nAll checks passed.");
  } catch (error) {
    const details = getGoogleErrorDetails(error);
    console.error("\nFAILED:");
    console.error(JSON.stringify(details, null, 2));

    if (details.status === 404) {
      console.error("\nFix: Share the sheet with", credentials.client_email, "as Editor.");
      console.error("Or fix GOOGLE_SHEETS_SPREADSHEET_ID in .env.");
    }

    if (String(details.message).includes("Sheets API has not been used")) {
      console.error("\nFix: Enable Google Sheets API in Google Cloud Console for project", credentials.project_id);
    }

    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
