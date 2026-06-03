const fs = require("fs");
const path = require("path");
const {
  getRosterRows,
  batchUpdateCells,
  getRosterSheetName,
  getSheetsClient,
  getSpreadsheetId,
  getSheetId,
  columnIndexToLetter,
} = require("./client");
const { ranksMatch } = require("../rank-matching");

const REORGANIZE_MARKER_PATH = path.join(__dirname, "..", "..", "data", ".roster-reorganized.json");

function normalizeEnv(value) {
  if (!value) return "";
  return String(value).trim().replace(/^["']|["']$/g, "");
}

function getReorganizeConfig() {
  return {
    commanderFrom: normalizeEnv(process.env.ROSTER_COMMANDER_RANK_NAME) || "Commander",
    officeOfChiefTo:
      normalizeEnv(process.env.ROSTER_OFFICE_OF_CHIEF_RANK_NAME) || "Office of the Chief",
    captainRank: normalizeEnv(process.env.ROSTER_CAPTAIN_RANK_NAME) || "Captain",
    patrolSupervisorsSection:
      normalizeEnv(process.env.ROSTER_PATROL_SUPERVISORS_SECTION) || "Patrol Supervisors",
  };
}

function isSectionHeaderRow(row) {
  const rank = String(row.rank ?? "").trim();
  const callsign = String(row.callsign ?? "").trim();
  const name = String(row.name ?? "").trim();

  if (!rank) return false;
  if (name) return false;
  if (/^\d{3,5}$/.test(callsign.replace(/\s/g, ""))) return false;
  if (/^C-\d{1,3}$/i.test(callsign)) return false;

  return true;
}

async function getAllRosterSheetRows() {
  const sheets = await getSheetsClient();
  const sheetName = getRosterSheetName();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A:H`,
  });

  const rows = response.data.values ?? [];
  const { entries, rankIndex, nameIndex, callsignIndex, rollsIndex, headerRowNumber } =
    await getRosterRows();

  const rankCol = columnIndexToLetter(rankIndex);
  const nameCol = columnIndexToLetter(nameIndex);
  const callsignCol = columnIndexToLetter(callsignIndex);
  const rollsCol = rollsIndex === -1 ? null : columnIndexToLetter(rollsIndex);

  const headerRowIndex = headerRowNumber - 1;
  const allRows = [];

  for (let rowIndex = headerRowIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    allRows.push({
      rowNumber: rowIndex + 1,
      rank: String(row[rankIndex] ?? "").trim(),
      name: String(row[nameIndex] ?? "").trim(),
      callsign: String(row[callsignIndex] ?? "").trim().replace(/\s/g, ""),
      rolls: rollsIndex === -1 ? "" : String(row[rollsIndex] ?? "").trim(),
      rankCol,
      nameCol,
      callsignCol,
      rollsCol,
    });
  }

  return { sheetName, allRows, entries };
}

function findSheetRankLabel(rows, rank) {
  const match = rows.find((row) => ranksMatch(rank, row.rank));
  return match?.rank ?? null;
}

async function renameRankLabel(sheetName, rows, fromRank, toRank) {
  const updates = [];

  for (const row of rows) {
    if (!ranksMatch(fromRank, row.rank)) continue;
    updates.push({
      range: `${sheetName}!${row.rankCol}${row.rowNumber}`,
      values: [[toRank]],
    });
  }

  if (updates.length === 0) {
    return { renamed: 0 };
  }

  await batchUpdateCells(updates);
  return { renamed: updates.length };
}

async function moveRowBlock(sheetName, fromRowNumber, toRowNumber) {
  const sheetId = await getSheetId(sheetName);
  const sheets = await getSheetsClient();
  const fromIndex = fromRowNumber - 1;
  const toIndex = toRowNumber - 1;

  if (fromIndex === toIndex) {
    return false;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: getSpreadsheetId(),
    requestBody: {
      requests: [
        {
          moveDimension: {
            source: {
              sheetId,
              dimension: "ROWS",
              startIndex: fromIndex,
              endIndex: fromIndex + 1,
            },
            destinationIndex: toIndex,
          },
        },
      ],
    },
  });

  return true;
}

function getPatrolSupervisorsBounds(allRows, sectionLabel) {
  const sectionIndex = allRows.findIndex((row) => ranksMatch(sectionLabel, row.rank));
  if (sectionIndex === -1) {
    return null;
  }

  const headerRow = allRows[sectionIndex].rowNumber;
  let lastRow = headerRow;

  for (let i = sectionIndex + 1; i < allRows.length; i += 1) {
    const row = allRows[i];
    if (isSectionHeaderRow(row) && !ranksMatch(sectionLabel, row.rank)) {
      break;
    }
    lastRow = row.rowNumber;
  }

  return { headerRow, lastRow, insertRow: lastRow + 1 };
}

function isCaptainDataRow(row, captainRank) {
  return ranksMatch(captainRank, row.rank) && /^\d{3,5}$/.test(row.callsign);
}

function captainOutsidePatrolSection(row, bounds) {
  return row.rowNumber <= bounds.headerRow || row.rowNumber > bounds.lastRow;
}

async function moveCaptainRowsToPatrolSupervisors(config) {
  const sheetName = getRosterSheetName();
  const movedLabels = [];
  let moved = 0;
  let safety = 0;

  while (safety < 50) {
    safety += 1;
    const { allRows } = await getAllRosterSheetRows();
    const bounds = getPatrolSupervisorsBounds(allRows, config.patrolSupervisorsSection);

    if (!bounds) {
      throw new Error(
        `Could not find a **${config.patrolSupervisorsSection}** section header on the roster sheet.`,
      );
    }

    const captain = allRows.find(
      (row) => isCaptainDataRow(row, config.captainRank) && captainOutsidePatrolSection(row, bounds),
    );

    if (!captain) {
      break;
    }

    const movedOk = await moveRowBlock(sheetName, captain.rowNumber, bounds.insertRow);
    if (!movedOk) {
      break;
    }

    moved += 1;
    movedLabels.push(`${captain.name || "(vacant)"} / ${captain.callsign}`);
  }

  return { moved, captains: movedLabels };
}

function hasReorganizeMarker() {
  return fs.existsSync(REORGANIZE_MARKER_PATH);
}

function writeReorganizeMarker(summary) {
  fs.mkdirSync(path.dirname(REORGANIZE_MARKER_PATH), { recursive: true });
  fs.writeFileSync(
    REORGANIZE_MARKER_PATH,
    JSON.stringify({ completedAt: new Date().toISOString(), ...summary }, null, 2),
    "utf8",
  );
}

async function reorganizeRosterStructure({ dryRun = false, force = false } = {}) {
  if (!force && hasReorganizeMarker()) {
    return { skipped: true, reason: "Roster reorganization already completed (marker file exists)." };
  }

  const config = getReorganizeConfig();
  const { sheetName, allRows } = await getAllRosterSheetRows();

  const officeLabel =
    findSheetRankLabel(allRows, config.officeOfChiefTo) ?? config.officeOfChiefTo.toUpperCase();

  const commanderRows = allRows.filter((row) => ranksMatch(config.commanderFrom, row.rank));
  const captainRows = allRows.filter(
    (row) => ranksMatch(config.captainRank, row.rank) && /^\d{3,5}$/.test(row.callsign),
  );

  const plan = {
    commanderFrom: config.commanderFrom,
    officeOfChiefTo: officeLabel,
    commanderRows: commanderRows.length,
    captainRows: captainRows.map((row) => row.rowNumber),
    patrolSection: config.patrolSupervisorsSection,
  };

  if (dryRun) {
    return { dryRun: true, plan };
  }

  const renameResult = await renameRankLabel(sheetName, allRows, config.commanderFrom, officeLabel);
  const moveResult = await moveCaptainRowsToPatrolSupervisors(config);

  const summary = {
    renamedCommanderRows: renameResult.renamed,
    movedCaptainRows: moveResult.moved,
    captains: moveResult.captains,
  };

  if (!force || !hasReorganizeMarker()) {
    writeReorganizeMarker(summary);
  }

  return { dryRun: false, plan, ...summary };
}

module.exports = {
  getReorganizeConfig,
  reorganizeRosterStructure,
  hasReorganizeMarker,
  REORGANIZE_MARKER_PATH,
};
