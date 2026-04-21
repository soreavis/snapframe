#!/usr/bin/env node
/**
 * .snapframe CLI — headless screenshot capture.
 *
 * Thin wrapper around lib/capture.js. All capture behavior lives in the
 * library; this file only parses argv, maps progress to stderr, and writes
 * output bytes to disk or stdout.
 *
 * Modes:
 *   snapframe <url>                        single capture
 *   snapframe <url> --batch desktop,mobile multi-viewport batch
 *   snapframe <url> --pdf                  PDF export
 *   snapframe serve                        start the HTTP server
 *
 * Stay in this file: argv parsing, exit codes, file I/O, preset lookup.
 * Do NOT put Playwright/Sharp logic here — it belongs in lib/capture.js.
 */

const fs = require("fs");
const path = require("path");
const {
  captureOne,
  captureBatch,
  capturePdf,
  VALID_FORMATS,
} = require("../lib/capture");

// --- Built-in presets ---
// Mirrors the social presets exposed in the UI. Keep names stable —
// users will script against them.

const PRESETS = {
  // Devices
  "retina":        { w: 2560, h: 1440 },
  "desktop":       { w: 1920, h: 1080 },
  "laptop":        { w: 1440, h: 900 },
  "tablet":        { w: 1024, h: 768 },
  "tablet-portrait": { w: 768, h: 1024 },
  "mobile":        { w: 390, h: 844 },
  "mobile-small":  { w: 360, h: 640 },

  // Social (crop-to-exact)
  "yt-banner":     { w: 2560, h: 1440, crop: true },
  "yt-thumb":      { w: 1280, h: 720,  crop: true },
  "linkedin-post": { w: 1200, h: 627,  crop: true },
  "linkedin-cover":{ w: 1584, h: 396,  crop: true },
  "x-post":        { w: 1600, h: 900,  crop: true },
  "x-header":      { w: 1500, h: 500,  crop: true },
  "fb-cover":      { w: 820,  h: 312,  crop: true },
  "fb-post":       { w: 1200, h: 630,  crop: true },
  "ig-post":       { w: 1080, h: 1080, crop: true },
  "ig-story":      { w: 1080, h: 1920, crop: true },
};

const USAGE = `
.snapframe — Headless screenshot CLI

USAGE
  snapframe <url> [options]
  snapframe <url> --batch <preset,preset,...>
  snapframe <url> --pdf [--output file.pdf]
  snapframe serve [--port 3005]
  snapframe presets
  snapframe --help

OPTIONS
  -o, --output <file>     Write to file (default: stdout for single, ./snapframe-<name>.<ext> for batch)
  -w, --width <px>        Viewport width (default: 1280)
  -h, --height <px>       Viewport height (default: 720)
  -s, --scale <n>         Device scale factor 1-3 (default: 1)
  -f, --format <fmt>      png | jpeg | webp (default: png)
  -p, --preset <name>     Use a built-in preset (see \`snapframe presets\`)
      --full-page         Capture the full scrollable page
      --clean             Auto-dismiss cookie banners / hide overlays
      --strip             Aggressive hide: page header/nav, a11y widgets, chat bubbles, floating CTAs
      --reveal            Force-show scroll-triggered hidden elements
      --crop              Crop to exact viewport (for social presets)
      --max-width <px>    Constrain body max-width during capture
      --delay <ms>        Wait before capture (0-10000, default: 0)
      --batch <list>      Comma-separated preset names for batch capture
      --pdf               Output pageless PDF instead of image
      --quiet             Suppress progress output
      --json              Output JSON metadata to stdout (single mode)
      --help              Show this help

EXAMPLES
  snapframe https://example.com -o shot.png
  snapframe https://example.com -p yt-thumb -o thumb.jpg -f jpeg
  snapframe https://example.com --batch desktop,mobile,yt-thumb --output-dir ./shots
  snapframe https://example.com --pdf -o page.pdf
  snapframe https://example.com --full-page --clean -o longshot.png

EXIT CODES
  0  success
  1  invalid arguments / usage error
  2  URL validation failed (bad URL, blocked network)
  3  capture failed (browser / network error)
`.trim();

// --- Arg parsing ---
// Intentionally no external arg-parser dependency — keeps the install footprint
// small and avoids another library to maintain. If the flag set grows past
// ~20 options, swap in commander.

function parseArgs(argv) {
  const args = {
    _: [],
    output: null,
    outputDir: null,
    width: null,
    height: null,
    scale: null,
    format: "png",
    preset: null,
    fullPage: false,
    clean: false,
    strip: false,
    reveal: false,
    crop: false,
    maxWidth: 0,
    delay: 0,
    batch: null,
    pdf: false,
    quiet: false,
    json: false,
    help: false,
    port: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];

    switch (a) {
      case "-o": case "--output":       args.output = next(); break;
      case "--output-dir":              args.outputDir = next(); break;
      case "-w": case "--width":        args.width = Number(next()); break;
      case "-h": case "--height":       args.height = Number(next()); break;
      case "-s": case "--scale":        args.scale = Number(next()); break;
      case "-f": case "--format":       args.format = next(); break;
      case "-p": case "--preset":       args.preset = next(); break;
      case "--full-page": case "--fullpage": args.fullPage = true; break;
      case "--clean":                   args.clean = true; break;
      case "--strip":                   args.strip = true; break;
      case "--reveal":                  args.reveal = true; break;
      case "--crop":                    args.crop = true; break;
      case "--max-width":               args.maxWidth = Number(next()); break;
      case "--delay":                   args.delay = Number(next()); break;
      case "--batch":                   args.batch = next(); break;
      case "--pdf":                     args.pdf = true; break;
      case "--quiet": case "-q":        args.quiet = true; break;
      case "--json":                    args.json = true; break;
      case "--port":                    args.port = Number(next()); break;
      case "--help": case "-?":         args.help = true; break;
      default:
        if (a.startsWith("-")) {
          fail(`Unknown flag: ${a}`);
        }
        args._.push(a);
    }
  }

  return args;
}

function fail(msg, code = 1) {
  process.stderr.write(`snapframe: ${msg}\n`);
  process.exit(code);
}

function log(msg, args) {
  if (!args.quiet) process.stderr.write(msg + "\n");
}

function resolvePreset(name) {
  const key = name.toLowerCase();
  const preset = PRESETS[key];
  if (!preset) fail(`Unknown preset: ${name}. Run \`snapframe presets\` to list.`);
  return preset;
}

function defaultExt(format) {
  return format === "jpeg" ? "jpg" : format;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// --- Commands ---

async function cmdPresets() {
  const rows = Object.entries(PRESETS).map(([name, p]) => {
    const size = `${p.w}x${p.h}`;
    const crop = p.crop ? " (crop)" : "";
    return `  ${name.padEnd(18)} ${size.padEnd(12)}${crop}`;
  });
  process.stdout.write("Available presets:\n" + rows.join("\n") + "\n");
}

async function cmdServe(args) {
  if (args.port) process.env.PORT = String(args.port);
  // Delegate to server.js — it decides the port interactively or via env.
  require("../server").start();
}

async function cmdSingle(url, args) {
  if (!VALID_FORMATS.includes(args.format)) {
    fail(`Invalid format: ${args.format}. Must be one of ${VALID_FORMATS.join(", ")}.`);
  }

  let width = args.width;
  let height = args.height;
  let crop = args.crop;
  if (args.preset) {
    const p = resolvePreset(args.preset);
    width = width || p.w;
    height = height || p.h;
    if (p.crop) crop = true;
  }

  const opts = {
    url,
    width: width || 1280,
    height: height || 720,
    scale: args.scale || 1,
    delay: args.delay,
    maxWidth: args.maxWidth,
    fullPage: args.fullPage,
    clean: args.clean,
    strip: args.strip,
    reveal: args.reveal,
    crop,
    format: args.format,
  };

  let lastPct = -1;
  const onProgress = ({ step, pct }) => {
    if (pct !== lastPct) {
      log(`[${String(pct).padStart(3)}%] ${step}`, args);
      lastPct = pct;
    }
  };

  try {
    const result = await captureOne(opts, onProgress);

    if (args.output) {
      fs.writeFileSync(args.output, result.buffer);
      log(`Saved: ${args.output} (${result.buffer.length} bytes, ${result.outputFormat})`, args);
      if (args.json) {
        process.stdout.write(JSON.stringify({ file: args.output, bytes: result.buffer.length, ...result.meta }, null, 2) + "\n");
      }
    } else if (process.stdout.isTTY) {
      fail("Refusing to write binary image to a TTY. Use --output <file> or redirect stdout.");
    } else {
      process.stdout.write(result.buffer);
      if (args.json) {
        process.stderr.write(JSON.stringify(result.meta) + "\n");
      }
    }
  } catch (err) {
    if (err.code === "INVALID_URL") fail(err.message, 2);
    fail(err.message || "capture failed", 3);
  }
}

async function cmdBatch(url, args) {
  const names = args.batch.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 0) fail("No presets given to --batch");

  const presets = names.map((name) => {
    const p = resolvePreset(name);
    return { name, w: p.w, h: p.h, crop: p.crop === true };
  });

  const outputDir = args.outputDir || ".";
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const ext = defaultExt(args.format);
  let host = "capture";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}

  const written = [];

  try {
    await captureBatch(
      {
        url,
        presets,
        scale: args.scale || 1,
        delay: args.delay,
        maxWidth: args.maxWidth,
        fullPage: args.fullPage,
        clean: args.clean,
        strip: args.strip,
        reveal: args.reveal,
        format: args.format,
      },
      {
        onProgress: ({ step, pct, current, total }) => {
          log(`[${String(pct).padStart(3)}%] (${current}/${total}) ${step}`, args);
        },
        onCapture: (result) => {
          const file = path.join(outputDir, `${slugify(host)}-${slugify(result.name)}.${ext}`);
          fs.writeFileSync(file, result.buffer);
          written.push(file);
          log(`  → ${file}`, args);
        },
      },
    );

    if (args.json) {
      process.stdout.write(JSON.stringify({ files: written }, null, 2) + "\n");
    } else if (args.quiet) {
      written.forEach((f) => process.stdout.write(f + "\n"));
    }
  } catch (err) {
    if (err.code === "INVALID_URL" || err.code === "INVALID_PRESETS" || err.code === "TOO_MANY_PRESETS") {
      fail(err.message, 2);
    }
    fail(err.message || "batch failed", 3);
  }
}

async function cmdPdf(url, args) {
  const output = args.output || "snapframe.pdf";

  try {
    const result = await capturePdf(
      {
        url,
        width: args.width || 1280,
        height: args.height || 720,
        scale: args.scale || 1,
        delay: args.delay,
        clean: args.clean,
        strip: args.strip,
      },
      ({ step, pct }) => log(`[${String(pct).padStart(3)}%] ${step}`, args),
    );

    fs.writeFileSync(output, result.buffer);
    log(`Saved: ${output} (${result.buffer.length} bytes)`, args);
    if (args.json) {
      process.stdout.write(JSON.stringify({ file: output, bytes: result.buffer.length, ...result.meta }, null, 2) + "\n");
    }
  } catch (err) {
    if (err.code === "INVALID_URL") fail(err.message, 2);
    fail(err.message || "PDF failed", 3);
  }
}

// --- Main ---

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args._.length === 0) {
    process.stdout.write(USAGE + "\n");
    process.exit(args.help ? 0 : 1);
  }

  const [cmd, ...rest] = args._;

  if (cmd === "presets") return cmdPresets();
  if (cmd === "serve")   return cmdServe(args);

  // Otherwise first positional is a URL
  const url = cmd;
  if (!/^https?:\/\//i.test(url)) {
    fail(`URL must start with http:// or https://: ${url}`, 2);
  }
  if (rest.length > 0) {
    fail(`Unexpected positional arguments: ${rest.join(" ")}`);
  }

  if (args.pdf)   return cmdPdf(url, args);
  if (args.batch) return cmdBatch(url, args);
  return cmdSingle(url, args);
}

main().catch((err) => {
  process.stderr.write(`snapframe: unhandled error: ${err.stack || err.message}\n`);
  process.exit(3);
});
