import { chromium } from "playwright";

// Login as user, open their instance, look for the graph review control.
const user = process.argv[2] ?? "alice";
const pass = process.argv[3] ?? "alice-pass-1";
const target = process.argv[4] ?? "alice.gw.home";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://${target}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.locator("#ak-identifier-input").waitFor({ state: "visible", timeout: 60000 });
await page.locator("#ak-identifier-input").fill(user);
await page.locator("button[type=submit]:visible").first().click();
await page.locator("#ak-identifier-input").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
const pw = page.locator("input[name=password]:visible");
await pw.waitFor({ state: "visible", timeout: 60000 });
await page.waitForTimeout(1500);
await pw.fill(pass);
await page.locator("button[type=submit]:visible").first().click();
await page.waitForURL(`http://${target}/**`, { timeout: 60000 });
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(6000);

const body = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
const checks = {
  "ui loaded": body.includes("gwarestrin") || body.includes("agent"),
  "graph review control": body.includes("graph review") || body.includes("review"),
  "queue wording": body.includes("queue") || body.includes("pending"),
};
console.log("checks:", JSON.stringify(checks, null, 1));
await page.screenshot({ path: "/tests/artifacts/review-panel.png", fullPage: true });
await browser.close();
