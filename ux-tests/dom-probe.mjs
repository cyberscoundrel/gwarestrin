import { chromium } from "playwright";

const target = process.argv[2] ?? "admin.gw.home:8880";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://${target}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(18000);
console.log("final:", page.url().slice(0, 90));
const n = await page.locator("input").count();
console.log("input count:", n);
for (let i = 0; i < Math.min(n, 8); i++) {
  const el = page.locator("input").nth(i);
  const attrs = await el.evaluate((e) => ({
    type: e.type,
    name: e.name,
    id: e.id,
    placeholder: e.placeholder,
  })).catch(() => null);
  console.log(`  input[${i}]:`, JSON.stringify(attrs));
}
const btns = await page.locator("button").allInnerTexts().catch(() => []);
console.log("buttons:", JSON.stringify(btns.slice(0, 6)));
await browser.close();
