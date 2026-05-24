const CALLSIGN_PREFIX_PATTERN = /^(\d{3,5})\s*\|\s*/;
const CALLSIGN_WORD_PATTERN = /\b(\d{3,5})\b/;

function normalizeCallsign(value) {
  return String(value).replace(/\D/g, "");
}

function formatCallsign(value) {
  const digits = normalizeCallsign(value);
  if (!digits) return "";
  return digits.length >= 4 ? digits.slice(-4) : digits.padStart(4, "0");
}

function extractCallsignFromDisplayName(displayName) {
  const text = String(displayName ?? "").trim();
  const prefixMatch = text.match(CALLSIGN_PREFIX_PATTERN);
  if (prefixMatch) {
    return normalizeCallsign(prefixMatch[1]);
  }

  const wordMatch = text.match(CALLSIGN_WORD_PATTERN);
  return wordMatch ? normalizeCallsign(wordMatch[1]) : "";
}

function buildDisplayNameWithCallsign(displayName, newCallsign, roleplayName) {
  const callsign = formatCallsign(newCallsign);
  const current = String(displayName ?? "").trim();
  const fallbackName = String(roleplayName ?? "").trim() || current;

  let updated;
  if (CALLSIGN_PREFIX_PATTERN.test(current)) {
    updated = current.replace(CALLSIGN_PREFIX_PATTERN, `${callsign} | `);
  } else if (CALLSIGN_WORD_PATTERN.test(current)) {
    updated = current.replace(CALLSIGN_WORD_PATTERN, callsign);
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
    await member.setNickname(nextNickname, "Roster promotion — callsign update");
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

  const byCallsign = guild.members.cache.find(
    (member) => extractCallsignFromDisplayName(member.displayName) === normalizedCallsign,
  );
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
  formatCallsign,
  extractCallsignFromDisplayName,
  buildDisplayNameWithCallsign,
  updateMemberCallsign,
  findMemberForRosterEntry,
};
