import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

page.on("response", (r) => {
  const u = r.url();
  if (u.includes("executor") && r.request().method() === "POST") {
    console.log(`POST ${r.status()} loc=${String(r.headers()["location"] ?? "-").slice(0, 120)}`);
  }
});
page.on("request", async (r) => {
  if (r.url().includes("executor") && r.method() === "POST") {
    const h = await r.allHeaders();
    console.log(`POST req: cookie=${(h.cookie ?? "NONE").slice(0, 90)} csrf=${h["x-authentik-csrf"] ?? "NONE"}`);
  }
});
page.on("request", async (r) => {
  if (r.url().includes("executor") && r.method() === "GET") {
    const h = await r.allHeaders();
    console.log(`GET req: cookie=${(h.cookie ?? "NONE").slice(0, 90)}`);
  }
});

await page.goto("http://admin.gw.home/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#ak-identifier-input", { state: "visible", timeout: 45000 });
await page.fill("#ak-identifier-input", "admin");
await page.click("button[type=submit]");
await page.waitForSelector("input[name=password]", { state: "visible", timeout: 45000 });
await page.fill("input[name=password]", "admin-pass-1");
await page.click("button[type=submit]");
await page.waitForTimeout(8000);
console.log(`final: ${page.url().slice(0, 90)}`);
await browser.close();
