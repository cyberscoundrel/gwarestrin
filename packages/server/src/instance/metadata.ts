import { mkdirSync, readFileSync, watchFile, writeFileSync } from "node:fs";
import path from "node:path";
import { Value } from "typebox/value";
import { instanceMetadataSchema, resolveMetadataPath, type InstanceMetadata } from "@gwarestrin/shared";
import { scoped } from "../util/log.js";

const log = scoped("instance");

let current: InstanceMetadata | undefined;
let stateDir: string | undefined;
let sourcePath: string | undefined;

/**
 * Ingest the instance metadata document (if configured). The file is the
 * authorization source — infrastructure owns it; we watch it so capability
 * changes apply live. A validated copy is persisted into the state dir for
 * audit/survival.
 */
export function startInstanceMetadata(config: { metadataPath?: string; stateDir: string }): void {
  stateDir = config.stateDir;
  sourcePath = config.metadataPath;
  if (!sourcePath) {
    log.info("no instance metadata configured; legacy open mode");
    return;
  }
  const src: string = sourcePath;
  const load = () => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(src, "utf8"));
      if (!Value.Check(instanceMetadataSchema, parsed)) {
        const errors = [...Value.Errors(instanceMetadataSchema, parsed)].map((e) => String(e.message));
        throw new Error(`invalid instance metadata: ${errors.join("; ")}`);
      }
      const changed = JSON.stringify(current) !== JSON.stringify(parsed);
      current = parsed;
      persistCopy();
      if (changed) log.info(`instance metadata applied: ${current.instance.name}`);
    } catch (err) {
      if (!current) log.warn(`metadata load failed (${String(err).slice(0, 160)}); staying in legacy open mode`);
      else log.warn(`metadata reload failed; keeping previous: ${String(err).slice(0, 120)}`);
    }
  };
  load();
  // poll-based watch: robust across bind mounts and atomic renames
  watchFile(src, { interval: 2000 }, load);
  log.info(`watching instance metadata at ${src}`);
}

function persistCopy(): void {
  if (!stateDir || !current) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "instance-metadata.last.json"), JSON.stringify(current, null, 2) + "\n", "utf8");
  } catch (err) {
    log.warn(`metadata copy persist failed: ${String(err).slice(0, 120)}`);
  }
}

export function getInstanceMetadata(): InstanceMetadata | undefined {
  return current;
}

/**
 * Substitute ${a.b.c} paths (resolved against the instance metadata) inside
 * a string. Returns ok=false when any referenced path is missing.
 */
export function substituteInstanceValue(
  input: string,
  metadata: InstanceMetadata | undefined,
): { value: string; ok: boolean } {
  let ok = true;
  const value = input.replace(/\$\{([^}]+)\}/g, (_m, rawPath: string) => {
    if (!metadata) {
      ok = false;
      return "";
    }
    const resolved = resolveMetadataPath(metadata, rawPath.trim());
    if (resolved === undefined || resolved === null || typeof resolved === "object") {
      ok = false;
      return "";
    }
    return String(resolved);
  });
  return { value, ok };
}

/**
 * Apply instance substitution to an MCP server def (headers + env strings).
 * Legacy mode (no metadata): pass through unchanged.
 * Fail-closed: unresolvable references → null (the def is omitted from the
 * agent's config rather than shipped without its credentials).
 */
export function applyInstanceSubstitution<T extends { headers?: Record<string, string>; env?: Record<string, string> }>(
  def: T,
  metadata: InstanceMetadata | undefined,
): T | null {
  if (!metadata) return def;
  const out = JSON.parse(JSON.stringify(def)) as T;
  const groups: Array<Record<string, string> | undefined> = [out.headers, out.env];
  for (const group of groups) {
    if (!group) continue;
    for (const [k, v] of Object.entries(group)) {
      if (typeof v !== "string") continue;
      const { value, ok } = substituteInstanceValue(v, metadata);
      if (!ok) {
        log.warn(`def field ${k}: unresolvable instance reference in "${v.slice(0, 60)}"`);
        return null;
      }
      group[k] = value;
    }
  }
  return out;
}
