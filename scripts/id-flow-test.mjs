import { chromium } from "playwright";

const user = process.argv[2] ?? "admin";
const pass = process.argv[3] ?? "admin-pass-1";
const target = process.argv[4] ?? "admin.gw.home:8880";

const browser = await chromium.launch();
const page = await browser.newPage();

console.log(`[1] opening http://${target}/`);
await page.goto(`http://${target}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
console.log(`    landed on: ${page.url()}`);

// authentik login flow — either the identification card or a combined login form
console.log(`[2] logging in as ${user}`);
try {
  await page.waitForSelector("input[name=uidField], input[name=username]", { timeout: 15000 });
  await page.fill("input[name=uidField], input[name=username]", user);
  await page.click("button[type=submit]");
  await page.waitForSelector("input[name=password]", { timeout: 15000 });
  await page.fill("input[name=password]", pass);
  await page.click("button[type=submit]");
} catch (err) {
  console.log(`    login form interaction failed: ${err.message.split("\n")[0]}`);
}

console.log("[3] waiting for return to app");
try {
  await page.waitForURL(`http://${target}/**`, { timeout: 30000 });
  await page.waitForLoadState("domcontentloaded");
} catch {
  console.log(`    did not return to app — still at: ${page.url()}`);
}
await page.waitForTimeout(3000);
console.log(`[4] final URL: ${page.url()}`);
console.log(`    title: ${await page.title()}`);
const body = (await page.textContent("body").catch(() => "")) ?? "";
console.log(`    has gwarestrin UI: ${body.includes("gwarestrin") || body.includes("agent")}`);
console.log(`    denied: ${body.includes("forbidden") || body.includes("403") || body.includes("denied")}`);
await page.screenshot({ path: `/tmp/id-test-${user}.png`, fullPage: false });
await browser.close();
console.log("[5] screenshot: /tmp/id-test-" + user + ".png");
