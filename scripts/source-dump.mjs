#!/usr/bin/env node
// Dump a test source through its read endpoint, for the evaluation's row diff (docs/build/integrate.md, 2.2).
//
//   node scripts/source-dump.mjs --read-url http://host:5000/mcp --out before.json
//        --expect-server gwsynth-sql --expect-database GwSynthMfg [--identity-url http://host:5001/mcp]
//        [--keys dbo_Vendor=Vendor,dbo_X=A+B]
//
// --read-url is required and has no default. Only ever the synthetic test source's read endpoint: this reads
// every row of every table the endpoint exposes, so it refuses to read anything until the connection names the
// expected test server and database (eval/dump.mjs guardTestSource, through test-sql's dbo_GwConnectionIdentity
// view, read on --identity-url when given, else on --read-url). No expected names, no view, or other names:
// nothing is read. --keys names the key columns of a table whose key the first page's cursor can't give.
import { writeFileSync } from "node:fs";
import { connectionIdentity, dumpSource, guardTestSource, mcpClient } from "../graph-rag/eval/dump.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]] : acc), []),
);
if (typeof args["read-url"] !== "string" || !/^https?:\/\//.test(args["read-url"]) || typeof args.out !== "string" || typeof args["expect-server"] !== "string" || typeof args["expect-database"] !== "string") {
  console.error("usage: source-dump.mjs --read-url URL --out file --expect-server NAME --expect-database NAME [--identity-url URL] [--keys table=col+col,...]");
  process.exit(2);
}
const read = mcpClient(args["read-url"]);
const identity = typeof args["identity-url"] === "string" ? mcpClient(args["identity-url"]) : read;
try {
  const got = await guardTestSource(() => connectionIdentity(identity), { server: args["expect-server"], database: args["expect-database"] });
  console.log(`guard: the connection holds ${got.server}/${got.database}`);
} catch (e) {
  console.error(`refusing to dump: ${e.message}`);
  process.exit(1);
}
const keys = {};
if (typeof args.keys === "string") for (const part of args.keys.split(",")) {
  const [t, cols] = part.split("=");
  keys[t] = cols.split("+");
}
const dump = await dumpSource(read, { keys });
writeFileSync(args.out, `${JSON.stringify(dump, null, 2)}\n`);
console.log(`wrote ${args.out}: ${Object.entries(dump).map(([t, v]) => `${t} ${v.rows.length}`).join(", ")}`);
