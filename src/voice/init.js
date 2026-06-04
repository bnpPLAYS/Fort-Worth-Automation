const { generateDependencyReport } = require("@discordjs/voice");

let voiceInitPromise = null;

async function ensureVoiceReady() {
  if (!voiceInitPromise) {
    voiceInitPromise = (async () => {
      try {
        const sodium = require("libsodium-wrappers");
        await sodium.ready;
      } catch (error) {
        console.warn("[voice] libsodium-wrappers unavailable:", error.message);
      }

      try {
        require("opusscript");
      } catch (error) {
        console.warn("[voice] opusscript unavailable:", error.message);
      }

      const report = generateDependencyReport();
      console.log(`[voice] ${report.replace(/\n/g, " | ")}`);

      if (report.includes("sodium") && report.includes("no")) {
        console.warn(
          "[voice] Voice encryption library missing — the bot may not connect to voice. Install libsodium-wrappers.",
        );
      }
      if (report.includes("opus") && report.includes("no")) {
        console.warn("[voice] Opus library missing — voice playback/recording may fail.");
      }
      if (report.includes("ffmpeg") && report.includes("no")) {
        console.warn("[voice] FFmpeg missing — TTS playback will fail.");
      }
    })();
  }

  return voiceInitPromise;
}

module.exports = {
  ensureVoiceReady,
};
