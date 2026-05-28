const ANY_CALLSIGN_PREFIX_PATTERN = /^((?:C-\d{1,3}|\d{3,5}))\s*\|\s*/i;
const NUMERIC_CALLSIGN_WORD_PATTERN = /\b(\d{3,5})\b/;
const CADET_CALLSIGN_WORD_PATTERN = /\b(C-\d{1,3})\b/i;

function normalizeCallsign(value) {
  return String(value).replace(/\D/g, "");
}

function formatCallsignForDisplay(value) {
  const text = String(value).trim();
  const cadetMatch = text.match(/^C-(\d{1,3})$/i);
  if (cadetMatch) {
    return `C-${Number.parseInt(cadetMatch[1], 10)}`;
  }

  const digits = normalizeCallsign(text);
  if (!digits) return text;
  return digits.length >= 4 ? digits.slice(-4) : digits.padStart(4, "0");
}

function callsignsMatch(sheetCallsign, memberCallsign) {
  if (!sheetCallsign || !memberCallsign) return false;

  const formattedSheet = formatCallsignForDisplay(sheetCallsign);
  const formattedMember = formatCallsignForDisplay(memberCallsign);

  if (/^C-/i.test(formattedSheet)) {
    return formattedSheet.toUpperCase() === formattedMember.toUpperCase();
  }

  return (
    String(formattedSheet).replace(/\D/g, "") === String(formattedMember).replace(/\D/g, "")
  );
}

function extractCallsignFromDisplayName(displayName, { strict = false } = {}) {
  const text = String(displayName ?? "").trim();
  const prefixMatch = text.match(ANY_CALLSIGN_PREFIX_PATTERN);
  if (prefixMatch) {
    return prefixMatch[1].toUpperCase().startsWith("C-")
      ? formatCallsignForDisplay(prefixMatch[1])
      : normalizeCallsign(prefixMatch[1]);
  }

  if (strict) {
    return "";
  }

  const cadetMatch = text.match(CADET_CALLSIGN_WORD_PATTERN);
  if (cadetMatch) {
    return formatCallsignForDisplay(cadetMatch[1]);
  }

  const wordMatch = text.match(NUMERIC_CALLSIGN_WORD_PATTERN);
  return wordMatch ? normalizeCallsign(wordMatch[1]) : "";
}

/** Department nickname format only: `3000 | J. Forman` or `C-3 | J. Smith` */
function extractDepartmentCallsignFromDisplayName(displayName) {
  return extractCallsignFromDisplayName(displayName, { strict: true });
}

function getRoleplayNameFromMember(member) {
  const display = String(member?.displayName ?? "").trim();
  const afterPipe = display.split("|").pop()?.trim();
  if (afterPipe && afterPipe.length >= 2) {
    return afterPipe;
  }
  if (display.length >= 2) {
    return display;
  }
  return member.user.username;
}

function buildDisplayNameWithCallsign(displayName, newCallsign, roleplayName) {
  const callsign = formatCallsignForDisplay(newCallsign);
  const formattedName = String(roleplayName ?? "").trim();

  if (formattedName) {
    const nickname = `${callsign} | ${formattedName}`;
    return nickname.length > 32 ? nickname.slice(0, 32).trim() : nickname;
  }

  const current = String(displayName ?? "").trim();

  let updated;
  const fallbackName = current;
  if (ANY_CALLSIGN_PREFIX_PATTERN.test(current)) {
    updated = current.replace(ANY_CALLSIGN_PREFIX_PATTERN, `${callsign} | `);
  } else if (CADET_CALLSIGN_WORD_PATTERN.test(current)) {
    updated = current.replace(CADET_CALLSIGN_WORD_PATTERN, callsign);
  } else if (NUMERIC_CALLSIGN_WORD_PATTERN.test(current)) {
    updated = current.replace(NUMERIC_CALLSIGN_WORD_PATTERN, callsign);
  } else if (current.length > 0) {
    updated = `${callsign} | ${current}`;
  } else {
    updated = `${callsign} | ${fallbackName}`;
  }

  if (updated.length > 32) {
    updated = `${callsign} | ${fallbackName}`.slice(0, 32).trim();
  }

  return updated;
}

async function updateMemberCallsign(member, newCallsign, roleplayName) {
  if (!member?.manageable) {
    return {
      ok: false,
      reason: "Bot cannot change this member's nickname (role hierarchy or permissions).",
    };
  }

  const nextNickname = buildDisplayNameWithCallsign(
    member.displayName,
    newCallsign,
    roleplayName,
  );

  if (nextNickname === member.displayName) {
    return { ok: true, nickname: nextNickname, changed: false };
  }

  try {
    await member.setNickname(nextNickname, "Roster callsign update");
    return { ok: true, nickname: nextNickname, changed: true };
  } catch (error) {
    return {
      ok: false,
      reason: error.message ?? "Failed to set nickname.",
    };
  }
}

async function findMemberForRosterEntry(guild, { roleplayName, currentCallsign }) {
  const { hasRosterSyncRole } = require("./member-roster");
  const normalizedName = String(roleplayName).trim().toLowerCase();

  if (guild.memberCount > guild.members.cache.size) {
    await guild.members.fetch().catch(() => null);
  }

  const rosterMembers = guild.members.cache.filter((member) => hasRosterSyncRole(member));

  const byCallsign = rosterMembers.filter((member) =>
    callsignsMatch(
      currentCallsign,
      extractDepartmentCallsignFromDisplayName(member.displayName),
    ),
  );
  if (byCallsign.length === 1) return byCallsign[0];

  const byName = rosterMembers.filter((member) => {
    const display = member.displayName.trim().toLowerCase();
    const afterPipe = display.split("|").pop()?.trim() ?? "";
    return afterPipe === normalizedName;
  });

  if (byName.length === 1) {
    return byName[0];
  }

  if (byName.length > 1 && currentCallsign) {
    return (
      byName.find((member) =>
        callsignsMatch(
          currentCallsign,
          extractDepartmentCallsignFromDisplayName(member.displayName),
        ),
      ) ?? null
    );
  }

  return null;
}

module.exports = {
  formatCallsignForDisplay,
  callsignsMatch,
  extractCallsignFromDisplayName,
  extractDepartmentCallsignFromDisplayName,
  getRoleplayNameFromMember,
  buildDisplayNameWithCallsign,
  updateMemberCallsign,
  findMemberForRosterEntry,
};
