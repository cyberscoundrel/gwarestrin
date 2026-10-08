import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDocStore } from "../src/docstore.js";

test("the directory store keeps a document's text and meta, and forgets it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "docstore-"));
  const store = createDocStore(`fs:${dir}`);
  const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
  await store.put(id, "Mill 1 manual\n\nGrease every 500 hours.", { title: "Mill 1 manual" });
  const { text, meta } = await store.get(id);
  assert.match(text, /500 hours/);
  assert.equal(meta.title, "Mill 1 manual");
  assert.equal(meta.chars, text.length);
  assert.deepEqual((await store.list()).map((d) => d.id), [id]);
  await store.remove(id);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.get(id));
});

test("ids are checked (no paths), and unknown stores are refused", async () => {
  const store = createDocStore("fs:/tmp/x");
  await assert.rejects(store.put("../../etc/passwd", "x"), /invalid document id/);
  assert.equal(createDocStore("s3:bucket"), null);
  assert.equal(createDocStore(""), null);
});
