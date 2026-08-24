import { mkdir, symlink, writeFile } from "node:fs/promises";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertMutable, HttpPathError, resolveSafe } from "../src/util/paths.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gw-root-"));
  outside = await mkdtemp(path.join(tmpdir(), "gw-out-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("resolveSafe", () => {
  it("resolves inside the workspace", async () => {
    await mkdir(path.join(root, "sub"), { recursive: true });
    const r = await resolveSafe({ root, input: "sub/file.txt" });
    // target doesn't exist yet → lexical containment; both must hold
    expect(r.rel).toBe("sub/file.txt");
    expect(r.abs.endsWith(path.join("sub", "file.txt"))).toBe(true);
    expect(r.abs.startsWith(await realpath(root)) || r.abs.startsWith(path.resolve(root))).toBe(true);
  });

  it("empty input resolves to root", async () => {
    const r = await resolveSafe({ root, input: "" });
    expect(r.abs).toBe(await realpath(root));
  });

  it("rejects .. escapes", async () => {
    await expect(resolveSafe({ root, input: "../evil" })).rejects.toThrow(HttpPathError);
    await expect(resolveSafe({ root, input: "sub/../../evil" })).rejects.toThrow(HttpPathError);
  });

  it("rejects absolute paths", async () => {
    await expect(resolveSafe({ root, input: "/etc/passwd" })).rejects.toThrow(HttpPathError);
  });

  it("rejects symlink escapes to outside the workspace", async () => {
    await writeFile(path.join(outside, "secret.txt"), "nope");
    await symlink(outside, path.join(root, "link-out"));
    await expect(resolveSafe({ root, input: "link-out/secret.txt" })).rejects.toThrow(/symlink escapes/);
  });

  it("allows symlinks that resolve inside the workspace", async () => {
    await mkdir(path.join(root, "real"), { recursive: true });
    await writeFile(path.join(root, "real", "ok.txt"), "hi");
    await symlink(path.join(root, "real"), path.join(root, "link-in"));
    const r = await resolveSafe({ root, input: "link-in/ok.txt" });
    expect((await readFile(r.abs, "utf8"))).toBe("hi");
  });

  it("denies .pi internals", async () => {
    await expect(resolveSafe({ root, input: ".pi/settings.json" })).rejects.toThrow(/not accessible/);
  });

  it("allows nonexistent upload destinations with valid parent", async () => {
    await mkdir(path.join(root, "up"), { recursive: true });
    const r = await resolveSafe({ root, input: "up/new.txt" });
    // nonexistent target: lexical containment of its (realpath'd) parent chain
    expect(r.abs).toBe(path.resolve(root, "up/new.txt"));
  });
});

describe("assertMutable", () => {
  it("blocks generated config names", () => {
    expect(() => assertMutable("some/.mcp.json")).toThrow(/read-only/);
    expect(() => assertMutable("normal.txt")).not.toThrow();
  });
});
