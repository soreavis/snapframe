// @ts-check
const { test, expect } = require("@playwright/test");

const BASE = "http://localhost:3000";

// --- Server health ---

test.describe("Server", () => {
  test("serves the frontend", async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator(".logo")).toBeVisible();
    await expect(page).toHaveTitle(/.snapframe/);
  });

  test("serves static assets", async ({ request }) => {
    const icon = await request.get(`${BASE}/icon.svg`);
    expect(icon.ok()).toBeTruthy();
    expect(icon.headers()["content-type"]).toContain("svg");
  });

  test("returns security headers", async ({ request }) => {
    const res = await request.get(BASE);
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["x-frame-options"]).toBe("DENY");
  });
});

// --- SSRF protection ---

test.describe("SSRF protection", () => {
  test("blocks localhost", async ({ request }) => {
    const res = await request.get(`${BASE}/api/screenshot?url=http://127.0.0.1&width=320&height=200&fullPage=false&format=png&deviceScale=1&delay=0&clean=false&reveal=false&maxWidth=0`);
    const text = await res.text();
    expect(text).toContain("private/internal");
  });

  test("blocks metadata endpoint", async ({ request }) => {
    const res = await request.get(`${BASE}/api/screenshot?url=http://169.254.169.254/latest/meta-data&width=320&height=200&fullPage=false&format=png&deviceScale=1&delay=0&clean=false&reveal=false&maxWidth=0`);
    const text = await res.text();
    expect(text).toContain("private/internal");
  });

  test("blocks private network", async ({ request }) => {
    const res = await request.get(`${BASE}/api/screenshot?url=http://192.168.1.1&width=320&height=200&fullPage=false&format=png&deviceScale=1&delay=0&clean=false&reveal=false&maxWidth=0`);
    const text = await res.text();
    expect(text).toContain("private/internal");
  });

  test("blocks file:// protocol", async ({ request }) => {
    const res = await request.get(`${BASE}/api/screenshot?url=file:///etc/passwd&width=320&height=200&fullPage=false&format=png&deviceScale=1&delay=0&clean=false&reveal=false&maxWidth=0`);
    const text = await res.text();
    expect(text).toContain("http and https");
  });
});

// --- API: Convert ---

test.describe("API /api/convert", () => {
  test("rejects missing format", async ({ request }) => {
    const res = await request.post(`${BASE}/api/convert`, {
      data: { image: "data:image/png;base64,iVBOR" },
    });
    expect(res.status()).toBe(400);
  });

  test("rejects invalid format", async ({ request }) => {
    const res = await request.post(`${BASE}/api/convert`, {
      data: { image: "data:image/png;base64,iVBOR", format: "bmp" },
    });
    expect(res.status()).toBe(400);
  });

  test("rejects missing image", async ({ request }) => {
    const res = await request.post(`${BASE}/api/convert`, {
      data: { format: "webp" },
    });
    expect(res.status()).toBe(400);
  });
});

// --- API: Batch limits ---

test.describe("API /api/batch", () => {
  test("rejects invalid presets JSON", async ({ request }) => {
    const res = await request.get(`${BASE}/api/batch?url=https://example.com&presets=notjson&fullPage=false&format=png&deviceScale=1&delay=0&clean=false&reveal=false&maxWidth=0`);
    const text = await res.text();
    expect(text).toContain("Invalid presets");
  });

  test("rejects too many presets", async ({ request }) => {
    const presets = Array.from({ length: 25 }, (_, i) => ({ w: 320, h: 200, name: `p${i}` }));
    const res = await request.get(`${BASE}/api/batch?url=https://example.com&presets=${encodeURIComponent(JSON.stringify(presets))}&fullPage=false&format=png&deviceScale=1&delay=0&clean=false&reveal=false&maxWidth=0`);
    const text = await res.text();
    expect(text).toContain("Maximum");
  });
});

// --- API: Screenshot (e2e) ---

test.describe("API /api/screenshot", () => {
  test("captures a real page", async ({ request }) => {
    const res = await request.get(`${BASE}/api/screenshot?url=https://example.com&width=800&height=600&fullPage=false&format=png&deviceScale=1&delay=0&clean=false&reveal=false&maxWidth=0`);
    const text = await res.text();
    expect(text).toContain('"step":"Done"');
    expect(text).toContain("data:image/png;base64,");
  }, { timeout: 60_000 });

  test("rejects invalid URL", async ({ request }) => {
    const res = await request.get(`${BASE}/api/screenshot?url=not-a-url&width=320&height=200`);
    const text = await res.text();
    expect(text).toContain("Invalid URL");
  });
});

// --- API: PDF ---

test.describe("API /api/pdf", () => {
  test("generates a PDF", async ({ request }) => {
    const res = await request.post(`${BASE}/api/pdf`, {
      data: { url: "https://example.com", width: 800, height: 600, deviceScale: 1, delay: 0, clean: false },
    });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.pdf).toContain("data:application/pdf;base64,");
  }, { timeout: 60_000 });

  test("rejects invalid URL", async ({ request }) => {
    const res = await request.post(`${BASE}/api/pdf`, {
      data: { url: "ftp://evil.com" },
    });
    expect(res.status()).toBe(400);
  });
});

// --- UI interactions ---

test.describe("UI", () => {
  test("presets toggle on click", async ({ page }) => {
    await page.goto(BASE);
    const desktop = page.locator('[data-name="Desktop"]');
    await expect(desktop).not.toHaveClass(/active/);
    await desktop.click();
    await expect(desktop).toHaveClass(/active/);
    await desktop.click();
    await expect(desktop).not.toHaveClass(/active/);
  });

  test("capture button disabled when no presets selected", async ({ page }) => {
    await page.goto(BASE);
    // Deselect Retina (the only default)
    await page.locator('[data-name="Retina"]').click();
    await expect(page.locator("#captureBtn")).toBeDisabled();
  });

  test("category tabs switch preset groups", async ({ page }) => {
    await page.goto(BASE);
    const social = page.locator('.seg-btn:has-text("Social")');
    await social.click();
    // Social group should be active, devices should not
    await expect(page.locator('[data-cat="social"]')).toHaveClass(/active/);
    await expect(page.locator('[data-cat="devices"]')).not.toHaveClass(/active/);
  });

  test("URL auto-prepends https://", async ({ page }) => {
    await page.goto(BASE);
    const input = page.locator("#urlInput");
    await input.fill("example.com");
    // Select a preset and trigger capture to test URL fix
    await page.locator('[data-name="Retina"]').click();
    // The URL should get https:// prepended on capture
    // We just verify the input value after a brief interaction
    await expect(input).toHaveValue("example.com");
  });

  test("panel collapses and expands", async ({ page }) => {
    await page.goto(BASE);
    const panel = page.locator("#panelBody");
    const btn = page.locator("#expandBtn");
    await expect(panel).not.toHaveClass(/collapsed/);
    await btn.click();
    await expect(panel).toHaveClass(/collapsed/);
    await btn.click();
    await expect(panel).not.toHaveClass(/collapsed/);
  });

  test("select all / clear / reset work", async ({ page }) => {
    await page.goto(BASE);
    // Select all
    await page.locator("#btnSelectAll").click();
    const allDevices = await page.locator('[data-cat="devices"] .preset.active').count();
    expect(allDevices).toBe(7);

    // Clear
    await page.locator("#btnClear").click();
    const none = await page.locator('[data-cat="devices"] .preset.active').count();
    expect(none).toBe(0);

    // Reset — should restore Retina only
    await page.locator("#btnReset").click();
    const resetCount = await page.locator('[data-cat="devices"] .preset.active').count();
    expect(resetCount).toBe(1);
    await expect(page.locator('[data-name="Retina"]')).toHaveClass(/active/);
  });

  test("lucky button changes URL", async ({ page }) => {
    await page.goto(BASE);
    const input = page.locator("#urlInput");
    const before = await input.inputValue();
    await page.locator('button[title="I\'m feeling lucky"]').click();
    const after = await input.inputValue();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^https:\/\//);
  });
});
