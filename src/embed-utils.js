function getErrorMessage(error) {
  if (!error) return "Unknown error";

  if (error.errors instanceof Map) {
    return [...error.errors.values()]
      .map((entry) => entry?.message ?? String(entry))
      .join("; ");
  }

  if (Array.isArray(error.errors)) {
    return error.errors.map((entry) => entry?.message ?? String(entry)).join("; ");
  }

  return error.message ?? String(error);
}

function truncateEmbedField(text, maxLength = 1020) {
  const value = String(text ?? "").trim() || "None";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function formatEmbedList(items, { maxItems = 10, emptyLabel = "None", maxLength = 1020 } = {}) {
  if (!items?.length) return emptyLabel;

  const lines = items.slice(0, maxItems).map((item) => String(item).slice(0, 180));
  let text = lines.join("\n");

  if (items.length > maxItems) {
    text += `\n…and ${items.length - maxItems} more`;
  }

  return truncateEmbedField(text, maxLength);
}

module.exports = {
  getErrorMessage,
  truncateEmbedField,
  formatEmbedList,
};
