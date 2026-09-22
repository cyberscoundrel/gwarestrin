import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

// Usage: node id-flow-test.mjs <user> <pass> <host:port> [expect=allow|deny]
// Runs against Traefik from inside the backend network; *.gw.home resolve
// via compose extra_hosts to the host gateway (published :8880).
const user = process.argv[2] ?? "admin";
const pass = process.argv[3] ?? "admin-pass-1";
const target = process.argv[4] ?? "admin.gw.home:8880";
const expect = process.argv[5] === "deny" ? "deny" : "allow";

mkdirSync("/tests/artifacts", { recursive: true });
const tag = `${user}-${target.split(".")[0]}`;

const browser = await chromium.launch();
const page = await browser.newPage();

console.log(`[1] opening http://${target}/`);
await page.goto(`http://${target}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
console.log(`    landed on: ${page.url()}`);

let loginOk = false;
if (expect === "allow") {
  console.log(`[2] logging in as ${user}`);
  try {
    await page.waitForSelector("input[name=uidField], input[name=username]", { timeout: 20000 });
    await page.fill("input[name=uidField], input[name=username]", user);
    await page.screenshot({ path: `/tests/artifacts/${tag}-1-identify.png` });
    await page.click("button[type=submit]");
    await page.waitForSelector("input[name=password]", { timeout: 20000 });
    await page.fill("input[name=password]", pass);
    await page.screenshot({ path: `/tests/artifacts/${tag}-2-password.png` });
    await page.click("button[type=submit]");
    loginOk = true;
  } catch (err) {
    console.log(`    login form interaction failed: ${err.message.split("\n")[0]}`);
  }
}

if (loginOk) {
  console.log("[3] waiting for return to app");
  try {
    await page.waitForURL(`http://${target}/**`, { timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
  } catch {
    console.log(`    did not return to app — still at: ${page.url()}`);
  }
  await page.waitForTimeout(3000);
}

console.log(`[4] final URL: ${page.url()}`);
console.log(`    title: ${await page.title()}`);
const body = (await page.textContent("body").catch(() => "")) ?? "";
const hasUi = body.includes("gwarestrin") || body.toLowerCase().includes("agent");
const denied = body.includes("forbidden") || body.includes("403") || body.toLowerCase().includes("denied");

let verdict;
if (expect === "allow") {
  verdict = page.url().includes(target.split(":")[0]) && hasUi ? "PASS" : "FAIL";
} else {
  verdict = !page.url().includes(target.split(":")[0]) || denied ? "PASS" : "FAIL";
}
console.log(`    ui rendered: ${hasUi} | denied: ${denied}`);
console.log(`[5] verdict: ${verdict}`);
await page.screenshot({ path: `/tests/artifacts/${tag}-final.png`, fullPage: false });
await browser.close();
process.exit(verdict === "PASS" ? 0 : 1);
