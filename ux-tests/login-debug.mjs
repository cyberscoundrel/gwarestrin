import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://admin.gw.home:8880/", { waitUntil: "domcontentloaded", timeout: 45000 });

await page.waitForSelector("#ak-identifier-input", { state: "visible", timeout: 45000 });
await page.fill("#ak-identifier-input", "admin");
await page.click("button[type=submit]");
await page.waitForSelector("input[name=password]", { state: "visible", timeout: 45000 });
await page.fill("input[name=password]", "admin-pass-1");
await page.click("button[type=submit]");

for (const wait of [3000, 6000, 9000]) {
  await page.waitForTimeout(wait);
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 260);
  console.log(`--- after +${wait}ms: ${page.url().slice(0, 70)}`);
  console.log(`    ${text}`);
  if (page.url().startsWith("http://admin.gw.home")) break;
}
await page.screenshot({ path: "/tests/artifacts/login-debug.png" });
await browser.close();
