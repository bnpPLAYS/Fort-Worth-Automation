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
const { ranksMatch, normalizeRank } = require("../rank-matching");

const REORGANIZE_MARKER_PATH = path.join(__dirname, "..", "..", "data", ".roster-reorganized.json");
const REORGANIZE_VERSION = 2;

function normalizeEnv(value) {
  if (!value) return "";
  return String(value).trim().replace(/^["']|["']$/g, "");
}

function getReorganizeConfig() {
  return {
    commanderRank: normalizeEnv(process.env.ROSTER_COMMANDER_RANK_NAME) || "Commander",
    officeOfChiefSection:
      normalizeEnv(process.env.ROSTER_OFFICE_OF_CHIEF_SECTION) || "Office of the Chief",
    captainRank: normalizeEnv(process.env.ROSTER_CAPTAIN_RANK_NAME) || "Captain",
    supervisorySection:
      normalizeEnv(process.env.ROSTER_SUPERVISORY_SECTION) ||
      normalizeEnv(process.env.ROSTER_PATROL_SUPERVISORS_SECTION) ||
      "Patrol Supervisors",
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

function isDataRow(row) {
  return /^\d{3,5}$/.test(String(row.callsign ?? "")) || /^C-\d{1,3}$/i.test(String(row.callsign ?? ""));
}

function isChiefLeadershipRank(rank) {
  const normalized = normalizeRank(rank);
  return (
    normalized.includes("chief of police") ||
    normalized.includes("assistant chief") ||
    normalized.includes("deputy chief")
  );
}

function isMislabeledCommanderRow(row, config) {
  if (!isDataRow(row) || !row.name) return false;
  if (!ranksMatch(config.officeOfChiefSection, row.rank)) return false;
  if (isChiefLeadershipRank(row.rank)) return false;
  return true;
}

function isCommanderDataRow(row, config) {
  if (!isDataRow(row)) return false;
  return ranksMatch(config.commanderRank, row.rank) || isMislabeledCommanderRow(row, config);
}

function isCaptainDataRow(row, config) {
  return ranksMatch(config.captainRank, row.rank) && /^\d{3,5}$/.test(String(row.callsign ?? ""));
}

async function getAllRosterSheetRows() {
  const sheets = await getSheetsClient();
  const sheetName = getRosterSheetName();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: getSpreadsheetId(),
    range: `${sheetName}!A:H`,
  });

  const rows = response.data.values ?? [];
  const { rankIndex, nameIndex, callsignIndex, rollsIndex, headerRowNumber } = await getRosterRows();

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

  return { sheetName, allRows };
}

function findSheetRankLabel(rows, rank) {
  const match = rows.find((row) => ranksMatch(rank, row.rank) && isDataRow(row));
  return match?.rank ?? null;
}

function findSectionHeaderIndex(allRows, sectionLabel) {
  return allRows.findIndex(
    (row) => isSectionHeaderRow(row) && ranksMatch(sectionLabel, row.rank),
  );
}

function getSectionBounds(allRows, sectionLabel) {
  const sectionIndex = findSectionHeaderIndex(allRows, sectionLabel);
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

  return { headerRow, lastRow, firstDataRow: headerRow + 1 };
}

function getNextSectionHeaderIndex(allRows, afterIndex) {
  for (let i = afterIndex + 1; i < allRows.length; i += 1) {
    if (isSectionHeaderRow(allRows[i])) {
      return i;
    }
  }
  return -1;
}

function getOfficeOfChiefInsertRow(allRows, config) {
  const sectionIndex = findSectionHeaderIndex(allRows, config.officeOfChiefSection);
  if (sectionIndex === -1) {
    return null;
  }

  let insertAfter = allRows[sectionIndex].rowNumber;
  const nextSectionIndex = getNextSectionHeaderIndex(allRows, sectionIndex);

  for (let i = sectionIndex + 1; i < allRows.length; i += 1) {
    if (nextSectionIndex !== -1 && i >= nextSectionIndex) {
      break;
    }

    const row = allRows[i];
    if (isChiefLeadershipRank(row.rank)) {
      insertAfter = row.rowNumber;
    }
  }

  return insertAfter + 1;
}

function commanderOutsideOfficeSection(row, allRows, config) {
  if (!isCommanderDataRow(row, config)) return false;

  const sectionIndex = findSectionHeaderIndex(allRows, config.officeOfChiefSection);
  if (sectionIndex === -1) return true;

  const insertRow = getOfficeOfChiefInsertRow(allRows, config);
  const nextSectionIndex = getNextSectionHeaderIndex(allRows, sectionIndex);
  const sectionEndRow =
    nextSectionIndex === -1 ? Number.POSITIVE_INFINITY : allRows[nextSectionIndex].rowNumber;

  return row.rowNumber < insertRow || row.rowNumber >= sectionEndRow;
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

async function repairMislabeledCommanderRanks(config) {
  const { sheetName, allRows } = await getAllRosterSheetRows();
  const commanderLabel =
    findSheetRankLabel(allRows, config.commanderRank) ?? config.commanderRank.toUpperCase();

  const updates = [];
  for (const row of allRows) {
    if (!isMislabeledCommanderRow(row, config)) continue;
    updates.push({
      range: `${sheetName}!${row.rankCol}${row.rowNumber}`,
      values: [[commanderLabel]],
    });
  }

  if (updates.length === 0) {
    return { repaired: 0, commanderLabel };
  }

  await batchUpdateCells(updates);
  return { repaired: updates.length, commanderLabel };
}

async function moveCommandersIntoOfficeOfChiefSection(config) {
  const sheetName = getRosterSheetName();
  const movedLabels = [];
  let moved = 0;
  let safety = 0;

  while (safety < 50) {
    safety += 1;
    const { allRows } = await getAllRosterSheetRows();
    const insertRow = getOfficeOfChiefInsertRow(allRows, config);

    if (!insertRow) {
      throw new Error(
        `Could not find an **${config.officeOfChiefSection}** section header on the roster sheet.`,
      );
    }

    const commander = allRows.find(
      (row) => isCommanderDataRow(row, config) && commanderOutsideOfficeSection(row, allRows, config),
    );

    if (!commander) {
      break;
    }

    const movedOk = await moveRowBlock(sheetName, commander.rowNumber, insertRow);
    if (!movedOk) {
      break;
    }

    moved += 1;
    movedLabels.push(`${commander.name} / ${commander.callsign}`);
  }

  return { moved, commanders: movedLabels };
}

function captainSortIndex(row, bounds) {
  return row.rowNumber - bounds.firstDataRow;
}

async function moveCaptainsToTopOfSupervisorySection(config) {
  const sheetName = getRosterSheetName();
  const movedLabels = [];
  let moved = 0;
  let safety = 0;

  while (safety < 50) {
    safety += 1;
    const { allRows } = await getAllRosterSheetRows();
    const bounds = getSectionBounds(allRows, config.supervisorySection);

    if (!bounds) {
      throw new Error(
        `Could not find a **${config.supervisorySection}** section header on the roster sheet.`,
      );
    }

    const captains = allRows
      .filter((row) => isCaptainDataRow(row, config))
      .sort((left, right) => left.rowNumber - right.rowNumber);

    const misplaced = captains.find((row, index) => captainSortIndex(row, bounds) !== index);

    if (!misplaced) {
      const outside = captains.find((row) => row.rowNumber < bounds.headerRow || row.rowNumber > bounds.lastRow);
      if (!outside) {
        break;
      }
    }

    const target = misplaced ?? captains.find((row) => row.rowNumber < bounds.headerRow || row.rowNumber > bounds.lastRow);
    if (!target) {
      break;
    }

    const targetIndex = captains.indexOf(target);
    const destinationRow = bounds.firstDataRow + targetIndex;
    const movedOk = await moveRowBlock(sheetName, target.rowNumber, destinationRow);

    if (!movedOk) {
      break;
    }

    moved += 1;
    movedLabels.push(`${target.name || "(vacant)"} / ${target.callsign}`);
  }

  return { moved, captains: movedLabels };
}

function readReorganizeMarker() {
  if (!fs.existsSync(REORGANIZE_MARKER_PATH)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(REORGANIZE_MARKER_PATH, "utf8"));
  } catch {
    return null;
  }
}

function hasReorganizeMarker() {
  const marker = readReorganizeMarker();
  return (marker?.version ?? 0) >= REORGANIZE_VERSION;
}

function writeReorganizeMarker(summary) {
  fs.mkdirSync(path.dirname(REORGANIZE_MARKER_PATH), { recursive: true });
  fs.writeFileSync(
    REORGANIZE_MARKER_PATH,
    JSON.stringify(
      { version: REORGANIZE_VERSION, completedAt: new Date().toISOString(), ...summary },
      null,
      2,
    ),
    "utf8",
  );
}

async function reorganizeRosterStructure({ dryRun = false, force = false } = {}) {
  const marker = readReorganizeMarker();
  const needsRun = force || (marker?.version ?? 0) < REORGANIZE_VERSION;

  if (!needsRun) {
    return {
      skipped: true,
      reason: "Roster reorganization v2 already completed (marker file exists).",
    };
  }

  const config = getReorganizeConfig();
  const { allRows } = await getAllRosterSheetRows();

  const plan = {
    version: REORGANIZE_VERSION,
    repairMislabeled: allRows.filter((row) => isMislabeledCommanderRow(row, config)).length,
    commandersToMove: allRows.filter(
      (row) => isCommanderDataRow(row, config) && commanderOutsideOfficeSection(row, allRows, config),
    ).length,
    captains: allRows.filter((row) => isCaptainDataRow(row, config)).map((row) => row.callsign),
    officeSection: config.officeOfChiefSection,
    supervisorySection: config.supervisorySection,
  };

  if (dryRun) {
    return { dryRun: true, plan };
  }

  const repairResult = await repairMislabeledCommanderRanks(config);
  const commanderMoveResult = await moveCommandersIntoOfficeOfChiefSection(config);
  const captainMoveResult = await moveCaptainsToTopOfSupervisorySection(config);

  const summary = {
    repairedCommanderRanks: repairResult.repaired,
    commanderLabel: repairResult.commanderLabel,
    movedCommanderRows: commanderMoveResult.moved,
    commanders: commanderMoveResult.commanders,
    movedCaptainRows: captainMoveResult.moved,
    captains: captainMoveResult.captains,
  };

  writeReorganizeMarker(summary);

  return { dryRun: false, plan, ...summary };
}

module.exports = {
  getReorganizeConfig,
  reorganizeRosterStructure,
  hasReorganizeMarker,
  readReorganizeMarker,
  REORGANIZE_MARKER_PATH,
  REORGANIZE_VERSION,
};
