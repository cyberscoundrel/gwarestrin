import assert from "node:assert/strict";
import { test } from "node:test";
import { applySettingsUpdate, defaultSettings, normalizeSettings } from "../instance-settings.mjs";

const d = defaultSettings({});

test("defaults: 2 agents, every connection and provider", () => {
  assert.deepEqual(d, { maxAgents: 2, mcp: "all", providers: "all" });
  assert.equal(defaultSettings({ TENANT_MAX_AGENTS: "4" }).maxAgents, 4);
  assert.equal(defaultSettings({ TENANT_MAX_AGENTS: "999" }).maxAgents, 2);
});

test("updates are validated", () => {
  assert.deepEqual(applySettingsUpdate(d, { maxAgents: 4 }), { ...d, maxAgents: 4 });
  assert.deepEqual(applySettingsUpdate(d, { mcp: ["mssql", "graph-rag", "mssql"] }).mcp, ["graph-rag", "mssql"]);
  assert.deepEqual(applySettingsUpdate(d, { mcp: [] }).mcp, [], "no tool connections at all is allowed");
  assert.deepEqual(applySettingsUpdate(d, { providers: ["local-inference"] }).providers, ["local-inference"]);
  assert.throws(() => applySettingsUpdate(d, { providers: [] }), /at least one model provider/);
  assert.throws(() => applySettingsUpdate(d, { maxAgents: 0 }), /1 to 32/);
  assert.throws(() => applySettingsUpdate(d, { maxAgents: 2.5 }), /whole number/);
  assert.throws(() => applySettingsUpdate(d, { mcp: "some" }), /"all" or a list/);
  assert.throws(() => applySettingsUpdate(d, { mcp: ["../etc"] }), /"all" or a list/);
  assert.throws(() => applySettingsUpdate(d, { runtime: "local" }), /unknown setting/);
});

test("stored settings fall back to defaults when stale", () => {
  assert.deepEqual(normalizeSettings({ maxAgents: 3, old: 1 }, d), { ...d, maxAgents: 3 });
  assert.deepEqual(normalizeSettings({ maxAgents: -1 }, d), d);
  assert.deepEqual(normalizeSettings(undefined, d), d);
});
