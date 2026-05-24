const fs = require("fs");
const path = require("path");
const {
  getSpreadsheetId,
  getRosterSheetName,
  getCredentialsPath,
  getSheetsConfigIssues,
  getSheetsClient,
  getRosterRows,
} = require("./client");

function readServiceAccountInfo(credentialsPath) {
  try {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    return {
      email: credentials.client_email ?? null,
      projectId: credentials.project_id ?? null,
    };
  } catch {
    return { email: null, projectId: null };
  }
}

function getEnvFormattingWarnings() {
  const warnings = [];
  const rawSpreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID ?? "";
  const rawSheetName = process.env.GOOGLE_ROSTER_SHEET_NAME ?? "";

  if (rawSpreadsheetId !== rawSpreadsheetId.trim()) {
    warnings.push("**GOOGLE_SHEETS_SPREADSHEET_ID** has leading/trailing spaces in `.env`");
  }

  if (/^["']|["']$/.test(rawSpreadsheetId.trim())) {
    warnings.push("Remove quotes around **GOOGLE_SHEETS_SPREADSHEET_ID** in `.env`");
  }

  if (rawSheetName !== rawSheetName.trim()) {
    warnings.push("**GOOGLE_ROSTER_SHEET_NAME** has leading/trailing spaces in `.env`");
  }

  const spreadsheetId = getSpreadsheetId();
  if (spreadsheetId && !/^[a-zA-Z0-9-_]+$/.test(spreadsheetId)) {
    warnings.push("Spreadsheet ID contains unexpected characters — copy only the ID from the sheet URL");
  }

  return warnings;
}

function getGoogleErrorDetails(error) {
  const apiError = error?.response?.data?.error;

  return {
    status: error?.response?.status,
    message: apiError?.message ?? error?.message ?? String(error),
    reason: apiError?.errors?.[0]?.reason ?? null,
    statusText: apiError?.status ?? null,
  };
}

function explainGoogleError(error) {
  const { status, message, reason, statusText } = getGoogleErrorDetails(error);
  const parts = [];

  if (status) parts.push(`HTTP ${status}`);
  if (statusText) parts.push(statusText);
  if (reason) parts.push(`reason \`${reason}\``);

  const header = parts.length > 0 ? parts.join(" — ") : "Google API error";
  const lines = [header];

  if (message && !parts.some((part) => part.includes(message))) {
    lines.push(message);
  }

  if (
    message.includes("Sheets API has not been used") ||
    message.includes("API has not been enabled") ||
    reason === "accessNotConfigured"
  ) {
    lines.push(
      "Enable **Google Sheets API** in [Google Cloud Console](https://console.cloud.google.com/apis/library/sheets.googleapis.com) for your project, then wait 1–2 minutes and try again.",
    );
    return lines.join("\n");
  }

  if (status === 404 || reason === "notFound" || message.toLowerCase().includes("not found")) {
    lines.push(
      "This usually means the spreadsheet ID is wrong **or** the sheet is not shared with the service account.",
      "• Open the roster sheet → **Share** → add the service account email as **Editor** (not Viewer)",
      "• Copy the spreadsheet ID again from the URL between `/d/` and `/edit`",
      "• Make sure you shared the **same** sheet that matches that ID",
    );
    return lines.join("\n");
  }

  if (status === 403 || reason === "forbidden" || reason === "authError") {
    lines.push(
      "The service account cannot access this sheet. Share it with the service account email as **Editor**.",
    );
    return lines.join("\n");
  }

  return lines.join("\n");
}

async function listSpreadsheetTabNames() {
  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.get({
    spreadsheetId: getSpreadsheetId(),
    fields: "sheets.properties.title",
  });

  return (response.data.sheets ?? [])
    .map((sheet) => sheet.properties?.title)
    .filter(Boolean);
}

async function runRosterDiagnostics({ rankToCheck } = {}) {
  const lines = [];
  let overallOk = true;

  const spreadsheetId = getSpreadsheetId();
  const sheetName = getRosterSheetName();
  const credentialsPath = path.resolve(getCredentialsPath());
  const configIssues = getSheetsConfigIssues();

  lines.push(
    configIssues.length === 0
      ? "✅ Local `.env` and credentials file look present"
      : `❌ Config issues:\n${configIssues.map((issue) => `• ${issue}`).join("\n")}`,
  );

  if (configIssues.length > 0) {
    overallOk = false;
    const { email } = readServiceAccountInfo(credentialsPath);
    return { ok: false, lines, serviceAccountEmail: email };
  }

  const envWarnings = getEnvFormattingWarnings();
  for (const warning of envWarnings) {
    lines.push(`⚠️ ${warning}`);
    overallOk = false;
  }

  const { email: serviceAccountEmail, projectId } = readServiceAccountInfo(credentialsPath);
  if (serviceAccountEmail) {
    lines.push(`✅ Service account: \`${serviceAccountEmail}\``);
  } else {
    lines.push("⚠️ Could not read `client_email` from the credentials JSON");
    overallOk = false;
  }

  if (projectId) {
    lines.push(`• Google Cloud project: \`${projectId}\``);
  }

  lines.push(`• Spreadsheet ID: \`${spreadsheetId}\` (${spreadsheetId.length} chars)`);
  lines.push(`• Configured tab: \`${sheetName}\``);
  lines.push(
    `• Expected sheet URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  );

  let tabNames = [];
  try {
    tabNames = await listSpreadsheetTabNames();
    const tabFound = tabNames.includes(sheetName);

    if (tabFound) {
      lines.push(`✅ Tab \`${sheetName}\` exists in the spreadsheet`);
    } else {
      overallOk = false;
      lines.push(`❌ Tab \`${sheetName}\` was **not found** in this spreadsheet`);
      lines.push(`Available tabs: ${tabNames.map((name) => `\`${name}\``).join(", ")}`);
      lines.push(
        "Update **GOOGLE_ROSTER_SHEET_NAME** in `.env` to one of the tab names above, then restart the bot.",
      );
    }
  } catch (error) {
    overallOk = false;
    console.error("Roster diagnostics spreadsheet error:", getGoogleErrorDetails(error));
    lines.push(`❌ Could not open spreadsheet:\n${explainGoogleError(error)}`);
    return { ok: false, lines, serviceAccountEmail };
  }

  try {
    const { entries } = await getRosterRows();
    const filled = entries.filter((entry) => entry.name.length > 0).length;
    const open = entries.filter((entry) => entry.name.length === 0).length;

    lines.push(`✅ Read roster: **${filled}** filled slot(s), **${open}** open slot(s)`);

    if (rankToCheck) {
      const normalizedRank = rankToCheck.trim().toLowerCase();
      const openInRank = entries.filter(
        (entry) =>
          entry.rank.toLowerCase() === normalizedRank && entry.name.length === 0,
      );

      if (openInRank.length > 0) {
        lines.push(
          `✅ Open slot(s) for **${rankToCheck}**: ${openInRank
            .map((entry) => `\`${entry.callsign}\``)
            .join(", ")}`,
        );
      } else {
        overallOk = false;
        const ranksPresent = [...new Set(entries.map((entry) => entry.rank))];
        lines.push(`❌ No open slot found for rank **${rankToCheck}**`);
        lines.push(
          `Ranks on the sheet include: ${ranksPresent.slice(0, 12).join(", ")}${ranksPresent.length > 12 ? "…" : ""}`,
        );
      }
    }
  } catch (error) {
    overallOk = false;
    console.error("Roster diagnostics read error:", getGoogleErrorDetails(error));
    lines.push(`❌ Could not read roster data:\n${explainGoogleError(error)}`);
  }

  return { ok: overallOk, lines, serviceAccountEmail, tabNames };
}

module.exports = {
  runRosterDiagnostics,
  getGoogleErrorDetails,
};
