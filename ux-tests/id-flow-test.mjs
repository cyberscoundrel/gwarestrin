import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

// Usage: node id-flow-test.mjs <user> <pass> <host> [expect=allow|deny]
const user = process.argv[2] ?? "admin";
const pass = process.argv[3] ?? "admin-pass-1";
const target = process.argv[4] ?? "admin.gw.home";
const expect = process.argv[5] === "deny" ? "deny" : "allow";

mkdirSync("/tests/artifacts", { recursive: true });
const tag = `${user}-${target.split(".")[0]}`;
const appOrigin = `http://${target}`;

const browser = await chromium.launch();
const page = await browser.newPage();

console.log(`[1] opening ${appOrigin}/`);
await page.goto(`${appOrigin}/`, { waitUntil: "domcontentloaded", timeout: 45000 });

if (expect === "deny") {
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
  // stage 1: identification
  await page.locator("#ak-identifier-input").waitFor({ state: "visible", timeout: 60000 });
  await page.locator("#ak-identifier-input").fill(user);
  await page.screenshot({ path: `/tests/artifacts/${tag}-1-identify.png` });
  await page.locator("button[type=submit]:visible").first().click();

  // stage 2: password (the flow advances via a redirect; wait for the
  // identification field to disappear and the password field to appear)
  await page.locator("#ak-identifier-input").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
  const pw = page.locator("input[name=password]:visible");
  await pw.waitFor({ state: "visible", timeout: 60000 });
  await page.waitForTimeout(1500); // let the stage card settle
  await pw.fill(pass);
  await page.screenshot({ path: `/tests/artifacts/${tag}-2-password.png` });
  await page.locator("button[type=submit]:visible").first().click();
} catch (err) {
  console.log(`    login interaction failed: ${err.message.split("\n")[0]}`);
}

console.log("[3] waiting for return to app");
let back = false;
try {
  await page.waitForURL(`${appOrigin}/**`, { timeout: 60000 });
  back = true;
} catch {
  console.log(`    still at: ${page.url().slice(0, 100)}`);
}
await page.waitForLoadState("domcontentloaded").catch(() => {});
await page.waitForTimeout(5000);

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
