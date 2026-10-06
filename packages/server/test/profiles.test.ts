import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProfileStore } from "../src/agents/profiles.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "profiles-"));
});
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
});

describe("ProfileStore", () => {
  it("seeds the default profile on first load", async () => {
    const store = new ProfileStore(dir);
    await store.load();
    const def = store.get("default");
    expect(def).toBeDefined();
    expect(def!.mcpServers).toBe("all");
    expect(def!.contextEngine).toBeUndefined();
    expect(def!.sharedTools).not.toBe(false);

    // persisted
    const raw = JSON.parse(await readFile(path.join(dir, "profiles.json"), "utf8"));
    expect(raw.profiles.map((p: { id: string }) => p.id)).toContain("default");
  });

  it("upserts and resolves profiles, default wins as fallback", async () => {
    const store = new ProfileStore(dir);
    await store.load();
    const p = store.upsert(undefined, {
      name: "sql-analyst",
      defaults: { tier: "cloud", namePrefix: "sql-" },
      mcpServers: ["mssql", "graph-rag"],
      contextEngine: { type: "graph-rag", prompt: "analyze the sql estate" },
      sharedTools: false,
    });
    expect(store.get(p.id)!.name).toBe("sql-analyst");
    expect(store.resolve("nonexistent").id).toBe("default");
    expect(store.resolve(p.id).mcpServers).toEqual(["mssql", "graph-rag"]);
    // edit
    store.upsert(p.id, { name: "sql-analyst v2", mcpServers: "all" });
    expect(store.get(p.id)!.name).toBe("sql-analyst v2");
    expect(store.get(p.id)!.contextEngine?.type).toBe("graph-rag"); // preserved
    await store.flush();
  });

  it("keeps a profile's positions until they're changed; an empty list clears them", async () => {
    const store = new ProfileStore(dir);
    await store.load();
    const p = store.upsert(undefined, { name: "floor assistant", mcpServers: "all", positions: ["pos-floor", "pos-floor"] });
    expect(store.get(p.id)!.positions).toEqual(["pos-floor"]);
    store.upsert(p.id, { name: "floor assistant", mcpServers: "all" });
    expect(store.get(p.id)!.positions).toEqual(["pos-floor"]);
    store.upsert(p.id, { name: "floor assistant", mcpServers: "all", positions: [] });
    expect(store.get(p.id)!.positions).toBeUndefined();
    await store.flush();
  });

  it("refuses to delete the default profile and reloads from disk", async () => {
    const store = new ProfileStore(dir);
    await store.load();
    const p = store.upsert(undefined, { name: "temp", mcpServers: "all" });
    expect(() => store.remove("default")).toThrow(/default/);
    store.remove(p.id);
    await store.flush();
    expect(store.get(p.id)).toBeUndefined();

    const store2 = new ProfileStore(dir);
    await store2.load();
    expect(store2.get(p.id)).toBeUndefined();
    expect(store2.get("default")).toBeDefined();
  });
});
