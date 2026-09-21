/**
 * Blueprint apply diagnostics (run on the deploy host):
 *   node scripts/bp-apply-diag.mjs
 *
 * Triggers a blueprint re-apply via the authentik API and dumps the full
 * per-entry result, including validation errors.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const envText = readFileSync("/home/cyber/gwarestrin/.env", "utf8");
const ev = Object.fromEntries(
  envText.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const ip = execSync('docker inspect gwarestrin-authentik-server-1 --format "{{index .NetworkSettings.Networks \\"gwarestrin_backend\\" \\"IPAddress\\"}}"')
  .toString()
  .trim();
const basic = "Basic " + Buffer.from(`akadmin:${ev.AUTHENTIK_BOOTSTRAP_PASSWORD}`).toString("base64");

const list = await fetch(`http://${ip}:9000/api/v3/managed/blueprints/`, {
  headers: { authorization: basic, accept: "application/json" },
  signal: AbortSignal.timeout(15_000),
});
const listJ = await list.json();
const target = (listJ.results ?? []).find((b) => b.path?.includes("gw"));
if (!target) {
  console.log("no gw blueprint instance found");
  process.exit(1);
}
console.log("uuid:", target.uuid, "status:", target.status);

const apply = await fetch(`http://${ip}:9000/api/v3/managed/blueprints/${target.uuid}/apply/`, {
  method: "POST",
  headers: { authorization: basic, accept: "application/json" },
  signal: AbortSignal.timeout(60_000),
});
const text = await apply.text();
console.log("apply status:", apply.status);
try {
  const j = JSON.parse(text);
  console.log(JSON.stringify(j, null, 1).slice(0, 2000));
} catch {
  console.log(text.slice(0, 800));
}
