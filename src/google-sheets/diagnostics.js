const fs = require("fs");
const path = require("path");
const {
  getSpreadsheetId,
  getRosterSheetName,
  getCredentialsPath,
  getSheetsConfigIssues,
  isSheetsConfigured,
  getSheetsClient,
  getRosterRows,
} = require("./client");

function readServiceAccountEmail(credentialsPath) {
  try {
    const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
    return credentials.client_email ?? null;
  } catch {
    return null;
  }
}

function explainGoogleError(error) {
  const status = error?.response?.status ?? error?.code;
  const message = error?.message ?? String(error);

  if (status === 404 || message.includes("not found")) {
    return [
      "Google could not find the spreadsheet or tab.",
      "• Check **GOOGLE_SHEETS_SPREADSHEET_ID** in `.env`",
      `• Check **GOOGLE_ROSTER_SHEET_NAME** — configured as \`${getRosterSheetName()}\``,
      "• Share the sheet with the service account email below as **Editor**",
    ].join("\n");
  }

  if (status === 403 || message.includes("permission")) {
    return "The service account does not have access. Share the sheet with the service account email as **Editor**.";
  }

  return message;
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
    return { ok: false, lines, serviceAccountEmail: readServiceAccountEmail(credentialsPath) };
  }

  const serviceAccountEmail = readServiceAccountEmail(credentialsPath);
  if (serviceAccountEmail) {
    lines.push(`✅ Service account: \`${serviceAccountEmail}\``);
  } else {
    lines.push("⚠️ Could not read `client_email` from the credentials JSON");
    overallOk = false;
  }

  lines.push(`• Spreadsheet ID: \`${spreadsheetId}\``);
  lines.push(`• Configured tab: \`${sheetName}\``);

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
    lines.push(`❌ Could not open spreadsheet: ${explainGoogleError(error)}`);
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
    lines.push(`❌ Could not read roster data: ${explainGoogleError(error)}`);
  }

  return { ok: overallOk, lines, serviceAccountEmail, tabNames };
}

module.exports = {
  runRosterDiagnostics,
};
