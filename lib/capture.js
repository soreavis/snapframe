/**
 * .snapframe capture library
 *
 * Transport-agnostic core: exposes captureOne / captureBatch / capturePdf.
 * Both the HTTP server and the CLI build on top of this — no Express, no argv,
 * no SSE here. Progress is delivered via an optional onProgress callback so
 * each frontend can map it to its own channel (SSE events, stderr, etc.).
 */

const { chromium } = require("playwright");
const sharp = require("sharp");
const { URL } = require("url");
const dns = require("dns");
const { promisify } = require("util");

const dnsLookup = promisify(dns.lookup);

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

const TOOLTIP_HIDE_CSS = `
  [role="tooltip"], [data-tooltip], .tooltip,
  [class*="tooltip" i], [class*="popover" i] {
    display: none !important;
    opacity: 0 !important;
    visibility: hidden !important;
  }
`;

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// --- Concurrency gate ---

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

// --- Browser lifecycle ---

async function launchBrowser() {
  return chromium.launch({
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--disable-infobars",
    ],
  });
}

async function createContext(browser, { width, height, scale }) {
  return browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    userAgent: USER_AGENT,
    reducedMotion: "reduce",
  });
}

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

// --- Utilities ---

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

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

function resolveFormat(format) {
  const wantWebp = format === "webp";
  const captureFormat = wantWebp ? "png" : (format === "jpeg" ? "jpeg" : "png");
  return { wantWebp, captureFormat };
}

function getMimeType(format) {
  const map = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
  return map[format] || "image/png";
}

async function convertBuffer(buffer, format) {
  if (format === "webp") return sharp(buffer).webp({ quality: 90 }).toBuffer();
  if (format === "jpeg") return sharp(buffer).jpeg({ quality: 90 }).toBuffer();
  return sharp(buffer).png().toBuffer();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeError(prefix, err) {
  const msg = err.message || "";
  if (msg.includes("Timeout")) return `${prefix}: page took too long to load`;
  if (msg.includes("net::ERR_NAME_NOT_RESOLVED")) return `${prefix}: could not resolve hostname`;
  if (msg.includes("net::ERR_CONNECTION_REFUSED")) return `${prefix}: connection refused`;
  if (msg.includes("Server busy")) return msg;
  return `${prefix}: capture failed`;
}

// --- Page manipulation ---

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

// --- Option normalization ---

/**
 * Normalize and clamp capture options to safe values.
 * Shared by every high-level entrypoint so a bad input fails the same way
 * regardless of whether it came from HTTP or argv.
 */
function normalizeOptions(opts = {}) {
  return {
    width: clamp(Number(opts.width) || 1280, 320, MAX_WIDTH),
    height: clamp(Number(opts.height) || 720, 200, MAX_HEIGHT),
    scale: clamp(Number(opts.scale) || 1, 1, MAX_SCALE),
    delay: clamp(Number(opts.delay) || 0, 0, MAX_DELAY),
    maxWidth: Number(opts.maxWidth) || 0,
    fullPage: opts.fullPage === true || opts.fullPage === "true",
    clean: opts.clean === true || opts.clean === "true",
    reveal: opts.reveal === true || opts.reveal === "true",
    crop: opts.crop === true || opts.crop === "true",
    format: VALID_FORMATS.includes(opts.format) ? opts.format : "png",
  };
}

function noop() {}

// --- High-level API ---

/**
 * Capture a single screenshot.
 * @param {object} opts - url, width, height, scale, delay, maxWidth, fullPage, clean, reveal, crop, format
 * @param {function} [onProgress] - called with ({ step, pct })
 * @returns {Promise<{ buffer: Buffer, outputFormat: string, mimeType: string, meta: object }>}
 */
async function captureOne(opts, onProgress = noop) {
  const validation = await validateUrl(opts.url);
  if (!validation.valid) {
    const err = new Error(validation.error);
    err.code = "INVALID_URL";
    throw err;
  }

  const n = normalizeOptions(opts);
  const { wantWebp, captureFormat } = resolveFormat(n.format);

  let browser;
  try {
    await acquireBrowser();
    onProgress({ step: "Launching browser", pct: 5 });
    browser = await launchBrowser();

    const context = await createContext(browser, { width: n.width, height: n.height, scale: n.scale });

    onProgress({ step: "Loading page", pct: 15 });
    const page = await context.newPage();
    await navigateTo(page, validation.url.href);

    onProgress({ step: "Processing page", pct: 40 });
    await preparePage(page, {
      clean: n.clean,
      fullPage: n.crop ? false : n.fullPage,
      delay: n.delay,
      maxWidth: n.crop ? 0 : n.maxWidth,
      reveal: n.reveal,
    });

    onProgress({ step: n.crop ? "Cropping to size" : "Capturing screenshot", pct: 80 });
    const cropOpts = n.crop ? { w: n.width, h: n.height, scale: n.scale } : null;
    const result = await captureScreenshot(page, {
      fullPage: n.crop ? false : n.fullPage,
      captureFormat,
      wantWebp,
      crop: cropOpts,
    });

    onProgress({ step: "Done", pct: 100 });

    return {
      ...result,
      meta: {
        url: validation.url.href,
        viewport: `${n.width}x${n.height}`,
        scale: n.scale,
        fullPage: n.fullPage,
        format: result.outputFormat,
        maxWidth: n.maxWidth || "none",
        delay: n.delay,
        clean: n.clean,
      },
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseBrowser();
  }
}

/**
 * Capture multiple viewports of a single URL in parallel.
 * @param {object} opts - url, presets (array of { w, h, name, crop }), scale, delay, maxWidth, fullPage, clean, reveal, format, parallel
 * @param {object} [hooks] - { onProgress, onCapture }
 * @returns {Promise<{ results: Array, total: number }>}
 */
async function captureBatch(opts, { onProgress = noop, onCapture = noop } = {}) {
  const validation = await validateUrl(opts.url);
  if (!validation.valid) {
    const err = new Error(validation.error);
    err.code = "INVALID_URL";
    throw err;
  }

  const presets = Array.isArray(opts.presets) ? opts.presets : null;
  if (!presets || presets.length === 0) {
    const err = new Error("At least one preset is required");
    err.code = "INVALID_PRESETS";
    throw err;
  }
  if (presets.length > MAX_BATCH_PRESETS) {
    const err = new Error(`Maximum ${MAX_BATCH_PRESETS} presets per batch`);
    err.code = "TOO_MANY_PRESETS";
    throw err;
  }

  const n = normalizeOptions(opts);
  const { wantWebp, captureFormat } = resolveFormat(n.format);
  const total = presets.length;
  const PARALLEL = Math.min(opts.parallel || 3, total);

  let browser;
  try {
    await acquireBrowser();
    onProgress({ step: `Launching browser (${PARALLEL}x parallel)`, pct: 2, current: 0, total, active: 0 });
    browser = await launchBrowser();

    let completed = 0;
    let active = 0;
    const results = new Array(total);

    const pct = () => Math.round(5 + (completed / total) * 90);
    const prog = (step) => onProgress({ step, pct: pct(), current: completed, total, active });

    async function capturePreset(i) {
      const preset = presets[i];
      const w = clamp(Number(preset.w) || 1280, 320, MAX_WIDTH);
      const h = clamp(Number(preset.h) || 720, 200, MAX_HEIGHT);
      const name = escapeHtml(preset.name || `${w}x${h}`);
      const isCrop = preset.crop === true;

      active++;
      prog(`${name}: loading`);

      const context = await createContext(browser, { width: w, height: h, scale: n.scale });
      const page = await context.newPage();
      await navigateTo(page, validation.url.href);

      prog(`${name}: processing`);
      await preparePage(page, {
        clean: n.clean,
        fullPage: isCrop ? false : n.fullPage,
        delay: n.delay,
        maxWidth: isCrop ? 0 : n.maxWidth,
        reveal: n.reveal,
      });

      prog(`${name}: ${isCrop ? "cropping" : "capturing"}`);
      const cropOpts = isCrop ? { w, h, scale: n.scale } : null;
      const cap = await captureScreenshot(page, {
        fullPage: isCrop ? false : n.fullPage,
        captureFormat,
        wantWebp,
        crop: cropOpts,
      });

      await context.close();
      completed++;
      active--;

      const result = {
        index: i,
        name,
        buffer: cap.buffer,
        outputFormat: cap.outputFormat,
        mimeType: cap.mimeType,
        meta: {
          viewport: `${w}x${h}`,
          scale: n.scale,
          format: cap.outputFormat,
          maxWidth: n.maxWidth || "none",
          delay: n.delay,
          clean: n.clean,
          crop: isCrop,
        },
      };

      results[i] = result;
      onCapture(result);
      prog(`${name}: done`);
    }

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

    onProgress({ step: "All done", pct: 100, current: total, total, active: 0 });
    return { results, total };
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseBrowser();
  }
}

/**
 * Generate a single-page (pageless) PDF of a URL.
 * @returns {Promise<{ buffer: Buffer, meta: object }>}
 */
async function capturePdf(opts, onProgress = noop) {
  const validation = await validateUrl(opts.url);
  if (!validation.valid) {
    const err = new Error(validation.error);
    err.code = "INVALID_URL";
    throw err;
  }

  const n = normalizeOptions({ ...opts, format: "png" });

  let browser;
  try {
    await acquireBrowser();
    onProgress({ step: "Launching browser", pct: 5 });
    browser = await launchBrowser();

    // PDF uses scale 1 — Chromium PDF rendering handles its own scaling
    const context = await createContext(browser, { width: n.width, height: n.height, scale: 1 });
    const page = await context.newPage();

    onProgress({ step: "Loading page", pct: 20 });
    await navigateTo(page, validation.url.href);

    onProgress({ step: "Processing page", pct: 50 });
    await preparePage(page, { clean: n.clean, fullPage: true, delay: n.delay, maxWidth: 0, reveal: false });

    onProgress({ step: "Generating PDF", pct: 85 });
    const dims = await page.evaluate(() => ({
      w: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    }));
    const buffer = await page.pdf({
      width: `${dims.w}px`,
      height: `${dims.h + 1}px`,
      printBackground: true,
      margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    });

    onProgress({ step: "Done", pct: 100 });

    return {
      buffer,
      meta: {
        url: validation.url.href,
        viewport: `${n.width}x${n.height}`,
        scale: n.scale,
      },
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    releaseBrowser();
  }
}

module.exports = {
  // High-level
  captureOne,
  captureBatch,
  capturePdf,
  convertBuffer,

  // Helpers re-exported for frontend plumbing
  validateUrl,
  resolveFormat,
  getMimeType,
  safeError,
  escapeHtml,
  clamp,
  normalizeOptions,

  // Constants
  VALID_FORMATS,
  MAX_WIDTH,
  MAX_HEIGHT,
  MAX_SCALE,
  MAX_DELAY,
  MAX_BATCH_PRESETS,
  PAGE_TIMEOUT,
  MAX_CONCURRENT_BROWSERS,
};
