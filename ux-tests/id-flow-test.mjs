import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

// Usage: node id-flow-test.mjs <user> <pass> <host:port> [expect=allow|deny]
const user = process.argv[2] ?? "admin";
const pass = process.argv[3] ?? "admin-pass-1";
const target = process.argv[4] ?? "admin.gw.home:8880";
const expect = process.argv[5] === "deny" ? "deny" : "allow";

mkdirSync("/tests/artifacts", { recursive: true });
const tag = `${user}-${target.split(".")[0]}`;
const appOrigin = `http://${target}`;

const browser = await chromium.launch();
const page = await browser.newPage();

console.log(`[1] opening ${appOrigin}/`);
await page.goto(`${appOrigin}/`, { waitUntil: "domcontentloaded", timeout: 45000 });

if (expect === "deny") {
  // unauthenticated user should be pushed into the authentik flow, not the app
  await page.waitForTimeout(6000);
  const onFlow = page.url().includes("auth.gw.home") || page.url().includes("outpost.goauthentik.io");
  const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
  const denied = body.toLowerCase().includes("forbidden") || body.toLowerCase().includes("denied") || body.includes("403");
  const verdict = onFlow || denied ? "PASS" : "FAIL";
  console.log(`[deny] final: ${page.url().slice(0, 90)}`);
  console.log(`[deny] pushed-to-login: ${onFlow} | explicit-denied: ${denied}`);
  console.log(`[5] verdict: ${verdict}`);
  await page.screenshot({ path: `/tests/artifacts/${tag}-final.png` });
  await browser.close();
  process.exit(verdict === "PASS" ? 0 : 1);
}

console.log(`[2] logging in as ${user}`);
try {
  await page.waitForSelector("#ak-identifier-input", { state: "visible", timeout: 45000 });
  await page.fill("#ak-identifier-input", user);
  await page.screenshot({ path: `/tests/artifacts/${tag}-1-identify.png` });
  await page.click("button[type=submit]");

  await page.waitForSelector("input[name=password]", { state: "visible", timeout: 45000 });
  await page.fill("input[name=password]", pass);
  await page.screenshot({ path: `/tests/artifacts/${tag}-2-password.png` });
  await page.click("button[type=submit]");
} catch (err) {
  console.log(`    login interaction failed: ${err.message.split("\n")[0]}`);
}

console.log("[3] waiting for return to app");
let back = false;
try {
  await page.waitForURL(`${appOrigin}/**`, { timeout: 45000 });
  back = true;
} catch {
  console.log(`    still at: ${page.url().slice(0, 100)}`);
}
await page.waitForLoadState("domcontentloaded").catch(() => {});
await page.waitForTimeout(4000);

console.log(`[4] final URL: ${page.url().slice(0, 100)}`);
console.log(`    title: ${await page.title()}`);
const body = (await page.locator("body").innerText().catch(() => "")) ?? "";
const hasUi = body.toLowerCase().includes("gwarestrin") || body.toLowerCase().includes("agent");
const verdict = back && hasUi ? "PASS" : "FAIL";
console.log(`    returned-to-app: ${back} | ui rendered: ${hasUi}`);
console.log(`[5] verdict: ${verdict}`);
await page.screenshot({ path: `/tests/artifacts/${tag}-final.png`, fullPage: false });
await browser.close();
process.exit(verdict === "PASS" ? 0 : 1);
