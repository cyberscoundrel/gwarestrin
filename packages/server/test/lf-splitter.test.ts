import { describe, expect, it } from "vitest";
import { createLfLineSplitter } from "../src/util/lf-splitter.js";

describe("createLfLineSplitter (rpc.md strict framing)", () => {
  it("splits on LF only", () => {
    const lines: string[] = [];
    const s = createLfLineSplitter((l) => lines.push(l));
    s.feed('{"a":1}\n{"a":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("tolerates CRLF", () => {
    const lines: string[] = [];
    const s = createLfLineSplitter((l) => lines.push(l));
    s.feed('{"a":1}\r\n{"a":2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"a":2}']);
  });

  it("does NOT split on U+2028/U+2029 inside strings", () => {
    const LSEP = String.fromCharCode(0x2028);
    const PSEP = String.fromCharCode(0x2029);
    const lines: string[] = [];
    const s = createLfLineSplitter((l) => lines.push(l));
    // readline would split this into bogus records
    s.feed(`{"text":"a${LSEP}b${PSEP}c"}\n`);
    expect(lines).toEqual([`{"text":"a${LSEP}b${PSEP}c"}`]);
    expect(JSON.parse(lines[0]!).text).toBe(`a${LSEP}b${PSEP}c`);
  });

  it("reassembles records split across arbitrary chunk boundaries", () => {
    const lines: string[] = [];
    const s = createLfLineSplitter((l) => lines.push(l));
    const record = '{"text":"abcdefghijklmnop"}';
    for (const ch of record + "\n") {
      s.feed(ch);
    }
    expect(lines).toEqual([record]);
  });

  it("handles multi-byte UTF-8 split across chunks", () => {
    const lines: string[] = [];
    const s = createLfLineSplitter((l) => lines.push(l));
    const record = '{"text":"héllo wörld 🚀"}';
    const buf = Buffer.from(record + "\n", "utf8");
    const mid = 9; // splits inside a multi-byte sequence
    s.feed(buf.subarray(0, mid));
    s.feed(buf.subarray(mid));
    expect(lines).toEqual([record]);
    expect(JSON.parse(lines[0]!).text).toBe("héllo wörld 🚀");
  });

  it("flush emits a trailing record without newline", () => {
    const lines: string[] = [];
    const s = createLfLineSplitter((l) => lines.push(l));
    s.feed('{"tail":true}');
    expect(lines).toEqual([]);
    s.flush();
    expect(lines).toEqual(['{"tail":true}']);
  });

  it("ignores empty lines but keeps blank-in-string intact", () => {
    const lines: string[] = [];
    const s = createLfLineSplitter((l) => lines.push(l));
    s.feed('\n\n{"a":1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
  });
});
