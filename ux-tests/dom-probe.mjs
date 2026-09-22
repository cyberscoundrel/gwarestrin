import { chromium } from "playwright";

const target = process.argv[2] ?? "admin.gw.home:8880";
const browser = await chromium.launch();
const page = await browser.newPage();

page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) console.log(`NAV -> ${f.url().slice(0, 120)}`);
});
page.on("response", (r) => {
  if (r.status() >= 300 || r.request().isNavigationRequest()) {
    console.log(`  ${r.status()} ${r.request().method()} ${r.url().slice(0, 95)}${r.status() >= 300 ? ` -> ${String(r.headers()["location"] ?? "").slice(0, 100)}` : ""}`);
  }
});

await page.goto(`http://${target}/`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log(`goto: ${e.message.split("\n")[0]}`));
await page.waitForTimeout(15000);
console.log("final:", page.url());
console.log("title:", await page.title());
console.log("input count (shadow-piercing):", await page.locator("input").count());
console.log("uidField present:", await page.locator("input[name=uidField], input[name=username]").count());
const bodyText = (await page.locator("body").innerText().catch(() => "")) ?? "";
console.log("body text:", bodyText.slice(0, 200).replace(/\s+/g, " "));
await browser.close();
