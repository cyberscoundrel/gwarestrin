import { chromium } from "playwright";
import { readFileSync } from "node:fs";

// Simulate alice's agent: a queued graph write, then verify admin's review
// panel lists it, then approve it via the panel API.
const tokMap = JSON.parse(readFileSync("/tmp/tokmap.json", "utf8"));
const tok = (u) => tokMap.tokens.find((t) => t.user === u).token;

const GRAPH = "http://graph-rag:8000";
const ADMIN = "http://admin.gw.home";

async function call(token, method, args) {
  const res = await fetch(`${GRAPH}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: method, arguments: args } }),
  });
  return res.json();
}

const alice = tok("alice");
const admin = tok("admin");

// 1. alice writes (queued)
const w = await call(alice, "execute_graph", {
  command: "MATCH (e:Entity {name: 'queue-e2e'}) SET e.verified = true RETURN e",
});
const queuedId = w.result?.content?.[0]?.text?.match(/"id"\s*:\s*"([0-9a-f-]+)"/)?.[1]
  ?? w.result?.content?.[0]?.text?.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
console.log("alice write:", JSON.stringify(w.result ?? w).slice(0, 140));
console.log("pending id:", queuedId);

// 2. admin's server proxies the queue listing
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${ADMIN}/`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.locator("#ak-identifier-input").waitFor({ state: "visible", timeout: 60000 });
await page.locator("#ak-identifier-input").fill("admin");
await page.locator("button[type=submit]:visible").first().click();
await page.locator("#ak-identifier-input").waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
const pw = page.locator("input[name=password]:visible");
await pw.waitFor({ state: "visible", timeout: 60000 });
await page.waitForTimeout(1500);
await pw.fill("admin-pass-1");
await page.locator("button[type=submit]:visible").first().click();
await page.waitForURL(`${ADMIN}/**`, { timeout: 60000 });
await page.waitForLoadState("domcontentloaded");
await page.waitForTimeout(4000);

const sessionCookies = await page.context().cookies("http://admin.gw.home");
const cookieHeader = sessionCookies.map((c) => `${c.name}=${c.value}`).join("; ");
const q = await fetch(`${ADMIN}/api/graph-queue`, { headers: { cookie: cookieHeader } });
const qtext = await q.text();
const qj = (() => { try { return JSON.parse(qtext); } catch { return { raw: qtext.slice(0, 200) }; } })();
const items = qj.pending ?? qj.items ?? (Array.isArray(qj) ? qj : []);
console.log("admin queue status:", q.status, "count:", Array.isArray(items) ? items.length : "?");
const match = Array.isArray(items) && items.find((i) => JSON.stringify(i).includes(queuedId ?? "zzz"));
console.log("our write in admin panel:", match ? "YES" : `no (id=${queuedId})`);

// 3. approve via the panel API
if (match && queuedId) {
  const ap = await fetch(`${ADMIN}/api/graph-queue/approve`, {
    method: "POST",
    headers: { cookie: cookieHeader, "content-type": "application/json" },
    body: JSON.stringify({ id: queuedId }),
  });
  console.log("approve:", ap.status);
  // 4. verify the write landed
  const check = await call(admin, "query_graph", { command: "MATCH (e:Entity {name: 'queue-e2e'}) RETURN e.verified" });
  console.log("post-approve node:", JSON.stringify(check.result ?? check).slice(0, 140));
}
await browser.close();
