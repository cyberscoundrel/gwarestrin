import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shQuote, writeFileScript } from "../../pi-extensions/gondolin-vm/write-script.ts";

const run = promisify(execFile);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "gw-write-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeAndRead(target: string, content: string, chunkSize?: number): Promise<Buffer> {
  await run("/bin/sh", ["-c", writeFileScript(target, content, chunkSize)]);
  return readFile(target);
}

describe("gondolin writeFileScript", () => {
  const cases: Array<[string, string]> = [
    ["plain text", "hello"],
    ["empty string", ""],
    ["single quotes", "it's 'quoted' ''"],
    ["double quotes", 'say "hi" ""'],
    ["shell variables", "$HOME ${HOME} $$ $(id)"],
    ["backticks", "`whoami` ``"],
    ["backslashes", "a\\b\\\\c\\n\\t\\"],
    ["newlines and CRLF", "line1\nline2\r\nline3\n\n\r\n"],
    ["unicode and emoji", "héllo wörld 日本語 🎉👍🏽 \u0000 after-nul"],
  ];

  for (const [name, content] of cases) {
    it(`round-trips ${name} byte-exactly`, async () => {
      const target = path.join(root, "out.txt");
      const got = await writeAndRead(target, content);
      expect(got.equals(Buffer.from(content, "utf8"))).toBe(true);
    });
  }

  it("round-trips content spanning many chunks", async () => {
    let content = "";
    for (let i = 0; i < 2000; i++) content += `row ${i}: 'q' "d" $x \`b\` \\ ✓\n`;
    const chunkSize = 64;
    const script = writeFileScript(path.join(root, "x"), content, chunkSize);
    expect(script.split("\n").filter((l) => l.startsWith("printf")).length).toBeGreaterThan(10);

    const target = path.join(root, "big.txt");
    const got = await writeAndRead(target, content, chunkSize);
    expect(got.equals(Buffer.from(content, "utf8"))).toBe(true);
  });

  it("uses chunk sizes that are not multiples of 4", async () => {
    const content = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(10);
    const target = path.join(root, "odd.txt");
    const got = await writeAndRead(target, content, 7);
    expect(got.toString("utf8")).toBe(content);
  });

  it("overwrites an existing file rather than appending", async () => {
    const target = path.join(root, "over.txt");
    await writeAndRead(target, "first version, longer");
    const got = await writeAndRead(target, "second");
    expect(got.toString("utf8")).toBe("second");
  });

  it("creates missing parent directories", async () => {
    const target = path.join(root, "a", "b c", "it's", "file.txt");
    const got = await writeAndRead(target, "nested");
    expect(got.toString("utf8")).toBe("nested");
  });

  it("handles a target path with spaces and quotes", async () => {
    const target = path.join(root, `we"ird 'name' $HOME.txt`);
    const got = await writeAndRead(target, "ok");
    expect(got.toString("utf8")).toBe("ok");
  });

  it("leaves no temp file behind", async () => {
    const dir = path.join(root, "clean");
    const target = path.join(dir, "f.txt");
    await writeAndRead(target, "x".repeat(1000), 16);
    expect(await readdir(dir)).toEqual(["f.txt"]);
  });

  it("does not write the base64 text itself", async () => {
    const target = path.join(root, "hello.txt");
    const got = await writeAndRead(target, "hello");
    expect(got.toString("utf8")).not.toBe("aGVsbG8=");
    expect(got.toString("utf8")).toBe("hello");
  });
});

describe("shQuote", () => {
  it("survives a round trip through sh", async () => {
    const value = `a 'b' "c" $d \`e\` \\f`;
    const { stdout } = await run("/bin/sh", ["-c", `printf %s ${shQuote(value)}`]);
    expect(stdout).toBe(value);
  });
});
