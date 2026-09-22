import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("executor")) {
    let body = "";
    try {
      body = (await r.text()).replace(/\s+/g, " ").slice(0, 260);
    } catch {
      body = "<redirect/empty>";
    }
    console.log(`${r.request().method()} ${r.status()} ${u.slice(0, 70)}\n   ${body}`);
  }
});
page.on("pageerror", (err) => console.log(`PAGE ERROR: ${err.message.slice(0, 200)}`));

await page.goto("http://admin.gw.home/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#ak-identifier-input", { state: "visible", timeout: 45000 });
await page.fill("#ak-identifier-input", "admin");
await page.click("button[type=submit]");
await page.waitForSelector("input[name=password]", { state: "visible", timeout: 45000 });
await page.fill("input[name=password]", "admin-pass-1");
await page.click("button[type=submit]");
await page.waitForTimeout(9000);
console.log(`final: ${page.url().slice(0, 90)}`);
await browser.close();
