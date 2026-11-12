// The two DAB configs for the synthetic test database, written to <out>/read/dab-config.json and
// <out>/write/dab-config.json. No credentials: each container gets its connection string from its own
// environment (@env('GWSYNTH_DAB_CONNECTION'), set by compose.yml from the untracked env file).
//
//   node test-sql/render-dab.mjs <out> [writable.json]
//
// read:  every dbo table and view, read only (the read login's grant is SELECT on the dbo schema)
// write: only the chosen tables, with read plus their create or update, and delete where a table takes new rows (to
// undo one graph-rag added, R19); and the identity view
//        the guard reads (data.mjs IDENTITY_VIEW)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IDENTITY_VIEW, WRITABLE, entityOf } from "./data.mjs";

const SCHEMA = "https://github.com/Azure/data-api-builder/releases/latest/download/dab.draft.schema.json";
const off = { rest: { enabled: false }, graphql: { enabled: false } };
const runtime = (description) => ({
  rest: { enabled: false },
  graphql: { enabled: false },
  host: { mode: "development", authentication: { provider: "Simulator" } },
  mcp: { description },
});
const source = { "database-type": "mssql", "connection-string": "@env('GWSYNTH_DAB_CONNECTION')" };

export function readConfig() {
  return {
    $schema: SCHEMA,
    "data-source": source,
    autoentities: {
      "all-dbo": {
        patterns: { include: ["dbo.%"], name: "{schema}_{object}" },
        template: { mcp: { "dml-tools": true }, ...off },
        permissions: [{ role: "anonymous", actions: [{ action: "read" }] }],
      },
    },
    runtime: runtime("The synthetic test database (invented rows), read only. Use describe_entities, then read_records. Nothing can be created, changed or deleted."),
  };
}

export function writeConfig(writable = WRITABLE) {
  const entities = {};
  for (const [table, actions] of Object.entries(writable)) {
    entities[entityOf(table)] = {
      source: { object: `dbo.${table}`, type: "table" },
      permissions: [{ role: "anonymous", actions: [{ action: "read" }, ...actions.map((action) => ({ action }))] }],
      mcp: { "dml-tools": true },
      ...off,
    };
  }
  entities[entityOf(IDENTITY_VIEW)] = {
    source: { object: `dbo.${IDENTITY_VIEW}`, type: "view", "key-fields": ["id"] },
    permissions: [{ role: "anonymous", actions: [{ action: "read" }] }],
    mcp: { "dml-tools": true },
    ...off,
  };
  return {
    $schema: SCHEMA,
    "data-source": source,
    entities,
    runtime: runtime("The write-capable instance over the synthetic test database: create and update on chosen tables, and delete only where a table takes new rows, to undo an added row. Only graph-rag's write adapter reaches it, after the guard."),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, writableFile] = process.argv.slice(2);
  if (!out) {
    console.error("usage: render-dab.mjs <out> [writable.json]");
    process.exit(2);
  }
  const writable = writableFile ? JSON.parse(readFileSync(writableFile, "utf8")) : WRITABLE;
  for (const [side, cfg] of [["read", readConfig()], ["write", writeConfig(writable)]]) {
    mkdirSync(join(out, side), { recursive: true });
    writeFileSync(join(out, side, "dab-config.json"), JSON.stringify(cfg, null, 2) + "\n");
  }
}
