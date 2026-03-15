/**
 * .snapframe — Screenshot capture server
 *
 * Provides SSE-based screenshot capture endpoints with support for:
 * - Single and batch multi-viewport captures
 * - PNG, JPEG, and WebP output formats
 * - Full-page scrolling with lazy-image loading
 * - Cookie consent / overlay auto-removal
 * - Max-width content constraining
 * - Pageless PDF generation
 * - On-the-fly format conversion
 */

const express = require("express");
const { chromium } = require("playwright");
const sharp = require("sharp");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { URL } = require("url");
const dns = require("dns");
const { promisify } = require("util");

const dnsLookup = promisify(dns.lookup);

const app = express();
const PORT = 3000;

// --- Security middleware ---

/** Security headers for all responses */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'");
  next();
});

/** Rate limiting — browser-launching endpoints are expensive */
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

/** Route-specific body limits */
app.use("/api/convert", express.json({ limit: "50mb" }));
app.use("/api/pdf", express.json({ limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

app.use(express.static(path.join(__dirname, "public")));

// --- Constants ---

const ALLOWED_PROTOCOLS = ["http:", "https:"];
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;
const MAX_SCALE = 3;
const MAX_DELAY = 10_000;
const MAX_BATCH_PRESETS = 20;
const PAGE_TIMEOUT = 30_000;
const VALID_FORMATS = ["png", "jpeg", "webp"];
const MAX_CONCURRENT_BROWSERS = 3;

/** Semaphore for limiting concurrent browser instances */
let activeBrowsers = 0;

async function acquireBrowser() {
  if (activeBrowsers >= MAX_CONCURRENT_BROWSERS) {
    throw new Error("Server busy — too many concurrent captures. Try again shortly.");
  }
  activeBrowsers++;
}

function releaseBrowser() {
  activeBrowsers = Math.max(0, activeBrowsers - 1);
}

/**
 * Private/reserved IP ranges to block (SSRF prevention).
 * Covers loopback, RFC 1918, link-local, cloud metadata, and IPv6 equivalents.
 */
const BLOCKED_IP_RANGES = [
  /^127\./,                          // loopback
  /^10\./,                           // RFC 1918
  /^172\.(1[6-9]|2\d|3[01])\./,     // RFC 1918
  /^192\.168\./,                     // RFC 1918
  /^169\.254\./,                     // link-local
  /^0\./,                            // current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // shared address space
  /^::1$/,                           // IPv6 loopback
  /^fe80:/i,                         // IPv6 link-local
  /^fc00:/i,                         // IPv6 unique local
  /^fd/i,                            // IPv6 unique local
];

/**
 * Selectors for common cookie consent "accept" buttons.
 * Tried in order — first visible match gets clicked.
 */
const CONSENT_ACCEPT_SELECTORS = [
  '[id*="accept" i]',
  '[class*="accept" i]',
  '[id*="consent" i] button',
  '[class*="consent" i] button',
  '[id*="cookie" i] button',
  '[class*="cookie" i] button',
  '[aria-label*="accept" i]',
  '[aria-label*="dismiss" i]',
  '[aria-label*="close" i]',
  'button:has-text("Accept")',
  'button:has-text("Accept All")',
  'button:has-text("Accept all")',
  'button:has-text("Got it")',
  'button:has-text("I agree")',
  'button:has-text("OK")',
  'button:has-text("Allow")',
  'button:has-text("Allow all")',
  'button:has-text("Agree")',
];

/**
 * CSS to force-hide known cookie/consent/GDPR overlays.
 * Covers OneTrust, CookieBot, CookieYes, TrustArc, Osano, Klaro,
 * Termly, iubenda, and generic class/id patterns.
 */
const OVERLAY_HIDE_CSS = `
  [id*="cookie" i], [class*="cookie" i],
  [id*="consent" i], [class*="consent" i],
  [id*="gdpr" i], [class*="gdpr" i],
  [id*="onetrust" i], [class*="onetrust" i],
  [id*="CybotCookiebot" i], [class*="CybotCookiebot" i],
  [id*="cc-" i], [class*="cc-banner" i], [class*="cc-window" i],
  [id*="sp_message" i], [class*="sp_message" i],
  [class*="cookie-banner" i], [class*="cookie-notice" i],
  [class*="cookie-popup" i], [class*="cookie-consent" i],
  [class*="privacy-banner" i], [class*="notice-banner" i],
  [aria-label*="cookie" i], [aria-label*="consent" i],
  .fc-consent-root, #usercentrics-root, #klaro,
  .trustarc-banner, .osano-cm-window,
  [class*="cookie-settings" i], [id*="cookie-settings" i],
  [class*="cookie-preferences" i],
  [aria-label*="cookie settings" i],
  [aria-label*="cookie preferences" i],
  [aria-label*="privacy settings" i],
  [class*="cky-btn-revisit" i],
  .cky-revisit-bottom-left, .cky-revisit-bottom-right,
  [id*="cky-consent" i], [class*="cky-consent" i],
  [id*="cookieyes" i], [class*="cookieyes" i],
  [class*="privacy-widget" i], [class*="cookie-widget" i],
  [id*="termly" i], [class*="termly" i],
  [id*="iubenda" i], [class*="iubenda" i] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
  body { overflow: auto !important; position: static !important; }
  html { overflow: auto !important; }
`;

/** CSS to hide tooltips/popovers triggered during scrolling */
const TOOLTIP_HIDE_CSS = `
  [role="tooltip"], [data-tooltip], .tooltip,
  [class*="tooltip" i], [class*="popover" i] {
    display: none !important;
    opacity: 0 !important;
    visibility: hidden !important;
  }
`;

/** Realistic user agent to avoid bot detection */
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/**
 * Launch a stealth Chromium instance.
 * Uses args to disable bot-detection signals like webdriver flag,
 * automation-controlled infobar, and blink automation features.
 */
async function launchBrowser() {
  return chromium.launch({
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--disable-infobars",
    ],
  });
}

/**
 * Create a browser context with stealth settings.
 * Sets a realistic user agent and viewport.
 */
async function createContext(browser, { width, height, scale }) {
  return browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    userAgent: USER_AGENT,
    reducedMotion: "reduce",
  });
}

// --- Utility functions ---

/**
 * Navigate to a URL with graceful fallback.
 * Tries networkidle first (best for most sites), falls back to
 * domcontentloaded + 2s wait for heavy sites that never go idle.
 */
async function navigateTo(page, url) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
  } catch (err) {
    if (err.message.includes("Timeout")) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
      await page.waitForTimeout(2000);
    } else {
      throw err;
    }
  }
}

/** Clamp a number between min and max */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Validate URL — checks protocol, resolves DNS, and blocks private IPs (SSRF prevention).
 * Returns { valid, url } or { valid, error }.
 */
async function validateUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    return { valid: false, error: "Only http and https URLs are allowed" };
  }

  // Resolve hostname and check against blocked IP ranges
  try {
    const { address } = await dnsLookup(url.hostname);
    for (const pattern of BLOCKED_IP_RANGES) {
      if (pattern.test(address)) {
        return { valid: false, error: "URLs pointing to private/internal networks are not allowed" };
      }
    }
  } catch {
    return { valid: false, error: "Could not resolve hostname" };
  }

  return { valid: true, url };
}

/**
 * Resolve the requested format into Playwright-compatible capture format.
 * Playwright only supports png/jpeg — WebP is captured as PNG then converted.
 */
function resolveFormat(format) {
  const wantWebp = format === "webp";
  const captureFormat = wantWebp ? "png" : (format === "jpeg" ? "jpeg" : "png");
  return { wantWebp, captureFormat };
}

/** Map format string to MIME type */
function getMimeType(format) {
  const map = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
  return map[format] || "image/png";
}

/** Convert an image buffer to the target format using Sharp */
async function convertBuffer(buffer, format) {
  if (format === "webp") return sharp(buffer).webp({ quality: 90 }).toBuffer();
  if (format === "jpeg") return sharp(buffer).jpeg({ quality: 90 }).toBuffer();
  return sharp(buffer).png().toBuffer();
}

/** Escape HTML special characters to prevent XSS */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Set up Server-Sent Events headers and return a send function */
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

/** Return a safe, generic error message without leaking internals */
function safeError(prefix, err) {
  const msg = err.message || "";
  if (msg.includes("Timeout")) return `${prefix}: page took too long to load`;
  if (msg.includes("net::ERR_NAME_NOT_RESOLVED")) return `${prefix}: could not resolve hostname`;
  if (msg.includes("net::ERR_CONNECTION_REFUSED")) return `${prefix}: connection refused`;
  if (msg.includes("Server busy")) return msg;
  return `${prefix}: capture failed`;
}

// --- Page manipulation helpers ---

/**
 * Clean a page by dismissing cookie consent dialogs and hiding overlays.
 * Three-phase approach:
 * 1. Try clicking common accept/dismiss buttons
 * 2. Inject CSS to hide known consent frameworks
 * 3. Remove small fixed/sticky elements (floating widgets, chat bubbles)
 */
async function cleanPage(page) {
  for (const selector of CONSENT_ACCEPT_SELECTORS) {
    try {
      const btn = page.locator(selector).first();
      if (await btn.isVisible({ timeout: 200 })) {
        await btn.click({ timeout: 500 });
        await page.waitForTimeout(300);
        break;
      }
    } catch { /* no match, try next */ }
  }

  await page.addStyleTag({ content: OVERLAY_HIDE_CSS });

  await page.evaluate(() => {
    document.querySelectorAll("*").forEach((el) => {
      const s = window.getComputedStyle(el);
      if (
        (s.position === "fixed" || s.position === "sticky") &&
        el.offsetWidth < 120 && el.offsetHeight < 120 &&
        el.tagName !== "HEADER" && el.tagName !== "NAV"
      ) {
        el.style.display = "none";
      }
    });
    document.querySelectorAll("iframe").forEach((iframe) => {
      if (window.getComputedStyle(iframe).position === "fixed") {
        iframe.style.display = "none";
      }
    });
  });

  await page.waitForTimeout(200);
}

/**
 * Scroll the full page to trigger lazy-loaded images, then wait for all
 * <img> elements to finish loading. Disables pointer events during scroll
 * to prevent hover tooltips from appearing in the capture.
 */
async function scrollAndWaitForImages(page, reveal = false) {
  await page.mouse.move(-1, -1);
  await page.addStyleTag({ content: "* { pointer-events: none !important; }" });

  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const step = Math.max(200, Math.floor(window.innerHeight * 0.6));
    let scrolls = 0;
    while (scrolls++ < 200) {
      window.scrollBy(0, step);
      await wait(250);
      if (window.scrollY + window.innerHeight >= document.body.scrollHeight) break;
    }
    await wait(500);
    window.scrollTo(0, 0);
    await wait(500);

    await Promise.allSettled(
      Array.from(document.querySelectorAll("img")).map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
          setTimeout(resolve, 5000);
        });
      })
    );
  });

  await page.addStyleTag({ content: "* { pointer-events: auto !important; }" });
  await page.addStyleTag({ content: TOOLTIP_HIDE_CSS });

  if (!reveal) return;

  await page.addStyleTag({
    content: `*, *::before, *::after { animation: none !important; transition: none !important; }`,
  });
  await page.waitForTimeout(200);

  await page.evaluate(() => {
    const skipTags = new Set(["NAV", "HEADER", "SCRIPT", "STYLE", "LINK", "META", "HEAD"]);
    function isFixedOrNav(el) {
      let node = el;
      while (node && node !== document.body) {
        if (skipTags.has(node.tagName)) return true;
        const pos = window.getComputedStyle(node).position;
        if (pos === "fixed" || pos === "sticky") return true;
        node = node.parentElement;
      }
      return false;
    }

    document.querySelectorAll("*").forEach((el) => {
      if (isFixedOrNav(el)) return;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return;
      const s = window.getComputedStyle(el);

      if (parseFloat(s.opacity) < 0.95) el.style.setProperty("opacity", "1", "important");
      if (s.transform && s.transform !== "none") el.style.setProperty("transform", "none", "important");
      if (s.clipPath && s.clipPath !== "none") el.style.setProperty("clip-path", "none", "important");
      if (s.visibility === "hidden") el.style.setProperty("visibility", "visible", "important");

      if (s.overflow === "hidden" && el.children.length > 0) {
        if (el.scrollHeight > el.offsetHeight + 10) {
          el.style.setProperty("max-height", "none", "important");
          el.style.setProperty("height", "auto", "important");
          el.style.setProperty("overflow", "visible", "important");
        }
      }
    });
  });

  await page.waitForTimeout(300);
}

/**
 * Apply all page preparation steps in sequence:
 * clean overlays -> scroll for lazy images -> reveal animations -> wait delay -> constrain max-width
 */
async function preparePage(page, { clean, fullPage, delay, maxWidth, reveal }) {
  if (clean) await cleanPage(page);
  if (fullPage) await scrollAndWaitForImages(page, reveal);
  if (delay > 0) await page.waitForTimeout(delay);
  if (maxWidth > 0) {
    await page.addStyleTag({
      content: `body { max-width: ${maxWidth}px !important; margin-left: auto !important; margin-right: auto !important; overflow-x: hidden !important; }`,
    });
    await page.waitForTimeout(200);
  }
}

/**
 * Capture a screenshot and optionally convert to WebP.
 * When crop is specified, captures viewport only and crops to exact dimensions.
 */
async function captureScreenshot(page, { fullPage, captureFormat, wantWebp, crop }) {
  const useFullPage = crop ? false : fullPage;

  let buffer = await page.screenshot({
    fullPage: useFullPage,
    type: captureFormat,
    ...(captureFormat === "jpeg" ? { quality: 90 } : {}),
  });

  if (crop && crop.w && crop.h) {
    const targetW = crop.w * (crop.scale || 1);
    const targetH = crop.h * (crop.scale || 1);
    buffer = await sharp(buffer).extract({ left: 0, top: 0, width: targetW, height: targetH }).toBuffer();
  }

  if (wantWebp) {
    buffer = await sharp(buffer).webp({ quality: 90 }).toBuffer();
  }

  const outputFormat = wantWebp ? "webp" : captureFormat;
  return { buffer, outputFormat, mimeType: getMimeType(outputFormat) };
}

// --- API Routes ---

/**
 * GET /api/screenshot — Single screenshot capture via SSE
 * Rate limited to 10 requests/min.
 */
app.get("/api/screenshot", captureLimit, async (req, res) => {
  const q = req.query;
  const send = createSSE(res);

  const validation = await validateUrl(q.url);
  if (!validation.valid) {
    send("error", { error: validation.error });
    return res.end();
  }

  const width = clamp(Number(q.width) || 1280, 320, MAX_WIDTH);
  const height = clamp(Number(q.height) || 720, 200, MAX_HEIGHT);
  const scale = clamp(Number(q.deviceScale) || 1, 1, MAX_SCALE);
  const delay = clamp(Number(q.delay) || 0, 0, MAX_DELAY);
  const maxWidth = Number(q.maxWidth) || 0;
  const fullPage = q.fullPage === "true";
  const clean = q.clean === "true";
  const reveal = q.reveal === "true";
  const isCrop = q.crop === "true";
  const { wantWebp, captureFormat } = resolveFormat(q.format);

  let browser;
  try {
    await acquireBrowser();
    send("progress", { step: "Launching browser", pct: 5 });
    browser = await launchBrowser();

    const context = await createContext(browser, { width, height, scale });

    send("progress", { step: "Loading page", pct: 15 });
    const page = await context.newPage();
    await navigateTo(page, validation.url.href);

    send("progress", { step: "Processing page", pct: 40 });
    await preparePage(page, { clean, fullPage: isCrop ? false : fullPage, delay, maxWidth: isCrop ? 0 : maxWidth, reveal });

    send("progress", { step: isCrop ? "Cropping to size" : "Capturing screenshot", pct: 80 });
    const cropOpts = isCrop ? { w: width, h: height, scale } : null;
    const { buffer, outputFormat, mimeType } = await captureScreenshot(page, { fullPage: isCrop ? false : fullPage, captureFormat, wantWebp, crop: cropOpts });

    send("progress", { step: "Encoding", pct: 90 });
    await browser.close();
    browser = null;

    send("progress", { step: "Done", pct: 100 });
    send("done", {
      image: `data:${mimeType};base64,${buffer.toString("base64")}`,
      meta: { url: validation.url.href, viewport: `${width}x${height}`, scale, fullPage, format: outputFormat, maxWidth: maxWidth || "none", delay, clean },
    });
  } catch (err) {
    send("error", { error: safeError("Screenshot failed", err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseBrowser();
    res.end();
  }
});

/**
 * GET /api/batch — Multi-viewport batch capture via SSE
 * Rate limited to 10 requests/min. Max 20 presets per batch.
 */
app.get("/api/batch", captureLimit, async (req, res) => {
  const q = req.query;
  const send = createSSE(res);

  const validation = await validateUrl(q.url);
  if (!validation.valid) {
    send("error", { error: validation.error });
    return res.end();
  }

  let presets;
  try {
    presets = JSON.parse(q.presets);
  } catch {
    send("error", { error: "Invalid presets" });
    return res.end();
  }

  if (!Array.isArray(presets) || presets.length > MAX_BATCH_PRESETS) {
    send("error", { error: `Maximum ${MAX_BATCH_PRESETS} presets per batch` });
    return res.end();
  }

  const scale = clamp(Number(q.deviceScale) || 1, 1, MAX_SCALE);
  const delay = clamp(Number(q.delay) || 0, 0, MAX_DELAY);
  const maxWidth = Number(q.maxWidth) || 0;
  const fullPage = q.fullPage === "true";
  const clean = q.clean === "true";
  const reveal = q.reveal === "true";
  const { wantWebp, captureFormat } = resolveFormat(q.format);
  const total = presets.length;

  const PARALLEL = Math.min(3, total); // max 3 concurrent captures

  let browser;
  try {
    await acquireBrowser();
    send("progress", { step: `Launching browser (${PARALLEL}x parallel)`, pct: 2, current: 0, total });
    browser = await launchBrowser();

    let completed = 0;
    let active = 0;
    const results = new Array(total);

    function pct() { return Math.round(5 + (completed / total) * 90); }
    function prog(step) { send("progress", { step, pct: pct(), current: completed, total, active }); }

    // Process presets in parallel chunks
    async function capturePreset(i) {
      const preset = presets[i];
      const w = clamp(Number(preset.w) || 1280, 320, MAX_WIDTH);
      const h = clamp(Number(preset.h) || 720, 200, MAX_HEIGHT);
      const name = escapeHtml(preset.name || `${w}x${h}`);
      const isCrop = preset.crop === true;

      active++;
      prog(`${name}: loading`);

      const context = await createContext(browser, { width: w, height: h, scale });
      const page = await context.newPage();
      await navigateTo(page, validation.url.href);

      prog(`${name}: processing`);
      await preparePage(page, { clean, fullPage: isCrop ? false : fullPage, delay, maxWidth: isCrop ? 0 : maxWidth, reveal });

      prog(`${name}: ${isCrop ? "cropping" : "capturing"}`);
      const cropOpts = isCrop ? { w, h, scale } : null;
      const { buffer, outputFormat, mimeType } = await captureScreenshot(page, { fullPage: isCrop ? false : fullPage, captureFormat, wantWebp, crop: cropOpts });

      await context.close();
      completed++;
      active--;

      const result = {
        index: i,
        name,
        image: `data:${mimeType};base64,${buffer.toString("base64")}`,
        meta: { viewport: `${w}x${h}`, scale, format: outputFormat, maxWidth: maxWidth || "none", delay, clean, crop: isCrop },
      };

      results[i] = result;
      send("capture", result);
      prog(`${name}: done`);
    }

    // Run in parallel with concurrency limit
    const queue = [...Array(total).keys()];
    const workers = [];
    for (let w = 0; w < PARALLEL; w++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const idx = queue.shift();
          if (idx !== undefined) await capturePreset(idx);
        }
      })());
    }
    await Promise.all(workers);

    send("progress", { step: "All done", pct: 100, current: total, total });
    send("alldone", { total });
  } catch (err) {
    send("error", { error: safeError("Batch failed", err) });
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseBrowser();
    res.end();
  }
});

/**
 * POST /api/convert — Convert an existing base64 image to another format
 * Rate limited to 30 requests/min. Body limit: 50MB.
 */
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
  } catch (err) {
    res.status(500).json({ error: "Image conversion failed" });
  }
});

/**
 * POST /api/pdf — Generate a pageless PDF of a URL
 * Rate limited to 10 requests/min. Body limit: 1MB.
 */
app.post("/api/pdf", captureLimit, async (req, res) => {
  const { url, width = 1280, height = 720, deviceScale = 1, delay = 0, clean = false } = req.body;

  const validation = await validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const w = clamp(Number(width), 320, MAX_WIDTH);
  const h = clamp(Number(height), 200, MAX_HEIGHT);
  const scale = clamp(Number(deviceScale), 1, MAX_SCALE);
  const d = clamp(Number(delay), 0, MAX_DELAY);

  let browser;
  try {
    await acquireBrowser();
    browser = await launchBrowser();
    // PDF uses scale 1 — Chromium PDF rendering handles its own scaling
    const context = await createContext(browser, { width: w, height: h, scale: 1 });
    const page = await context.newPage();
    await navigateTo(page, validation.url.href);

    await preparePage(page, { clean, fullPage: true, delay: d, maxWidth: 0, reveal: false });

    // Measure actual content dimensions for the pageless PDF
    const dims = await page.evaluate(() => ({
      w: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    }));
    const pdfBuffer = await page.pdf({
      width: `${dims.w}px`,
      height: `${dims.h + 1}px`,
      printBackground: true,
      margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    });

    await browser.close();
    browser = null;

    res.json({
      pdf: `data:application/pdf;base64,${pdfBuffer.toString("base64")}`,
      meta: { url: validation.url.href, viewport: `${w}x${h}`, scale },
    });
  } catch (err) {
    res.status(500).json({ error: "PDF generation failed" });
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseBrowser();
  }
});

app.listen(PORT, () => {
  console.log(`.snapframe running at http://localhost:${PORT}`);
});
