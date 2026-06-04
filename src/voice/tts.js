const fs = require("fs");
const os = require("os");
const path = require("path");
const gTTS = require("gtts");

function synthesizeSpeech(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return Promise.reject(new Error("TTS text is empty."));
  }

  const filePath = path.join(os.tmpdir(), `hpd-interview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`);

  return new Promise((resolve, reject) => {
    const tts = new gTTS(trimmed, "en");
    tts.save(filePath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(filePath);
    });
  });
}

function deleteTempFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

module.exports = {
  synthesizeSpeech,
  deleteTempFile,
};
