// The document store: where whole documents live, outside ArcadeDB (which
// keeps the document's entry, its sections' embeddings and previews, and any
// extracted facts). A store is { name, put(id, text, meta), get(id), remove(id) }.
// Built in: a directory ("fs:/app/documents"). Object storage later is another
// store chosen with DOC_STORE; nothing else changes.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fsStore(dir) {
  const at = (id) => {
    if (!ID_RE.test(String(id))) throw new Error("invalid document id");
    return join(dir, String(id).toLowerCase());
  };
  return {
    name: `fs:${dir}`,
    async put(id, text, meta = {}) {
      const d = at(id);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, "text.txt"), String(text), "utf8");
      await writeFile(join(d, "meta.json"), JSON.stringify({ ...meta, chars: String(text).length }), "utf8");
    },
    async get(id) {
      const d = at(id);
      const [text, meta] = await Promise.all([readFile(join(d, "text.txt"), "utf8"), readFile(join(d, "meta.json"), "utf8").then(JSON.parse)]);
      return { text, meta };
    },
    async remove(id) {
      await rm(at(id), { recursive: true, force: true });
    },
  };
}

/** the configured store; an unknown kind means documents can't be ingested (nothing is lost) */
export function createDocStore(spec = "fs:/app/documents") {
  const [kind, ...rest] = String(spec || "").split(":");
  if (kind === "fs" && rest.join(":")) return fsStore(rest.join(":"));
  return null;
}
