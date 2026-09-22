import { chromium } from "playwright";

const target = process.argv[2] ?? "admin.gw.home:8880";
const browser = await chromium.launch();
const page = await browser.newPage();

page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) console.log(`NAV -> ${f.url().slice(0, 120)}`);
});
page.on("response", (r) => {
  if (r.status() >= 300 && r.status() < 400) {
    console.log(`  ${r.status()} ${r.url().slice(0, 90)} -> ${String(r.headers()["location"] ?? "").slice(0, 90)}`);
  }
});

await page.goto(`http://${target}/`, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((e) => console.log(`goto: ${e.message.split("\n")[0]}`));
await page.waitForTimeout(15000);
console.log("final:", page.url());
const inputs = await page.evaluate(() =>
  [...document.querySelectorAll("input")].map((el) => `${el.type}:${el.name}:${el.id}`),
).catch(() => []);
console.log("inputs:", JSON.stringify(inputs));
await browser.close();
