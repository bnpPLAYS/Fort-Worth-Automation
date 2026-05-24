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

function extractCallsignFromDisplayName(displayName) {
  const text = String(displayName ?? "").trim();
  const prefixMatch = text.match(ANY_CALLSIGN_PREFIX_PATTERN);
  if (prefixMatch) {
    return prefixMatch[1].toUpperCase().startsWith("C-")
      ? formatCallsignForDisplay(prefixMatch[1])
      : normalizeCallsign(prefixMatch[1]);
  }

  const cadetMatch = text.match(CADET_CALLSIGN_WORD_PATTERN);
  if (cadetMatch) {
    return formatCallsignForDisplay(cadetMatch[1]);
  }

  const wordMatch = text.match(NUMERIC_CALLSIGN_WORD_PATTERN);
  return wordMatch ? normalizeCallsign(wordMatch[1]) : "";
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
  const normalizedCallsign = normalizeCallsign(currentCallsign);
  const normalizedName = String(roleplayName).trim().toLowerCase();

  if (guild.memberCount > guild.members.cache.size) {
    await guild.members.fetch().catch(() => null);
  }

  const byCallsign = guild.members.cache.find((member) => {
    const memberCallsign = extractCallsignFromDisplayName(member.displayName);
    if (/^C-/i.test(String(currentCallsign))) {
      return memberCallsign.toUpperCase() === String(currentCallsign).trim().toUpperCase();
    }
    return memberCallsign === normalizedCallsign;
  });
  if (byCallsign) return byCallsign;

  return (
    guild.members.cache.find((member) => {
      const display = member.displayName.trim().toLowerCase();
      const afterPipe = display.split("|").pop()?.trim() ?? "";
      return (
        display === normalizedName ||
        afterPipe === normalizedName ||
        display.includes(normalizedName)
      );
    }) ?? null
  );
}

module.exports = {
  formatCallsignForDisplay,
  extractCallsignFromDisplayName,
  getRoleplayNameFromMember,
  buildDisplayNameWithCallsign,
  updateMemberCallsign,
  findMemberForRosterEntry,
};
