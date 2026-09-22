import { chromium } from "playwright";

const target = process.argv[2] ?? "admin.gw.home:8880";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://${target}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(12000);
console.log("url:", page.url());
console.log("title:", await page.title());
for (const frame of page.frames()) {
  const inputs = await frame.evaluate(() =>
    [...document.querySelectorAll("input, button")].map((el) => ({
      tag: el.tagName,
      name: el.getAttribute("name"),
      id: el.id,
      type: el.getAttribute("type"),
      cls: (el.className || "").toString().slice(0, 40),
    })),
  ).catch((e) => [`frame error: ${e.message.split("\n")[0]}`]);
  console.log(`frame: ${frame.url().slice(0, 90)}`);
  console.log(JSON.stringify(inputs, null, 1));
}
await page.screenshot({ path: "/tests/artifacts/dom-probe.png", fullPage: true });
await browser.close();
