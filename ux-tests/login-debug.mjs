import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/") || u.includes("executor")) {
    console.log(`  ${r.status()} ${r.request().method()} ${u.slice(u.indexOf(".home") + 5, u.indexOf(".home") + 95)}`);
  }
});
page.on("console", (m) => {
  if (m.type() === "error") console.log(`console.error: ${m.text().slice(0, 140)}`);
});

await page.goto("http://admin.gw.home:8880/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#ak-identifier-input", { state: "visible", timeout: 45000 });
await page.fill("#ak-identifier-input", "admin");
await page.click("button[type=submit]");
await page.waitForSelector("input[name=password]", { state: "visible", timeout: 45000 });
await page.fill("input[name=password]", "admin-pass-1");
console.log("--- submitting password");
await page.click("button[type=submit]");
await page.waitForTimeout(8000);
const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
console.log(`final: ${page.url().slice(0, 80)}`);
console.log(`text: ${text}`);
await browser.close();
