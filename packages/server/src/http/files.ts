import fastifyMultipart from "@fastify/multipart";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { AgentManager } from "../agents/manager.js";
import { dirsFor } from "../agents/scaffold.js";
import type { ServerConfig } from "../config.js";
import { scoped } from "../util/log.js";
import { assertMutable, HttpPathError, resolveSafe } from "../util/paths.js";

const log = scoped("files");

interface FileEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: string;
  mode: number;
}

async function listDir(abs: string): Promise<FileEntry[]> {
  const entries = await readdir(abs, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    const st = await lstat(path.join(abs, e.name));
    out.push({
      name: e.name,
      type: e.isDirectory() ? "dir" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
      size: st.size,
      mtime: st.mtime.toISOString(),
      mode: st.mode,
    });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return out;
}

function workspaceFor(config: ServerConfig, manager: AgentManager, agentId: string): string {
  const record = manager.store.get(agentId);
  if (!record) throw new HttpPathError(404, "no such agent");
  return dirsFor(config.stateDir, record).workspace;
}

export async function registerFileRoutes(app: FastifyInstance, config: ServerConfig, manager: AgentManager): Promise<void> {
  await app.register(fastifyMultipart, {
    limits: { fileSize: 512 * 1024 * 1024, files: 10 },
  });

  function handlerError(reply: import("fastify").FastifyReply, err: unknown): void {
    if (err instanceof HttpPathError) {
      void reply.code(err.status).send({ error: err.message });
    } else if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      void reply.code(404).send({ error: "not found" });
    } else {
      log.error("files route error", err);
      void reply.code(500).send({ error: err instanceof Error ? err.message : "internal error" });
    }
  }

  app.get("/api/agents/:id/files", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const p = (req.query as { path?: string }).path ?? "";
      const { abs, rel } = await resolveSafe({ root: workspaceFor(config, manager, id), input: p });
      const st = await stat(abs);
      if (!st.isDirectory()) {
        // stat for a single file
        const l = await lstat(abs);
        return { path: rel, file: { name: path.basename(abs), type: "file", size: l.size, mtime: l.mtime.toISOString(), mode: l.mode } };
      }
      const entries = await listDir(abs);
      return { path: rel, entries };
    } catch (err) {
      handlerError(reply, err);
    }
  });

  app.get("/api/agents/:id/files/download", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const p = (req.query as { path?: string }).path ?? "";
      if (!p) return reply.code(400).send({ error: "path required" });
      const { abs } = await resolveSafe({ root: workspaceFor(config, manager, id), input: p });
      const st = await stat(abs);
      if (!st.isFile()) return reply.code(400).send({ error: "not a regular file" });
      const name = path.basename(abs);
      reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      reply.header("content-length", st.size);
      reply.header("content-type", "application/octet-stream");
      return reply.send(createReadStream(abs));
    } catch (err) {
      handlerError(reply, err);
    }
  });

  app.post("/api/agents/:id/files/upload", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const destDir = (req.query as { path?: string }).path ?? "";
      const { abs: dirAbs } = await resolveSafe({ root: workspaceFor(config, manager, id), input: destDir });
      const dirSt = await stat(dirAbs).catch(() => undefined);
      if (dirSt && !dirSt.isDirectory()) return reply.code(400).send({ error: "destination is not a directory" });
      await mkdir(dirAbs, { recursive: true });

      const written: Array<{ name: string; size: number }> = [];
      for await (const part of req.files()) {
        const filename = path.basename(part.filename || "upload");
        const target = path.join(dirAbs, filename);
        const { abs: targetAbs, rel } = await resolveSafe({
          root: workspaceFor(config, manager, id),
          input: path.posix.join(destDir.replace(/\\/g, "/"), filename),
        });
        assertMutable(rel);
        const tmp = targetAbs + ".upload-tmp";
        await pipeline(part.file, (await import("node:fs")).createWriteStream(tmp));
        const st = await stat(tmp);
        await rename(tmp, targetAbs);
        written.push({ name: filename, size: st.size });
        void target;
      }
      return reply.code(201).send({ uploaded: written, path: destDir });
    } catch (err) {
      handlerError(reply, err);
    }
  });

  app.delete("/api/agents/:id/files", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const p = (req.query as { path?: string }).path ?? "";
      if (!p || p === "/" || p === ".") return reply.code(400).send({ error: "refusing to delete workspace root" });
      const { abs, rel } = await resolveSafe({ root: workspaceFor(config, manager, id), input: p });
      assertMutable(rel);
      await rm(abs, { recursive: true, force: false });
      return reply.code(204).send();
    } catch (err) {
      handlerError(reply, err);
    }
  });

  // create directory
  app.post("/api/agents/:id/files/mkdir", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body ?? {}) as { path?: string };
      if (!body.path) return reply.code(400).send({ error: "path required" });
      const { abs } = await resolveSafe({ root: workspaceFor(config, manager, id), input: body.path });
      await mkdir(abs, { recursive: true });
      return reply.code(201).send({ created: body.path });
    } catch (err) {
      handlerError(reply, err);
    }
  });
}
