import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("executor") && r.request().method() === "POST") {
    let body = "";
    try {
      body = (await r.text()).slice(0, 400);
    } catch {
      body = "<unreadable>";
    }
    console.log(`POST ${r.status()} -> ${body.replace(/\s+/g, " ")}`);
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
