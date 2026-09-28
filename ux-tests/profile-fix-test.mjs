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

// 1. open the ops-analyst profile editor via the pencil
const editBtn = page.locator("button[aria-label='edit profile ops-analyst']");
await editBtn.waitFor({ state: "visible", timeout: 15000 });
await editBtn.click();
await page.waitForTimeout(1500);

// 2. styled dropdowns present (no native selects in the model section)
const nativeSelects = await page.locator("div.max-w-xl select").count();
console.log("native selects in editor body:", nativeSelects, "(expect 0)");

// 3. click the provider dropdown → options render inside the styled panel
await page.locator("button", { hasText: "local" }).first().click();
await page.waitForTimeout(800);
await page.locator("div.w-40 button").first().click();
await page.waitForTimeout(800);
const styledOptions = await page.locator("div.absolute.z-30 button").count();
console.log("styled dropdown options rendered:", styledOptions > 0);
await page.keyboard.press("Escape");
await page.locator("body").click({ position: { x: 10, y: 10 } }).catch(() => {});
await page.waitForTimeout(500);

// 4. open the mcp panel for an agent and confirm profile-locked chips
//    (ops-watch has profile mcp=[graph-rag])
const rail = await page.locator("nav").innerText();
console.log("rail shows ops-watch:", rail.includes("ops-watch"));
await browser.close();
