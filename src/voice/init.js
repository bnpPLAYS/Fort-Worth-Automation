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
    })();
  }

  return voiceInitPromise;
}

module.exports = {
  ensureVoiceReady,
};
