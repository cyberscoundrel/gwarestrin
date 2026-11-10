#!/usr/bin/env node
// Dump a test source through its read endpoint, for the evaluation's row diff (docs/build/integrate.md, 2.2).
//
//   node scripts/source-dump.mjs --read-url http://host:5000/mcp --out before.json [--keys dbo_Vendor=Vendor,dbo_X=A+B]
//
// --read-url is required and has no default. Only ever the synthetic test source's read endpoint: this reads
// every row of every table the endpoint exposes. --keys names the key columns of a table whose key the first
// page's cursor can't give (a table with one row or none).
import { writeFileSync } from "node:fs";
import { dumpSource, mcpClient } from "../graph-rag/eval/dump.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
if (typeof args["read-url"] !== "string" || !/^https?:\/\//.test(args["read-url"]) || typeof args.out !== "string") {
  console.error("usage: source-dump.mjs --read-url URL --out file [--keys table=col+col,...]");
  process.exit(2);
}
const keys = {};
if (typeof args.keys === "string") for (const part of args.keys.split(",")) {
  const [t, cols] = part.split("=");
  keys[t] = cols.split("+");
}
const dump = await dumpSource(mcpClient(args["read-url"]), { keys });
writeFileSync(args.out, `${JSON.stringify(dump, null, 2)}\n`);
console.log(`wrote ${args.out}: ${Object.entries(dump).map(([t, v]) => `${t} ${v.rows.length}`).join(", ")}`);
