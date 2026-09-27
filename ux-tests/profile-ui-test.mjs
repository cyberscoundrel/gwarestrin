import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://admin.gw.home/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.locator("#ak-identifier-input").waitFor({ state: "visible", timeout: 60000 });
await page.locator("#ak-identifier-input").fill("admin");
await page.locator("button[type=submit]:visible").first().click();
await page.locator("#ak-identifier-input").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
const pw = page.locator("input[name=password]:visible");
await pw.waitFor({ state: "visible", timeout: 60000 });
await page.waitForTimeout(1500);
await pw.fill("admin-pass-1");
await page.locator("button[type=submit]:visible").first().click();
await page.waitForURL("http://admin.gw.home/**", { timeout: 60000 });
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(5000);

// 1. sidebar shows the Default profile group
const rail = await page.locator("nav").innerText();
console.log("sidebar has Default profile:", rail.includes("Default"));
console.log("sidebar has + new profile:", rail.includes("+ new profile"));

// 2. open the profile editor via "+ new profile"
await page.locator("button", { hasText: "+ new profile" }).first().click();
await page.waitForTimeout(1500);
const editor = await page.locator("body").innerText();
console.log("editor open:", editor.includes("new profile"));
console.log("editor has context engine toggle:", editor.includes("context engine"));
console.log("editor has shared tools toggle:", editor.includes("shared /tools"));

// 3. fill + save a profile with an engine + limited mcp + sharedTools off
await page.locator("input[placeholder='e.g. sql-analyst']").fill("ops-analyst");
await page.locator("textarea[placeholder*='analysis prompt']").fill("Summarize the homelab machines and services relevant to infrastructure monitoring.");
await page.locator("label", { hasText: "shared /tools directory" }).locator("input").uncheck();
const buttons = page.locator("button", { hasText: "pick…" });
if (await buttons.count()) {
  await buttons.first().click();
  await page.locator("div.flex.flex-wrap button", { hasText: "graph-rag" }).first().click();
}
await page.locator("button", { hasText: "create profile" }).first().click();
await page.waitForTimeout(2500);

// 4. editor now shows the saved profile (title updated) — verify via API instead
const profiles = await page.evaluate(async () => (await (await fetch("/api/profiles")).json()).profiles);
console.log("profiles now:", profiles.map((p) => `${p.id}:${p.name} engine=${p.contextEngine?.type ?? "none"} sharedTools=${p.sharedTools !== false} mcp=${JSON.stringify(p.mcpServers)}`));

// 5. editor shows edit mode for the saved profile
const after = await page.locator("body").innerText();
console.log("editor in edit mode:", after.includes("edit profile — ops-analyst"));
await page.screenshot({ path: "/tests/artifacts/profile-editor.png", fullPage: true });
await browser.close();
