const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  outputDir: "./_local/test-results",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3000",
  },
  webServer: {
    command: "node server.js",
    port: 3000,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});
