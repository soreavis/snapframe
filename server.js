/**
 * .snapframe — HTTP + SSE frontend.
 *
 * Thin wrapper around lib/capture.js. This file should contain only Express
 * plumbing (routes, rate limits, headers, SSE framing). Any change to capture
 * behavior belongs in lib/capture.js so the CLI picks it up too.
 */

const express = require("express");
const path = require("path");
const rateLimit = require("express-rate-limit");
const readline = require("readline");

const {
  captureOne,
  captureBatch,
  capturePdf,
  convertBuffer,
  getMimeType,
  safeError,
  VALID_FORMATS,
  MAX_BATCH_PRESETS,
} = require("./lib/capture");

const app = express();
const DEFAULT_PORT = 3005;

// --- Security middleware ---

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");
  next();
});

const captureLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: { error: "Too many capture requests. Try again in a minute." },
});

const convertLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: { error: "Too many conversion requests. Try again in a minute." },
});

app.use("/api/convert", express.json({ limit: "50mb" }));
app.use("/api/pdf", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

app.use(express.static(path.join(__dirname, "public")));

// --- SSE helpers ---

function createSSE(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/** Convert a capture result's buffer to the data URL the frontend expects */
function toDataUrl({ buffer, mimeType }) {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

// --- API Routes ---

app.get("/api/screenshot", captureLimit, async (req, res) => {
  const q = req.query;
  const send = createSSE(res);

  try {
    const result = await captureOne(
      {
        url: q.url,
        width: q.width,
        height: q.height,
        scale: q.deviceScale,
        delay: q.delay,
        maxWidth: q.maxWidth,
        fullPage: q.fullPage,
        clean: q.clean,
        strip: q.strip,
        reveal: q.reveal,
        crop: q.crop,
        format: q.format,
      },
      (progress) => send("progress", progress),
    );

    send("done", {
      image: toDataUrl(result),
      meta: result.meta,
    });
  } catch (err) {
    if (err.code === "INVALID_URL") {
      send("error", { error: err.message });
    } else {
      send("error", { error: safeError("Screenshot failed", err) });
    }
  } finally {
    res.end();
  }
});

app.get("/api/batch", captureLimit, async (req, res) => {
  const q = req.query;
  const send = createSSE(res);

  let presets;
  try {
    presets = JSON.parse(q.presets);
  } catch {
    send("error", { error: "Invalid presets" });
    return res.end();
  }

  if (!Array.isArray(presets)) {
    send("error", { error: "Invalid presets" });
    return res.end();
  }
  if (presets.length > MAX_BATCH_PRESETS) {
    send("error", { error: `Maximum ${MAX_BATCH_PRESETS} presets per batch` });
    return res.end();
  }

  try {
    const { total } = await captureBatch(
      {
        url: q.url,
        presets,
        scale: q.deviceScale,
        delay: q.delay,
        maxWidth: q.maxWidth,
        fullPage: q.fullPage,
        clean: q.clean,
        strip: q.strip,
        reveal: q.reveal,
        format: q.format,
      },
      {
        onProgress: (progress) => send("progress", progress),
        onCapture: (result) => {
          send("capture", {
            index: result.index,
            name: result.name,
            image: toDataUrl(result),
            meta: result.meta,
          });
        },
      },
    );

    send("alldone", { total });
  } catch (err) {
    if (err.code === "INVALID_URL" || err.code === "INVALID_PRESETS" || err.code === "TOO_MANY_PRESETS") {
      send("error", { error: err.message });
    } else {
      send("error", { error: safeError("Batch failed", err) });
    }
  } finally {
    res.end();
  }
});

app.post("/api/convert", convertLimit, async (req, res) => {
  const { image, format } = req.body;

  if (!image || !format || !VALID_FORMATS.includes(format)) {
    return res.status(400).json({ error: "Missing or invalid image/format" });
  }

  try {
    const parts = image.split(",");
    if (parts.length !== 2) return res.status(400).json({ error: "Invalid image data" });

    const inputBuffer = Buffer.from(parts[1], "base64");
    const outputBuffer = await convertBuffer(inputBuffer, format);

    res.json({
      image: `data:${getMimeType(format)};base64,${outputBuffer.toString("base64")}`,
      format,
    });
  } catch {
    res.status(500).json({ error: "Image conversion failed" });
  }
});

app.post("/api/pdf", captureLimit, async (req, res) => {
  const { url, width, height, deviceScale, delay, clean, strip } = req.body;

  try {
    const result = await capturePdf({
      url,
      width,
      height,
      scale: deviceScale,
      delay,
      clean,
      strip,
    });

    res.json({
      pdf: `data:application/pdf;base64,${result.buffer.toString("base64")}`,
      meta: result.meta,
    });
  } catch (err) {
    if (err.code === "INVALID_URL") {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "PDF generation failed" });
  }
});

// --- Startup ---

function askPort() {
  return new Promise((resolve) => {
    // Non-interactive stdin (CI, piped input) — skip the prompt
    if (!process.stdin.isTTY) return resolve(DEFAULT_PORT);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`Port (default ${DEFAULT_PORT}): `, (answer) => {
      rl.close();
      const port = parseInt(answer, 10);
      resolve(port > 0 && port <= 65535 ? port : DEFAULT_PORT);
    });
  });
}

async function start() {
  const port = await askPort();
  app.listen(port, () => {
    console.log(`.snapframe running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start };
