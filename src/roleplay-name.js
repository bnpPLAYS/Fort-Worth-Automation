function formatRoleplayInitials(fullName) {
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    throw new Error("Enter your full roleplay name with at least a **first and last name** (e.g. John Smith).");
  }

  const firstInitial = parts[0][0].toUpperCase();
  const lastName = parts[parts.length - 1];
  const formattedLast =
    lastName[0].toUpperCase() + lastName.slice(1).toLowerCase().replace(/[^a-z'-]/gi, "");

  if (!formattedLast) {
    throw new Error("Enter a valid last name for your roleplay name.");
  }

  return `${firstInitial}. ${formattedLast}`;
}

module.exports = {
  formatRoleplayInitials,
};
