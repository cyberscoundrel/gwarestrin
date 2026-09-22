import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();

page.on("response", async (r) => {
  const u = r.url();
  if (u.includes("executor") && r.request().method() === "POST") {
    console.log(`POST ${r.status()} loc=${String(r.headers()["location"] ?? "-").slice(0, 130)}`);
  }
});

await page.goto("http://admin.gw.home:8880/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector("#ak-identifier-input", { state: "visible", timeout: 45000 });
await page.fill("#ak-identifier-input", "admin");
await page.click("button[type=submit]");
await page.waitForSelector("input[name=password]", { state: "visible", timeout: 45000 });
await page.fill("input[name=password]", "admin-pass-1");
await page.click("button[type=submit]");
await page.waitForTimeout(9000);

console.log(`after-flow url: ${page.url().slice(0, 90)}`);
const cookies = await page.context().cookies();
console.log("cookies:", cookies.map((c) => `${c.name}@${c.domain}`).join(", "));

// the flow POST redirects via fetch; navigate explicitly to the app
console.log("[*] navigating to the app explicitly");
await page.goto("http://admin.gw.home:8880/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(6000);
console.log(`final: ${page.url().slice(0, 90)}`);
console.log(`title: ${await page.title()}`);
const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
console.log(`body: ${body}`);
await page.screenshot({ path: "/tests/artifacts/login-explicit-nav.png" });
await browser.close();
