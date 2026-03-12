/**
 * src/videoExporter.js
 * Convert sensor_msgs/Image or CompressedImage stream to MP4
 * Uses ffmpeg-static (bundled binary, no system install needed)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// Use bundled ffmpeg binary — resolve out of asar if packaged
let ffmpegPath;
try {
  ffmpegPath = require("ffmpeg-static");
  // electron-builder unpacks asarUnpack modules to app.asar.unpacked/
  // ffmpeg-static returns a path ending in /ffmpeg or /ffmpeg.exe
  // In a packaged app that path points inside the asar (unreadable by OS).
  // Rewrite it to the .unpacked sibling directory.
  if (ffmpegPath && ffmpegPath.includes("app.asar")) {
    ffmpegPath = ffmpegPath.replace("app.asar", "app.asar.unpacked");
  }
} catch {
  ffmpegPath = "ffmpeg"; // fallback to system ffmpeg
}

/**
 * Decode a sensor_msgs/Image message to raw RGBA buffer
 */
function decodeRosImage(msg) {
  const { encoding, width, height, data, step } = msg;

  if (!data || !width || !height) return null;

  const rgba = Buffer.alloc(width * height * 4);
  const enc = (encoding || "bgr8").toLowerCase();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // step = bytes per row (already accounts for channel count)
      // srcBase = byte offset of the first channel of pixel (y, x)
      const srcBase = y * step + x * bytesPerPixel(enc);
      const dstIdx  = (y * width + x) * 4;

      if (enc === "rgb8") {
        rgba[dstIdx]     = data[srcBase];
        rgba[dstIdx + 1] = data[srcBase + 1];
        rgba[dstIdx + 2] = data[srcBase + 2];
        rgba[dstIdx + 3] = 255;
      } else if (enc === "bgr8") {
        rgba[dstIdx]     = data[srcBase + 2];
        rgba[dstIdx + 1] = data[srcBase + 1];
        rgba[dstIdx + 2] = data[srcBase];
        rgba[dstIdx + 3] = 255;
      } else if (enc === "mono8") {
        rgba[dstIdx]     = data[srcBase];
        rgba[dstIdx + 1] = data[srcBase];
        rgba[dstIdx + 2] = data[srcBase];
        rgba[dstIdx + 3] = 255;
      } else if (enc === "mono16") {
        // Take the high byte as luminance
        const lum = data[srcBase + 1];
        rgba[dstIdx]     = lum;
        rgba[dstIdx + 1] = lum;
        rgba[dstIdx + 2] = lum;
        rgba[dstIdx + 3] = 255;
      } else if (enc === "bgra8") {
        rgba[dstIdx]     = data[srcBase + 2];
        rgba[dstIdx + 1] = data[srcBase + 1];
        rgba[dstIdx + 2] = data[srcBase];
        rgba[dstIdx + 3] = data[srcBase + 3];
      } else if (enc === "rgba8") {
        rgba[dstIdx]     = data[srcBase];
        rgba[dstIdx + 1] = data[srcBase + 1];
        rgba[dstIdx + 2] = data[srcBase + 2];
        rgba[dstIdx + 3] = data[srcBase + 3];
      } else if (enc === "yuv422" || enc === "yuv422_yuy2" || enc === "yuyv") {
        // YUYV packed: 2 pixels per 4 bytes
        const even = (x & 1) === 0;
        const yuyv = Math.floor(x / 2) * 4;
        const Y  = data[srcBase + (even ? 0 : 2)] ?? 0;
        const Cb = data[y * step + yuyv + 1] ?? 128;
        const Cr = data[y * step + yuyv + 3] ?? 128;
        const r = clamp(Y + 1.402   * (Cr - 128));
        const g = clamp(Y - 0.34414 * (Cb - 128) - 0.71414 * (Cr - 128));
        const b = clamp(Y + 1.772   * (Cb - 128));
        rgba[dstIdx]     = r;
        rgba[dstIdx + 1] = g;
        rgba[dstIdx + 2] = b;
        rgba[dstIdx + 3] = 255;
      } else {
        // Unknown — treat as mono8
        rgba[dstIdx]     = data[srcBase] || 0;
        rgba[dstIdx + 1] = data[srcBase] || 0;
        rgba[dstIdx + 2] = data[srcBase] || 0;
        rgba[dstIdx + 3] = 255;
      }
    }
  }

  return { rgba, width, height };
}

function bytesPerPixel(enc) {
  switch (enc) {
    case "mono8":    return 1;
    case "mono16":   return 2;
    case "rgb8":     return 3;
    case "bgr8":     return 3;
    case "rgba8":    return 4;
    case "bgra8":    return 4;
    case "yuv422":
    case "yuv422_yuy2":
    case "yuyv":     return 2; // 4 bytes per 2 pixels
    default:         return 3;
  }
}

function clamp(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Write frames to MP4 via ffmpeg stdin pipe.
 * Streams directly — never buffers all frames in memory.
 */
async function exportVideoTopic(messages, outputPath, onProgress) {
  const frameLog = [];

  // ── First pass: detect type + dimensions from first decodable frame,
  //   collecting compressed frames to a temp dir as we go.
  //   For raw RGBA we need width/height before we can open ffmpeg,
  //   so we peek at the first raw frame then stream the rest.

  // We'll iterate the generator once, routing to one of two code paths:
  //   A) CompressedImage  → write JPEGs to tmpDir, then ffmpeg image2
  //   B) Raw Image        → open ffmpeg pipe after first frame, stream remaining
  //   C) ROS2 raw bytes   → timestamps only, no video output

  let firstMsg = null;
  let msgType = null; // 'compressed' | 'raw' | 'bytes' | null

  // Peek the first usable message to decide path
  const msgIter = messages[Symbol.asyncIterator]();

  while (firstMsg === null) {
    const { value, done } = await msgIter.next();
    if (done) break;
    const msg = value;
    if (!msg || !msg.data) continue;
    if (msg.isRaw) { msgType = 'bytes'; firstMsg = msg; break; }
    if (msg.data.format !== undefined && msg.data.data) { msgType = 'compressed'; firstMsg = msg; break; }
    const decoded = decodeRosImage(msg.data);
    if (decoded) { msgType = 'raw'; firstMsg = { ...msg, decoded }; break; }
  }

  if (!firstMsg || msgType === 'bytes') {
    // Drain rest of iterator cleanly then return
    // eslint-disable-next-line no-unused-vars
    for await (const _ of { [Symbol.asyncIterator]: () => msgIter }) { /* drain */ }
    return { frameCount: 0, frameLog, durationSec: 0, fps: 0 };
  }

  // ── PATH A: CompressedImage ───────────────────────────────────────────────
  if (msgType === 'compressed') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-frames-"));
    let frameIndex = 0;
    let firstTs = null, lastTs = null;

    const writeCompressed = (msg) => {
      const ts = msg.timestamp.sec + msg.timestamp.nsec / 1e9;
      if (firstTs === null) firstTs = ts;
      lastTs = ts;
      fs.writeFileSync(
        path.join(tmpDir, `frame_${String(frameIndex).padStart(6, "0")}.jpg`),
        Buffer.from(msg.data.data)
      );
      frameLog.push({ frameIndex, timestampSec: ts });
      frameIndex++;
      if (onProgress && frameIndex % 30 === 0) onProgress(`Frame ${frameIndex}`);
    };

    writeCompressed(firstMsg);
    for await (const msg of { [Symbol.asyncIterator]: () => msgIter }) {
      if (!msg || !msg.data) continue;
      if (msg.data.format !== undefined && msg.data.data) writeCompressed(msg);
    }

    if (frameIndex === 0) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return { frameCount: 0, frameLog, durationSec: 0, fps: 0 };
    }

    const duration = (lastTs - firstTs) || 1;
    const safeFps = Math.min(Math.max(Math.round(frameIndex / duration), 1), 60);

    try {
      await runFfmpegImages(tmpDir, outputPath, safeFps);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    return { frameCount: frameIndex, frameLog, durationSec: duration, fps: safeFps };
  }

  // ── PATH B: Raw RGBA — open ffmpeg after first frame, stream remainder ────
  const { decoded: firstDecoded } = firstMsg;
  const { width, height } = firstDecoded;

  if (!width || !height) {
    for await (const _ of { [Symbol.asyncIterator]: () => msgIter }) { /* drain */ }
    return { frameCount: 0, frameLog, durationSec: 0, fps: 0 };
  }

  // We don't know FPS until we see all timestamps, so use 30 as initial estimate.
  // We'll remux with the correct pts if needed — for now constant FPS is fine.
  const PIPE_FPS = 30;

  const ffmpegArgs = [
    "-y",
    "-f", "rawvideo", "-vcodec", "rawvideo",
    "-s", `${width}x${height}`,
    "-pix_fmt", "rgba",
    "-r", String(PIPE_FPS),
    "-i", "pipe:0",
    "-vcodec", "libx264",
    "-pix_fmt", "yuv420p",
    "-crf", "18",
    "-preset", "fast",
    outputPath,
  ];

  const ffmpegProc = spawn(ffmpegPath, ffmpegArgs, { stdio: ["pipe", "ignore", "pipe"] });
  const ffmpegErrors = [];
  ffmpegProc.stderr.on("data", (d) => {
    const line = d.toString();
    ffmpegErrors.push(line);
    if (onProgress) onProgress(line.split('\n')[0].trim());
  });

  // Handle backpressure — don't overwhelm the pipe
  const writeFrame = (rgbaBuf) => {
    return new Promise((resolve) => {
      const canContinue = ffmpegProc.stdin.write(rgbaBuf);
      if (canContinue) resolve();
      else ffmpegProc.stdin.once('drain', resolve);
    });
  };

  let frameIndex = 0;
  let firstTs = null, lastTs = null;

  const processFrame = async (msg, decoded) => {
    const ts = msg.timestamp.sec + msg.timestamp.nsec / 1e9;
    if (firstTs === null) firstTs = ts;
    lastTs = ts;
    frameLog.push({ frameIndex, timestampSec: ts });
    await writeFrame(decoded.rgba);
    frameIndex++;
    if (onProgress && frameIndex % 30 === 0) onProgress(`Frame ${frameIndex}`);
  };

  try {
    await processFrame(firstMsg, firstDecoded);

    for await (const msg of { [Symbol.asyncIterator]: () => msgIter }) {
      if (!msg || !msg.data || msg.isRaw) continue;
      const decoded = decodeRosImage(msg.data);
      if (!decoded) continue;
      await processFrame(msg, decoded);
    }
  } catch (err) {
    // If we hit an error mid-stream, close ffmpeg cleanly then rethrow
    ffmpegProc.stdin.destroy();
    throw err;
  }

  const exitCode = await new Promise((resolve, reject) => {
    ffmpegProc.stdin.end(() => {
      ffmpegProc.on("close", resolve);
      ffmpegProc.on("error", reject);
    });
  });

  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited ${exitCode}: ${ffmpegErrors.slice(-3).join(' | ')}`);
  }

  const duration = (lastTs - firstTs) || 1;
  const fps = Math.min(Math.max(Math.round(frameIndex / duration), 1), 60);

  return { frameCount: frameIndex, frameLog, durationSec: duration, fps };
}

/**
 * Run ffmpeg from a directory of JPEG frames
 */
function runFfmpegImages(framesDir, outputPath, fps) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-r", String(fps),
      "-i", path.join(framesDir, "frame_%06d.jpg"),
      "-vcodec", "libx264",
      "-pix_fmt", "yuv420p",
      "-crf", "18",
      outputPath,
    ];

    const proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

module.exports = { exportVideoTopic };