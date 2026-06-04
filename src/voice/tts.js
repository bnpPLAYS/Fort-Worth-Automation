const fs = require("fs");
const os = require("os");
const path = require("path");

const TTS_TIMEOUT_MS = 20_000;

async function synthesizeSpeechWithFetch(text, { slow = false } = {}) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("TTS text is empty.");
  }

  const filePath = path.join(
    os.tmpdir(),
    `hpd-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`,
  );

  const url =
    "https://translate.google.com/translate_tts?" +
    new URLSearchParams({
      ie: "UTF-8",
      client: "tw-ob",
      q: trimmed.slice(0, 200),
      tl: "en",
      ...(slow ? { ttsspeed: "0.5" } : {}),
    }).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`TTS request failed (${response.status}).`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100) {
      throw new Error("TTS returned an empty audio file.");
    }

    fs.writeFileSync(filePath, buffer);
    return filePath;
  } finally {
    clearTimeout(timeout);
  }
}

async function synthesizeSpeechWithGtts(text, { slow = false } = {}) {
  const gTTS = require("gtts");
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("TTS text is empty.");
  }

  const filePath = path.join(
    os.tmpdir(),
    `hpd-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`,
  );

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("TTS timed out.")), TTS_TIMEOUT_MS);
    const tts = new gTTS(trimmed.slice(0, 200), "en", slow);
    tts.save(filePath, (error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
  });

  return filePath;
}

async function synthesizeSpeech(text, options = {}) {
  try {
    return await synthesizeSpeechWithFetch(text, options);
  } catch (fetchError) {
    console.warn("[tts] Fetch TTS failed, trying gTTS:", fetchError.message);
    return synthesizeSpeechWithGtts(text, options);
  }
}

function deleteTempFile(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

module.exports = {
  synthesizeSpeech,
  deleteTempFile,
};
