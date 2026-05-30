const RANK_SPELLING_CORRECTIONS = new Map([
  ["corparal", "corporal"],
]);

function normalizeRank(value) {
  let normalized = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  if (RANK_SPELLING_CORRECTIONS.has(normalized)) {
    normalized = RANK_SPELLING_CORRECTIONS.get(normalized);
  }
  return normalized;
}

function rankTokens(rankName) {
  const normalized = normalizeRank(rankName);
  const parts = normalized
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const core = parts.length > 1 ? parts[parts.length - 1] : normalized;

  return [...new Set([normalized, core, ...parts])];
}

function ranksMatch(requested, candidate) {
  const requestedTokens = rankTokens(requested);
  const candidateTokens = rankTokens(candidate);

  return requestedTokens.some((left) =>
    candidateTokens.some((right) => left === right),
  );
}

module.exports = {
  normalizeRank,
  rankTokens,
  ranksMatch,
};
