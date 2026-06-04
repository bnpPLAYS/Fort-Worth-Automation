const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { EndBehaviorType } = require("@discordjs/voice");
const prism = require("prism-media");
const ffmpegPath = require("ffmpeg-static");

const MIN_PCM_BYTES = 200;

class VoiceInterviewRecorder {
  constructor(connection, userId) {
    this.connection = connection;
    this.userId = userId;
    this.pcmPath = path.join(
      os.tmpdir(),
      `interview-rec-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.pcm`,
    );
    this.mp3Path = this.pcmPath.replace(/\.pcm$/, ".mp3");
    this.subscription = null;
    this.decoder = null;
    this.fileStream = null;
    this.started = false;
  }

  start() {
    if (this.started) return;
    this.started = true;

    this.fileStream = fs.createWriteStream(this.pcmPath);
    this.decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    this.subscription = this.connection.receiver.subscribe(this.userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    this.subscription.on("error", (error) => {
      console.warn("[interview-recorder] subscription error:", error.message);
    });
    this.decoder.on("error", (error) => {
      console.warn("[interview-recorder] decoder error:", error.message);
    });

    this.subscription.pipe(this.decoder);
    this.decoder.pipe(this.fileStream);
  }

  async stop() {
    if (this.subscription) {
      this.subscription.destroy();
      this.subscription = null;
    }

    if (this.decoder) {
      this.decoder.end();
      await new Promise((resolve) => setTimeout(resolve, 200));
      this.decoder.destroy();
      this.decoder = null;
    }

    if (this.fileStream) {
      await new Promise((resolve) => this.fileStream.end(resolve));
      await new Promise((resolve) => setTimeout(resolve, 150));
      this.fileStream = null;
    }

    if (!fs.existsSync(this.pcmPath)) {
      console.warn("[interview-recorder] No PCM file written.");
      return null;
    }

    const { size } = fs.statSync(this.pcmPath);
    if (size < MIN_PCM_BYTES) {
      console.warn(`[interview-recorder] PCM file too small (${size} bytes).`);
      fs.unlink(this.pcmPath, () => {});
      return null;
    }

    try {
      await convertPcmToMp3(this.pcmPath, this.mp3Path, 2);
    } catch (error) {
      console.warn("[interview-recorder] stereo mp3 failed, trying mono:", error.message);
      try {
        await convertPcmToMp3(this.pcmPath, this.mp3Path, 1);
      } catch (monoError) {
        console.error("[interview-recorder] ffmpeg conversion failed:", monoError.message);
        fs.unlink(this.pcmPath, () => {});
        return null;
      }
    }

    fs.unlink(this.pcmPath, () => {});
    return this.mp3Path;
  }
}

function convertPcmToMp3(pcmPath, mp3Path, channels = 2) {
  if (!ffmpegPath) {
    return Promise.reject(new Error("FFmpeg is not available."));
  }

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      String(channels),
      "-i",
      pcmPath,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      "96k",
      "-y",
      mp3Path,
    ]);

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve(mp3Path);
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200)}`));
    });
  });
}

module.exports = {
  VoiceInterviewRecorder,
};
