import { StringDecoder } from "node:string_decoder";

/**
 * Strict LF-only JSONL line splitter (rpc.md): records are delimited by \n
 * exclusively; a trailing \r is tolerated. Node's readline is
 * non-compliant because it also splits on U+2028/U+2029, which are valid
 * inside JSON strings.
 */
export interface LfLineSplitter {
  feed(chunk: Buffer | string): void;
  flush(): void;
}

export function createLfLineSplitter(onLine: (line: string) => void): LfLineSplitter {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  function drain(final: boolean): void {
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
    if (final) {
      const rest = buffer + decoder.end();
      buffer = "";
      const line = rest.replace(/\r$/, "");
      if (line.trim().length > 0) onLine(line);
    }
  }

  return {
    feed(chunk: Buffer | string): void {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      drain(false);
    },
    flush(): void {
      drain(true);
    },
  };
}
