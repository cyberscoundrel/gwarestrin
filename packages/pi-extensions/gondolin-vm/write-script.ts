/**
 * Pure helpers for building the guest-side shell script that writes a file
 * inside the gondolin VM. Kept dependency-free (no gondolin / pi imports) so
 * it can be unit-tested on the host with a real /bin/sh.
 */

/** Single-quote a value for POSIX sh. */
export function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function posixDirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash > 0) return trimmed.slice(0, slash);
  return slash === 0 ? "/" : ".";
}

/**
 * Build a /bin/sh script that writes `content` (UTF-8) to `guestPath`
 * byte-exactly. The content travels as base64, appended in chunks to a temp
 * file next to the target (chunking keeps each command under MAX_ARG_STRLEN,
 * gondolin #130), then decoded into place with `base64 -d < tmp`.
 */
export function writeFileScript(guestPath: string, content: string, chunkSize = 65536): string {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`invalid chunkSize: ${chunkSize}`);
  }
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const target = shQuote(guestPath);
  const script = [
    `set -eu`,
    `mkdir -p ${shQuote(posixDirname(guestPath))}`,
    `tmp=${target}.gw-write.$$`,
    `trap 'rm -f "$tmp"' EXIT`,
    `: > "$tmp"`,
  ];
  for (let i = 0; i < b64.length; i += chunkSize) {
    script.push(`printf %s ${shQuote(b64.slice(i, i + chunkSize))} >> "$tmp"`);
  }
  // stdin, not a file operand: macOS base64 rejects positional files
  script.push(`base64 -d < "$tmp" > ${target}`);
  return script.join("\n");
}
