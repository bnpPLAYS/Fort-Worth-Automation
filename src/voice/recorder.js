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
    this.sessionId = `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.segments = [];
    this.subscription = null;
    this.decoder = null;
    this.fileStream = null;
    this.currentPcmPath = null;
    this.userCaptureActive = false;
    this.sessionStarted = false;
    this.lastFlushedSegmentBytes = 0;
  }

  start() {
    this.startSession();
  }

  startSession() {
    if (this.sessionStarted) return;
    this.sessionStarted = true;
    this.startUserCapture();
  }

  startUserCapture() {
    if (this.userCaptureActive) return;

    this.userCaptureActive = true;
    this.currentPcmPath = path.join(
      os.tmpdir(),
      `interview-seg-user-${this.sessionId}-${this.segments.length}.pcm`,
    );
    this.fileStream = fs.createWriteStream(this.currentPcmPath);
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

  async pauseUserCapture() {
    if (!this.userCaptureActive) return;
    await this.flushUserCapture();
  }

  resumeUserCapture() {
    if (!this.sessionStarted) return;
    this.startUserCapture();
  }

  async flushUserCapture() {
    if (this.subscription) {
      this.subscription.destroy();
      this.subscription = null;
    }

    if (this.decoder) {
      this.decoder.end();
      await new Promise((resolve) => setTimeout(resolve, 150));
      this.decoder.destroy();
      this.decoder = null;
    }

    if (this.fileStream) {
      await new Promise((resolve) => this.fileStream.end(resolve));
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.fileStream = null;
    }

    const pcmPath = this.currentPcmPath;
    this.currentPcmPath = null;
    this.userCaptureActive = false;

    if (!pcmPath || !fs.existsSync(pcmPath)) {
      return;
    }

    const { size } = fs.statSync(pcmPath);
    this.lastFlushedSegmentBytes = size;
    if (size < MIN_PCM_BYTES) {
      fs.unlink(pcmPath, () => {});
      return;
    }

    const mp3Path = pcmPath.replace(/\.pcm$/, ".mp3");
    try {
      await convertPcmToMp3(pcmPath, mp3Path, 2);
    } catch (error) {
      try {
        await convertPcmToMp3(pcmPath, mp3Path, 1);
      } catch (monoError) {
        console.warn("[interview-recorder] user segment conversion failed:", monoError.message);
        fs.unlink(pcmPath, () => {});
        return;
      }
    }

    fs.unlink(pcmPath, () => {});
    this.segments.push(mp3Path);
  }

  async addTtsSegment(sourceMp3Path) {
    if (!sourceMp3Path || !fs.existsSync(sourceMp3Path)) return;

    await this.pauseUserCapture();

    const dest = path.join(
      os.tmpdir(),
      `interview-seg-tts-${this.sessionId}-${this.segments.length}.mp3`,
    );
    fs.copyFileSync(sourceMp3Path, dest);
    this.segments.push(dest);
  }

  async flushAndMeasureUserAudio() {
    await this.pauseUserCapture();
    const hadVoice = this.lastFlushedSegmentBytes >= MIN_PCM_BYTES;
    if (this.sessionStarted) {
      this.startUserCapture();
    }
    return hadVoice;
  }

  async stop() {
    await this.pauseUserCapture();

    if (this.segments.length === 0) {
      console.warn("[interview-recorder] No audio segments captured.");
      return null;
    }

    const outputPath = path.join(os.tmpdir(), `interview-rec-${this.sessionId}.mp3`);

    try {
      if (this.segments.length === 1) {
        fs.copyFileSync(this.segments[0], outputPath);
      } else {
        await concatMp3Segments(this.segments, outputPath);
      }
    } catch (error) {
      console.error("[interview-recorder] concat failed:", error.message);
      return null;
    } finally {
      for (const segmentPath of this.segments) {
        fs.unlink(segmentPath, () => {});
      }
      this.segments = [];
    }

    return outputPath;
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

function concatMp3Segments(segmentPaths, outputPath) {
  if (!ffmpegPath) {
    return Promise.reject(new Error("FFmpeg is not available."));
  }

  const listPath = path.join(os.tmpdir(), `interview-concat-${Date.now()}.txt`);
  const listContent = segmentPaths
    .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
    .join("\n");
  fs.writeFileSync(listPath, listContent);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-codec:a",
      "libmp3lame",
      "-ar",
      "48000",
      "-b:a",
      "96k",
      "-y",
      outputPath,
    ]);

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      fs.unlink(listPath, () => {});
      if (code === 0) resolve(outputPath);
      else reject(new Error(`ffmpeg concat exited with code ${code}: ${stderr.slice(-200)}`));
    });
  });
}

module.exports = {
  VoiceInterviewRecorder,
};
