import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

page.on("request", (r) => {
  if (r.method() === "POST" && r.url().includes("executor")) {
    const h = r.headers();
    console.log(`POST headers: csrf=${h["x-authentik-csrf"] ?? h["x-csrftoken"] ?? "NONE"} referer=${(h["referer"] ?? "NONE").slice(0, 60)} cookie=${(h["cookie"] ?? "NONE").slice(0, 120)}`);
  }
});
page.on("response", (r) => {
  const sc = r.headers()["set-cookie"];
  if (sc && sc.includes("csrf")) console.log(`set-cookie: ${sc.slice(0, 140)}`);
});

await page.goto("http://admin.gw.home:8880/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#ak-identifier-input", { state: "visible", timeout: 45000 });
const cookies = await page.context().cookies();
console.log("cookies:", cookies.map((c) => `${c.name}@${c.domain}`).join(", "));
await page.fill("#ak-identifier-input", "admin");
await page.click("button[type=submit]");
await page.waitForTimeout(6000);
const cookies2 = await page.context().cookies();
console.log("cookies after submit:", cookies2.map((c) => `${c.name}@${c.domain}`).join(", "));
await browser.close();
