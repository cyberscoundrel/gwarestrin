import { chromium } from "playwright";

const target = process.argv[2] ?? "admin.gw.home:8880";
const browser = await chromium.launch();
const page = await browser.newPage();

page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/static") || u.endsWith(".js") || u.endsWith(".css")) {
    console.log(`${r.status()} ${u.slice(0, 110)}`);
  }
});
page.on("requestfailed", (r) => console.log(`FAILED ${r.failure()?.errorText} ${r.url().slice(0, 110)}`));
page.on("console", (m) => {
  if (m.type() === "error") console.log(`console.error: ${m.text().slice(0, 160)}`);
});

await page.goto(`http://${target}/`, { waitUntil: "networkidle", timeout: 45000 }).catch((e) => console.log(`goto: ${e.message.split("\n")[0]}`));
await page.waitForTimeout(8000);
console.log("---- body snippet:");
const html = await page.content().catch(() => "");
console.log(html.slice(0, 600).replace(/\s+/g, " "));
await browser.close();
