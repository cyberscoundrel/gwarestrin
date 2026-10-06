import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxFs, type SandboxFsApi } from "../src/runtime/openshell-fs.js";
import { HttpPathError } from "../src/util/paths.js";

/** Runs each "sandbox" exec as a real local process: exercises FSCTL, sh, cat, mv for real. */
function localApi(): SandboxFsApi & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (argv: string[], stdin?: Buffer) =>
    new Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
      const [cmd, ...args] = argv;
      const child = spawn(cmd === "node" ? process.execPath : cmd!, args, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
      child.stdin.end(stdin ?? Buffer.alloc(0));
    });
  return {
    calls,
    exec: (async (_name: string, argv: string[], opts?: { stdin?: Buffer }) => {
      calls.push(argv);
      return run(argv, opts?.stdin);
    }) as never,
    execStream: async function* (_name: string, argv: string[]) {
      calls.push(argv);
      const res = await run(argv);
      // deliver in small pieces like a real stream
      for (let i = 0; i < res.stdout.length; i += 1000) yield { stream: "stdout" as const, data: res.stdout.subarray(i, i + 1000) };
      yield { type: "exit" as const, exitCode: res.exitCode };
    } as never,
  };
}

async function workspace() {
  const base = await mkdtemp(path.join(tmpdir(), "gw-sfs-"));
  const root = path.join(base, "workspace");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.txt"), "alpha");
  await writeFile(path.join(root, "notes with spaces ü.md"), "# hi");
  await writeFile(path.join(base, "secret.txt"), "outside");
  await symlink(path.join(base, "secret.txt"), path.join(root, "escape-link"));
  await symlink(base, path.join(root, "escape-dir"));
  const api = localApi();
  return { base, root, api, fs: new SandboxFs(api, "gw-test", root) };
}

async function collect(s: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of s) parts.push(p);
  return Buffer.concat(parts);
}

describe("SandboxFs (real in-sandbox helper, run locally)", () => {
  it("lists a directory dirs-first and stats a file", async () => {
    const { fs } = await workspace();
    const top = await fs.statOrList("");
    expect(top.rel).toBe(".");
    expect(top.entries?.map((e) => [e.name, e.type])).toEqual([
      ["src", "dir"],
      ["escape-dir", "symlink"],
      ["escape-link", "symlink"],
      ["notes with spaces ü.md", "file"],
    ]);
    const file = await fs.statOrList("src/a.txt");
    expect(file.file).toMatchObject({ name: "a.txt", type: "file", size: 5 });
  });

  it("refuses symlinks that leave the workspace", async () => {
    const { fs } = await workspace();
    await expect(fs.statOrList("escape-link")).rejects.toBeInstanceOf(HttpPathError);
    await expect(fs.open("escape-link")).rejects.toMatchObject({ status: 400 });
    await expect(fs.write("escape-dir/planted.txt", [Buffer.from("x")])).rejects.toMatchObject({ status: 400 });
  });

  it("rejects lexical escapes and agent internals before reaching the sandbox", async () => {
    const { fs, api } = await workspace();
    const before = api.calls.length;
    await expect(fs.statOrList("../secret.txt")).rejects.toMatchObject({ status: 400 });
    await expect(fs.statOrList("/etc/passwd")).rejects.toMatchObject({ status: 400 });
    await expect(fs.statOrList(".pi/settings.json")).rejects.toMatchObject({ status: 403 });
    expect(api.calls.length).toBe(before);
  });

  it("maps missing paths to ENOENT", async () => {
    const { fs } = await workspace();
    await expect(fs.statOrList("nope.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.remove("nope.txt")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streams a download byte-exact", async () => {
    const { fs } = await workspace();
    const f = await fs.open("notes with spaces ü.md");
    expect(f).toMatchObject({ name: "notes with spaces ü.md", size: 4 });
    expect((await collect(f.stream)).toString()).toBe("# hi");
  });

  it("uploads in chunks through a temp file, creating parents, byte-exact for binary", async () => {
    const { fs, root } = await workspace();
    const big = Buffer.alloc(9 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const pieces = [big.subarray(0, 3_000_000), big.subarray(3_000_000, 6_500_000), big.subarray(6_500_000)];
    const n = await fs.write("new/dir/blob.bin", pieces);
    expect(n).toBe(big.length);
    expect((await readFile(path.join(root, "new/dir/blob.bin"))).equals(big)).toBe(true);
    expect((await readdir(path.join(root, "new/dir"))).sort()).toEqual(["blob.bin"]);
    // round trip through the download path too
    expect((await collect((await fs.open("new/dir/blob.bin")).stream)).equals(big)).toBe(true);
  });

  it("creates and removes directories", async () => {
    const { fs, root } = await workspace();
    await fs.mkdir("made/deep");
    expect((await readdir(path.join(root, "made"))).includes("deep")).toBe(true);
    await fs.remove("made");
    expect((await readdir(root)).includes("made")).toBe(false);
  });
});
