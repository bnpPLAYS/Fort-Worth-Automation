#!/usr/bin/env node
/**
 * Clear saved voice interview applications and interview cooldown for a Discord user.
 * Usage: node scripts/clear-interview-state.js <userId>
 */
require("dotenv").config();

const {
  clearInterviewApplicationsForUser,
} = require("../src/interview-applications-store");
const { clearCooldown } = require("../src/cooldowns");

const INTERVIEW_COOLDOWN_TYPE = "interview";
const userId = process.argv[2];

if (!userId) {
  console.error("Usage: node scripts/clear-interview-state.js <discordUserId>");
  process.exit(1);
}

const removedAppIds = clearInterviewApplicationsForUser(userId);
const hadCooldown = clearCooldown(userId, INTERVIEW_COOLDOWN_TYPE);

console.log(
  `Cleared ${removedAppIds.length} interview application(s) for ${userId}` +
    (hadCooldown ? ", removed interview cooldown" : "") +
    (removedAppIds.length > 0 ? `\nRemoved app IDs: ${removedAppIds.join(", ")}` : ""),
);

if (removedAppIds.length === 0 && !hadCooldown) {
  console.log("Nothing was stored for that user. Restart the bot if an interview session is still active in memory.");
}
