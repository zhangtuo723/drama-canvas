import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { Store } from "../src/store.js";

function setup(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canvas-store-upgrade-"));
  const store = new Store(dir);
  for (const [id, mime] of [
    ["photo-a", "image/png"],
    ["photo-b", "image/png"],
    ["photo-c", "image/png"],
    ["movie", "video/mp4"],
  ]) {
    store.db.prepare("INSERT INTO assets VALUES (?,?)").run(
      id,
      JSON.stringify({
        id,
        mime,
        file: id,
        name: id,
        size: 10,
        url: "/assets/" + id,
      }),
    );
  }
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}
const node = (id, assetId) => ({
  id,
  type: "image",
  position: { x: 0, y: 0 },
  data: { title: id, ...(assetId ? { assetId } : {}) },
  style: { width: 400, height: 300 },
});
const run = (store, ...operations) => store.apply({ operations });
const get = (store, id) => store.get().nodes.find((node) => node.id === id);
const code = (expected) => (error) => error.code === expected;

// No real workspace assets are touched; asset records isolate graph/storage tests from decoding.
test("duplicate creation and invalid graph batches are atomic; patches preserve omitted fields", (t) => {
  const store = setup(t);
  run(
    store,
    { op: "node.create", node: node("a", "photo-a") },
    { op: "node.create", node: node("b") },
    { op: "node.create", node: node("c") },
  );
  const before = store.get(),
    history = store.history();
  assert.throws(
    () =>
      run(
        store,
        { op: "node.create", node: node("d") },
        { op: "node.create", node: node("a") },
      ),
    code("NODE_EXISTS"),
  );
  assert.deepEqual(store.get(), before);
  assert.deepEqual(store.history(), history);
  run(store, {
    op: "node.patch",
    id: "a",
    patch: { title: "renamed", position: { y: 60 }, style: { width: 600 } },
  });
  assert.deepEqual(get(store, "a"), {
    ...node("a", "photo-a"),
    position: { x: 0, y: 60 },
    style: { width: 600, height: 300 },
    data: { title: "renamed", assetId: "photo-a" },
  });
  run(
    store,
    { op: "node.inputs", id: "b", inputs: ["a", "a"] },
    { op: "edge.put", edge: { id: "anything", source: "a", target: "b" } },
    { op: "node.inputs", id: "c", inputs: ["b"] },
  );
  assert.equal(store.get().edges.length, 2);
  assert.equal(store.get().edges[0].id, 'dependency:["a","b"]');
  const graph = store.get();
  for (const [operation, error] of [
    [{ op: "node.inputs", id: "a", inputs: ["c"] }, "DEPENDENCY_CYCLE"],
    [{ op: "edge.put", edge: { source: "a", target: "a" } }, "SELF_DEPENDENCY"],
    [
      { op: "edge.put", edge: { source: "a", target: "missing" } },
      "EDGE_ENDPOINT_NOT_FOUND",
    ],
    [
      { op: "node.patch", id: "a", patch: { assetId: "movie" } },
      "ASSET_TYPE_MISMATCH",
    ],
    [
      { op: "node.patch", id: "a", patch: { assetId: "missing" } },
      "ASSET_NOT_FOUND",
    ],
  ]) {
    assert.throws(() => run(store, operation), code(error));
    assert.deepEqual(store.get(), graph);
  }
  run(store, {
    op: "node.put",
    node: { ...node("a", "movie"), type: "video" },
  });
  assert.equal(get(store, "a").type, "video");
});

test("generation freezes actual input versions, propagates stale changes, and never mistakes moves for edits", (t) => {
  const store = setup(t);
  run(
    store,
    ...[
      node("a", "photo-a"),
      node("b", "photo-b"),
      node("result"),
      node("next"),
    ].map((node) => ({ op: "node.create", node })),
    { op: "node.inputs", id: "result", inputs: ["a", "b"] },
  );
  assert.equal(get(store, "result").data.provenanceUnknown, true);
  run(store, {
    op: "generation.start",
    id: "result",
    prompt: "combine the photos",
    tool: "imagegen",
  });
  const started = get(store, "result").data.generation;
  assert.deepEqual(started.inputs, [
    { nodeId: "a", assetId: "photo-a" },
    { nodeId: "b", assetId: "photo-b" },
  ]);
  assert.equal(get(store, "result").data.status, "running");
  assert.equal(get(store, "result").data.stale, false);
  run(
    store,
    { op: "generation.complete", id: "result", assetId: "photo-c" },
    { op: "node.inputs", id: "next", inputs: ["result"] },
    { op: "node.patch", id: "next", patch: { assetId: "photo-c" } },
    {
      op: "generation.record",
      id: "next",
      prompt: "retouch",
      tool: "imagegen",
    },
  );
  assert.equal(get(store, "result").data.generation.id, started.id);
  assert.equal(get(store, "result").data.generation.outputAssetId, "photo-c");
  assert.equal(
    get(store, "next").data.generation.inputs[0].generationId,
    started.id,
  );
  run(
    store,
    { op: "node.move", id: "a", position: { x: 45, y: 60 } },
    {
      op: "node.patch",
      id: "result",
      patch: { title: "result renamed", style: { width: 700 } },
    },
  );
  assert.equal(get(store, "result").data.stale, false);
  assert.equal(get(store, "next").data.stale, false);
  run(store, { op: "node.patch", id: "a", patch: { assetId: "photo-b" } });
  assert.equal(get(store, "result").data.stale, true);
  assert.equal(get(store, "next").data.stale, true);
  store.undo();
  assert.equal(get(store, "result").data.stale, false);
  assert.equal(get(store, "next").data.stale, false);
  run(store, { op: "node.delete", id: "a" });
  assert.equal(get(store, "result").data.stale, true);
  store.undo();
  run(store, {
    op: "generation.record",
    id: "result",
    prompt: "new run, identical output bytes",
    tool: "imagegen",
  });
  assert.equal(get(store, "result").data.stale, false);
  assert.equal(get(store, "next").data.stale, true);
});

test("a generation completed after its inputs change remains stale; failures and unavailable inputs are explicit", (t) => {
  const store = setup(t);
  run(
    store,
    { op: "node.create", node: node("input") },
    { op: "node.create", node: node("output") },
    { op: "node.inputs", id: "output", inputs: ["input"] },
  );
  const before = store.get();
  assert.throws(
    () =>
      run(store, {
        op: "generation.start",
        id: "output",
        prompt: "test",
        tool: "imagegen",
      }),
    code("INPUT_NOT_READY"),
  );
  assert.deepEqual(store.get(), before);
  assert.throws(
    () =>
      run(store, {
        op: "generation.complete",
        id: "output",
        assetId: "photo-c",
      }),
    code("GENERATION_NOT_RUNNING"),
  );
  run(
    store,
    { op: "node.patch", id: "input", patch: { assetId: "photo-a" } },
    { op: "generation.start", id: "output", prompt: "test", tool: "imagegen" },
  );
  run(
    store,
    { op: "node.patch", id: "input", patch: { assetId: "photo-b" } },
    { op: "generation.complete", id: "output", assetId: "photo-c" },
  );
  assert.equal(get(store, "output").data.stale, true);
  assert.equal(
    get(store, "output").data.generation.inputs[0].assetId,
    "photo-a",
  );
  run(
    store,
    { op: "generation.start", id: "output", prompt: "retry", tool: "imagegen" },
    { op: "generation.fail", id: "output", error: "provider timed out" },
  );
  assert.equal(get(store, "output").data.status, "failed");
  assert.equal(
    get(store, "output").data.generation.error,
    "provider timed out",
  );
  assert.equal(get(store, "output").data.assetId, "photo-c");
});

test("history restores full nodes, edges, output versions and provenance with monotonic revision and idempotency", (t) => {
  const store = setup(t);
  assert.equal(store.history().total, 1);
  run(
    store,
    { op: "node.create", node: node("a", "photo-a") },
    { op: "node.create", node: node("result", "photo-b") },
    { op: "node.inputs", id: "result", inputs: ["a"] },
    {
      op: "generation.record",
      id: "result",
      prompt: "first",
      tool: "imagegen",
    },
  );
  const first = store.get(),
    firstId = store.history().cursor;
  run(
    store,
    {
      op: "generation.start",
      id: "result",
      prompt: "second",
      tool: "imagegen",
    },
    { op: "generation.complete", id: "result", assetId: "photo-c" },
  );
  const second = store.get();
  run(store, { op: "node.delete", id: "result" });
  const undone = store.undo({ revision: 3, requestId: "undo-one" });
  assert.deepEqual(undone, { ...second, revision: 4 });
  assert.deepEqual(store.undo({ revision: 3, requestId: "undo-one" }), undone);
  assert.throws(() => store.redo({ revision: 3 }), code("REVISION_CONFLICT"));
  assert.equal(store.get().revision, 4);
  const redone = store.redo({ revision: 4, requestId: "redo-one" });
  assert.equal(redone.revision, 5);
  assert.equal(redone.nodes.length, 1);
  assert.deepEqual(store.redo({ requestId: "redo-one" }), redone);
  const restored = store.restore(firstId, {
    revision: 5,
    requestId: "restore-one",
  });
  assert.deepEqual(restored, { ...first, revision: 6 });
  assert.equal(store.assets().length, 4);
  assert.deepEqual(
    store.restore(firstId, { requestId: "restore-one" }),
    restored,
  );
  store.undo();
  assert.equal(store.history().canRedo, true);
  run(store, { op: "node.patch", id: "a", patch: { title: "forked edit" } });
  assert.equal(store.history().canRedo, false);
  assert.throws(() => store.redo(), code("NOTHING_TO_REDO"));
  const reopened = new Store(store.dir);
  try {
    assert.deepEqual(reopened.get(), store.get());
    assert.deepEqual(reopened.history(), store.history());
  } finally {
    reopened.close();
  }
});

test("history is capped at 100 snapshots and validates paging", (t) => {
  const store = setup(t);
  run(store, { op: "node.create", node: node("a") });
  for (let i = 0; i < 105; i++)
    run(store, { op: "node.patch", id: "a", patch: { title: "version " + i } });
  assert.equal(store.history().total, 100);
  assert.equal(store.history({ limit: 3, offset: 99 }).entries.length, 1);
  assert.throws(() => store.history({ limit: 0 }), code("VALIDATION_ERROR"));
  assert.throws(() => store.restore(1), code("HISTORY_NOT_FOUND"));
});

test("legacy SQLite projects migrate duplicate edges without changing assets or claiming generation provenance", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canvas-migration-"));
  const db = new Database(path.join(dir, "canvas.sqlite"));
  db.exec(
    "CREATE TABLE state (id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE assets (id TEXT PRIMARY KEY, value TEXT); CREATE TABLE requests (id TEXT PRIMARY KEY, value TEXT)",
  );
  const legacy = {
    name: "existing",
    revision: 32,
    nodes: [node("a"), node("b")],
    edges: [
      { id: "ab", source: "a", target: "b" },
      { id: "duplicate", source: "a", target: "b" },
    ],
  };
  db.prepare("INSERT INTO state VALUES (1,?)").run(JSON.stringify(legacy));
  db.close();
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(store.get().revision, 32);
  assert.deepEqual(store.get().edges, [
    { id: 'dependency:["a","b"]', source: "a", target: "b" },
  ]);
  assert.equal(get(store, "b").data.provenanceUnknown, true);
  assert.equal(get(store, "b").data.generation, undefined);
  assert.equal(store.history().entries[0].revision, 32);
  run(store, { op: "node.delete", id: "a" });
  const undone = store.undo();
  assert.equal(undone.revision, 34);
  assert.equal(undone.nodes.length, 2);
  assert.equal(undone.edges.length, 1);
  assert.equal(store.assets().length, 0);
});

test("generation blocks unusable upstream versions and rejects invalid completion without losing running state", (t) => {
  const store = setup(t);
  run(
    store,
    ...[node("a", "photo-a"), node("b", "photo-b"), node("c", "photo-c")].map(
      (node) => ({ op: "node.create", node }),
    ),
    { op: "node.inputs", id: "b", inputs: ["a"] },
    { op: "generation.record", id: "b", prompt: "source", tool: "imagegen" },
    { op: "node.inputs", id: "c", inputs: ["b"] },
  );
  run(store, {
    op: "generation.start",
    id: "b",
    prompt: "source again",
    tool: "imagegen",
  });
  assert.throws(
    () =>
      run(store, {
        op: "generation.start",
        id: "c",
        prompt: "child",
        tool: "imagegen",
      }),
    code("INPUT_NOT_READY"),
  );
  const running = store.get();
  assert.throws(
    () => run(store, { op: "generation.complete", id: "b", assetId: "movie" }),
    code("ASSET_TYPE_MISMATCH"),
  );
  assert.deepEqual(store.get(), running);
  run(store, { op: "generation.fail", id: "b", error: "failed" });
  assert.throws(
    () =>
      run(store, {
        op: "generation.start",
        id: "c",
        prompt: "child",
        tool: "imagegen",
      }),
    code("INPUT_NOT_READY"),
  );
  run(
    store,
    {
      op: "generation.start",
      id: "b",
      prompt: "source retry",
      tool: "imagegen",
    },
    { op: "generation.complete", id: "b", assetId: "photo-b" },
    { op: "node.patch", id: "a", patch: { assetId: "photo-c" } },
  );
  assert.equal(get(store, "b").data.stale, true);
  assert.throws(
    () =>
      run(store, {
        op: "generation.start",
        id: "c",
        prompt: "child",
        tool: "imagegen",
      }),
    code("INPUT_NOT_READY"),
  );
  run(
    store,
    {
      op: "generation.start",
      id: "b",
      prompt: "updated source",
      tool: "imagegen",
    },
    { op: "generation.complete", id: "b", assetId: "photo-b" },
    { op: "generation.start", id: "c", prompt: "child", tool: "imagegen" },
  );
  assert.equal(get(store, "c").data.status, "running");
});

test("changing dependency sets or manually replacing generated output invalidates provenance", (t) => {
  const store = setup(t);
  run(
    store,
    ...[node("a", "photo-a"), node("b", "photo-b"), node("c", "photo-c")].map(
      (node) => ({ op: "node.create", node }),
    ),
    { op: "node.inputs", id: "c", inputs: ["a"] },
    { op: "generation.record", id: "c", prompt: "render", tool: "imagegen" },
  );
  run(store, { op: "node.inputs", id: "c", inputs: ["b"] });
  assert.equal(get(store, "c").data.stale, true);
  store.undo();
  run(store, { op: "node.patch", id: "c", patch: { assetId: "photo-a" } });
  assert.equal(get(store, "c").data.stale, true);
  store.undo();
  run(store, { op: "node.patch", id: "c", patch: { assetId: null } });
  assert.equal(get(store, "c").data.stale, true);
  assert.equal(get(store, "c").data.assetId, undefined);
});

test("reimport upgrades legacy metadata while preserving original asset identity and file references", async (t) => {
  const store = setup(t);
  const sharp = (await import("sharp")).default;
  const file = path.join(store.dir, "input.jpg");
  await sharp({
    create: { width: 40, height: 60, channels: 3, background: "#3498db" },
  })
    .jpeg()
    .toFile(file);
  const imported = await store.import(file, "first-name.jpg");
  const legacy = {
    id: imported.id,
    name: imported.name,
    mime: imported.mime,
    size: imported.size,
    file: imported.file,
    url: imported.url,
  };
  store.db
    .prepare("UPDATE assets SET value=? WHERE id=?")
    .run(JSON.stringify(legacy), imported.id);
  const restored = await store.import(file, "second-name.jpg");
  assert.equal(restored.name, "first-name.jpg");
  assert.equal(restored.file, legacy.file);
  assert.equal(restored.url, legacy.url);
  assert.equal(restored.width, 40);
  assert.equal(restored.height, 60);
  assert.equal(restored.thumbnailUrl, "/thumbnails/" + imported.id);
  assert.equal(
    store.assets().filter((asset) => asset.id === imported.id).length,
    1,
  );
  assert.equal(store.history().total, 1);
});

test("generation IDs prevent overlapping starts and late external jobs from overwriting a newer run", (t) => {
  const store = setup(t);
  run(
    store,
    { op: "node.create", node: node("output", "photo-a") },
    {
      op: "generation.start",
      id: "output",
      prompt: "first run",
      tool: "imagegen",
    },
  );
  const first = get(store, "output").data.generation.id;
  const started = store.get(),
    history = store.history();
  assert.throws(
    () =>
      run(store, {
        op: "generation.start",
        id: "output",
        prompt: "overlap",
        tool: "imagegen",
      }),
    (error) =>
      error.code === "GENERATION_ALREADY_RUNNING" && error.status === 409,
  );
  assert.deepEqual(store.get(), started);
  assert.deepEqual(store.history(), history);
  run(
    store,
    {
      op: "generation.fail",
      id: "output",
      generationId: first,
      error: "cancelled",
    },
    {
      op: "generation.start",
      id: "output",
      prompt: "second run",
      tool: "imagegen",
    },
  );
  const second = get(store, "output").data.generation.id;
  assert.notEqual(first, second);
  const restarted = store.get(),
    restartedHistory = store.history();
  for (const operation of [
    {
      op: "generation.complete",
      id: "output",
      generationId: first,
      assetId: "photo-b",
    },
    {
      op: "generation.fail",
      id: "output",
      generationId: first,
      error: "old provider failure",
    },
  ]) {
    assert.throws(
      () => run(store, operation),
      (error) => error.code === "GENERATION_CONFLICT" && error.status === 409,
    );
    assert.deepEqual(store.get(), restarted);
    assert.deepEqual(store.history(), restartedHistory);
  }
  const complete = {
    revision: restarted.revision,
    requestId: "complete-current-run",
    operations: [
      {
        op: "generation.complete",
        id: "output",
        generationId: second,
        assetId: "photo-c",
      },
    ],
  };
  const completed = store.apply(complete);
  assert.equal(get(store, "output").data.assetId, "photo-c");
  assert.equal(get(store, "output").data.status, "ready");
  assert.deepEqual(store.apply(complete), completed);
  assert.throws(
    () =>
      run(store, {
        op: "generation.fail",
        id: "output",
        generationId: second,
        error: "late failure after success",
      }),
    code("GENERATION_CONFLICT"),
  );
  assert.deepEqual(store.get(), completed);
});

test("request fingerprints ignore revision and object key order but reject changed operations, actions and restore targets", (t) => {
  const store = setup(t);
  const initialId = store.history().cursor;
  const first = store.apply({
    requestId: "shared-key",
    revision: 0,
    operations: [{ op: "node.create", node: node("a", "photo-a") }],
  });
  const firstId = store.history().cursor;
  run(store, { op: "node.patch", id: "a", patch: { title: "newer title" } });
  const current = store.get(),
    history = store.history();
  // Reordered fields and a refreshed revision are still the same retry.
  assert.deepEqual(
    store.apply({
      operations: [
        {
          node: {
            data: { assetId: "photo-a", title: "a" },
            style: { height: 300, width: 400 },
            position: { y: 0, x: 0 },
            type: "image",
            id: "a",
          },
          op: "node.create",
        },
      ],
      revision: current.revision,
      requestId: "shared-key",
    }),
    first,
  );
  for (const call of [
    () =>
      store.apply({
        requestId: "shared-key",
        operations: [{ op: "node.patch", id: "a", patch: { title: "other" } }],
      }),
    () => store.undo({ requestId: "shared-key" }),
    () => store.restore(initialId, { requestId: "shared-key" }),
  ]) {
    assert.throws(
      call,
      (error) => error.code === "REQUEST_ID_CONFLICT" && error.status === 409,
    );
    assert.deepEqual(store.get(), current);
    assert.deepEqual(store.history(), history);
  }
  const restored = store.restore(firstId, {
    requestId: "restore-key",
    revision: current.revision,
  });
  assert.deepEqual(
    store.restore(String(firstId), {
      requestId: "restore-key",
      revision: restored.revision,
    }),
    restored,
  );
  assert.throws(
    () => store.restore(initialId, { requestId: "restore-key" }),
    code("REQUEST_ID_CONFLICT"),
  );
  const undone = store.undo({ requestId: "history-key" });
  assert.deepEqual(
    store.undo({ requestId: "history-key", revision: undone.revision }),
    undone,
  );
  assert.throws(
    () => store.redo({ requestId: "history-key" }),
    code("REQUEST_ID_CONFLICT"),
  );
  assert.deepEqual(store.get(), undone);
});

test("request fingerprints include generation identity", (t) => {
  const store = setup(t);
  run(
    store,
    { op: "node.create", node: node("a") },
    { op: "generation.start", id: "a", prompt: "test", tool: "imagegen" },
  );
  const generationId = get(store, "a").data.generation.id;
  const operation = {
    op: "generation.complete",
    id: "a",
    generationId,
    assetId: "photo-a",
  };
  const completed = store.apply({
    requestId: "generation-key",
    operations: [operation],
  });
  assert.throws(
    () =>
      store.apply({
        requestId: "generation-key",
        operations: [{ ...operation, generationId: "different-run" }],
      }),
    code("REQUEST_ID_CONFLICT"),
  );
  assert.deepEqual(store.get(), completed);
});

test("idempotency responses retain only the latest 500 successful request IDs", (t) => {
  const store = setup(t);
  run(store, { op: "node.create", node: node("a") });
  for (let i = 0; i < 505; i++) {
    store.apply({
      requestId: "request-" + i,
      revision: store.get().revision,
      operations: [
        { op: "node.patch", id: "a", patch: { title: "revision " + i } },
      ],
    });
  }
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM requests").get().count,
    500,
  );
  assert.equal(
    store.db.prepare("SELECT id FROM requests WHERE id=?").get("request-4"),
    undefined,
  );
  assert.ok(
    store.db.prepare("SELECT id FROM requests WHERE id=?").get("request-5"),
  );
  const current = store.get(),
    history = store.history();
  assert.deepEqual(
    store.apply({
      requestId: "request-504",
      revision: current.revision,
      operations: [
        { op: "node.patch", id: "a", patch: { title: "revision 504" } },
      ],
    }),
    current,
  );
  assert.throws(
    () =>
      store.apply({
        requestId: "request-0",
        revision: 1,
        operations: [
          { op: "node.patch", id: "a", patch: { title: "revision 0" } },
        ],
      }),
    code("REVISION_CONFLICT"),
  );
  assert.deepEqual(store.history(), history);
  assert.equal(store.history().total, 100);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM requests").get().count,
    500,
  );
});

test("old request tables migrate without losing state and unverifiable legacy replays fail explicitly", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canvas-request-migration-"));
  const db = new Database(path.join(dir, "canvas.sqlite"));
  db.exec(
    "CREATE TABLE state (id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE assets (id TEXT PRIMARY KEY, value TEXT); CREATE TABLE requests (id TEXT PRIMARY KEY, value TEXT)",
  );
  const legacy = {
    name: "existing",
    revision: 9,
    nodes: [node("a")],
    edges: [],
  };
  db.prepare("INSERT INTO state VALUES (1,?)").run(JSON.stringify(legacy));
  db.transaction(() => {
    for (let i = 0; i < 502; i++)
      db.prepare("INSERT INTO requests VALUES (?,?)").run(
        "legacy-" + i,
        JSON.stringify(legacy),
      );
  })();
  db.close();
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual(store.get(), legacy);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM requests").get().count,
    500,
  );
  assert.equal(
    store.db.prepare("SELECT id FROM requests WHERE id=?").get("legacy-1"),
    undefined,
  );
  assert.equal(
    store.db
      .prepare("SELECT fingerprint FROM requests WHERE id=?")
      .get("legacy-501").fingerprint,
    null,
  );
  assert.throws(
    () => store.apply({ requestId: "legacy-501", operations: [] }),
    (error) =>
      error.code === "REQUEST_ID_CONFLICT" &&
      /旧版请求缺少操作指纹/.test(error.message),
  );
  assert.deepEqual(store.get(), legacy);
  assert.equal(store.history().total, 1);
  store.apply({
    requestId: "new-after-migration",
    revision: 9,
    operations: [{ op: "node.patch", id: "a", patch: { title: "updated" } }],
  });
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS count FROM requests").get().count,
    500,
  );
  assert.ok(
    store.db
      .prepare("SELECT fingerprint FROM requests WHERE id=?")
      .get("new-after-migration").fingerprint,
  );
  const reopened = new Store(dir);
  try {
    assert.deepEqual(reopened.get(), store.get());
    assert.deepEqual(reopened.history(), store.history());
  } finally {
    reopened.close();
  }
});
