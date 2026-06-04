const pausedMembersUntil = new Map();
let globalPausedUntil = 0;

function pauseRoleSyncForMember(memberOrId, durationMs = 120_000) {
  const userId = typeof memberOrId === "string" ? memberOrId : memberOrId?.id;
  if (!userId) return;

  pausedMembersUntil.set(userId, Date.now() + durationMs);
}

function pauseRoleSyncGlobally(durationMs = 30_000) {
  globalPausedUntil = Math.max(globalPausedUntil, Date.now() + durationMs);
}

function isRoleSyncPaused(memberOrId) {
  if (Date.now() < globalPausedUntil) {
    return true;
  }

  const userId = typeof memberOrId === "string" ? memberOrId : memberOrId?.id;
  if (!userId) return false;

  const until = pausedMembersUntil.get(userId) ?? 0;
  if (Date.now() >= until) {
    pausedMembersUntil.delete(userId);
    return false;
  }

  return true;
}

function clearRoleSyncPause(memberOrId) {
  const userId = typeof memberOrId === "string" ? memberOrId : memberOrId?.id;
  if (!userId) return;
  pausedMembersUntil.delete(userId);
}

module.exports = {
  pauseRoleSyncForMember,
  pauseRoleSyncGlobally,
  isRoleSyncPaused,
  clearRoleSyncPause,
};
