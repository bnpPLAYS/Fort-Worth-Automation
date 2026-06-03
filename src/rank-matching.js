const RANK_SPELLING_CORRECTIONS = new Map([
  ["corparal", "corporal"],
]);

const RANK_CANONICAL_ALIASES = new Map([
  ["officer i", "officer one"],
  ["officer ii", "officer two"],
  ["officer iii", "officer three"],
  ["officer 1", "officer one"],
  ["officer 2", "officer two"],
  ["officer 3", "officer three"],
  ["commander", "office of the chief"],
  ["chief commander", "office of the chief"],
  ["patrol commander", "office of the chief"],
]);

function normalizeRank(value) {
  let normalized = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  if (RANK_SPELLING_CORRECTIONS.has(normalized)) {
    normalized = RANK_SPELLING_CORRECTIONS.get(normalized);
  }
  return normalized;
}

function canonicalRank(value) {
  const normalized = normalizeRank(value);
  return RANK_CANONICAL_ALIASES.get(normalized) ?? normalized;
}

function rankTokens(rankName) {
  const normalized = canonicalRank(rankName);
  const parts = normalized
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
  const core = parts.length > 1 ? parts[parts.length - 1] : normalized;

  return [...new Set([normalized, core, ...parts].map(canonicalRank))];
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
  canonicalRank,
  rankTokens,
  ranksMatch,
};
