const { runRosterDiagnostics } = require("./google-sheets/diagnostics");
const { isSheetsConfigured } = require("./google-sheets/client");
const { ensureAuditChannel, logRosterAudit } = require("./roster-audit-log");
const { buildV2Payload } = require("./v2-message");

async function runStartupHealthCheck(client) {
  if (!client) return;

  for (const guild of client.guilds.cache.values()) {
    try {
      const auditChannel = (await ensureAuditChannel(guild)) ?? null;

      if (!isSheetsConfigured()) {
        if (auditChannel) {
          await auditChannel.send(
            buildV2Payload({
              title: "Startup health — Google Sheets not configured",
              description:
                "The bot started but roster integration is incomplete. Check `.env` and credentials on the server.",
              includeFiles: false,
            }),
          );
        }
        continue;
      }

      const result = await runRosterDiagnostics();

      if (auditChannel) {
        await auditChannel.send(
          buildV2Payload({
            title: result.ok ? "Startup health — roster OK" : "Startup health — roster issues",
            description: result.lines.join("\n"),
            footer: result.serviceAccountEmail
              ? `Service account: ${result.serviceAccountEmail}`
              : undefined,
            includeFiles: false,
          }),
        );
      }

      if (!result.ok) {
        console.warn(`[startup-health] Roster issues detected for guild ${guild.id}`);
      }
    } catch (error) {
      console.error(`[startup-health] Failed for guild ${guild.id}:`, error);

      await logRosterAudit(client, guild.id, {
        title: "Startup health check failed",
        trigger: "startup",
        notes: error.message ?? String(error),
      }).catch(() => null);
    }
  }
}

module.exports = {
  runStartupHealthCheck,
};
