import { realpath } from "node:fs/promises";
import path from "node:path";

/** segments that must not be served via the files API (agent internals) */
const DENY_TOP = new Set([".pi", ".agents", ".git-internal"]);

/** names served read-only (generated config), never uploaded/deleted */
const DENY_MUTATE = new Set([".mcp.json"]);

export interface SafePathOptions {
  /** virtual root the caller may never escape (agent workspace) */
  root: string;
  /** path as supplied by the client (may be "" for root) */
  input: string;
}

/** resolve a client path to a real fs path, enforcing containment */
export async function resolveSafe({ root, input }: SafePathOptions): Promise<{ abs: string; rel: string }> {
  const cleaned = input.replace(/\\/g, "/");
  if (cleaned.startsWith("/") || cleaned.startsWith("~")) {
    throw new HttpPathError(400, "absolute paths not allowed");
  }
  const rel = path.posix.normalize(cleaned || ".");
  if (rel.startsWith("..") || path.posix.isAbsolute(rel) || rel.includes("\0")) {
    throw new HttpPathError(400, "path escapes workspace");
  }
  const top = rel.split("/")[0] ?? "";
  if (DENY_TOP.has(top)) throw new HttpPathError(403, `path not accessible: ${top}`);

  const abs = path.resolve(root, rel === "." ? "" : rel);

  // containment: lexical + (if it exists) realpath symlink guard
  if (!(abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep))) {
    throw new HttpPathError(400, "path escapes workspace");
  }
  try {
    const realAbs = await realpath(abs);
    const realRoot = await realpath(root);
    if (!(realAbs === realRoot || realAbs.startsWith(realRoot + path.sep))) {
      throw new HttpPathError(400, "symlink escapes workspace");
    }
    return { abs: realAbs, rel };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // nonexistent paths are fine for upload destinations; parent must still
      // resolve inside the root
      let probe = path.dirname(abs);
      while (true) {
        try {
          const realProbe = await realpath(probe);
          const realRoot = await realpath(root);
          if (realProbe === realRoot || realProbe.startsWith(realRoot + path.sep)) {
            return { abs, rel };
          }
          throw new HttpPathError(400, "symlink escapes workspace");
        } catch (e) {
          if (e instanceof HttpPathError) throw e;
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          const parent = path.dirname(probe);
          if (parent === probe) throw new HttpPathError(400, "path escapes workspace");
          probe = parent;
        }
      }
    }
    throw err;
  }
}

export function assertMutable(rel: string): void {
  const base = rel.split("/").pop() ?? "";
  if (DENY_MUTATE.has(base)) {
    throw new HttpPathError(403, `generated config is read-only: ${base}`);
  }
}

export class HttpPathError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
