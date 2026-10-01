import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "../src/server.js";
import {
  commitHistory,
  commitOperations,
  imageSource,
} from "../web/canvas-client.js";

// Exercise the same client code the viewer uses, with an actual local server.
async function setup(t, beforePost = () => {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canvas-client-"));
  const service = await serve(dir, 0);
  service.store.apply({
    operations: [
      {
        op: "node.put",
        node: {
          id: "photo",
          type: "image",
          position: { x: 0, y: 0 },
          data: { title: "original" },
        },
      },
    ],
  });
  const originalFetch = globalThis.fetch;
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options?.method === "POST")
      beforePost(service.store, ++posts, JSON.parse(options.body), options);
    return originalFetch(service.url + url, options);
  });
  t.after(async () => {
    t.mock.restoreAll();
    service.close();
    await new Promise((resolve) => service.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return service;
}

test("viewer move reconciles a concurrent CLI edit without replacing metadata", async (t) => {
  const attempts = [];
  const service = await setup(t, (store, count, body) => {
    attempts.push(body);
    if (count === 1) {
      const node = store.get().nodes[0];
      store.apply({
        operations: [
          {
            op: "node.put",
            node: { ...node, data: { title: "renamed by CLI" } },
          },
        ],
      });
    }
  });
  await commitOperations([
    { op: "node.move", id: "photo", position: { x: 160, y: 90 } },
  ]);
  const result = service.store.get().nodes[0];
  assert.deepEqual(result.position, { x: 160, y: 90 });
  assert.equal(result.data.title, "renamed by CLI");
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].requestId, attempts[1].requestId);
  assert.ok(attempts[1].revision > attempts[0].revision);
});

test("viewer does not resurrect a node deleted while it was being dragged", async (t) => {
  let attempts = 0;
  const service = await setup(t, (store, count) => {
    attempts = count;
    if (count === 1)
      store.apply({ operations: [{ op: "node.delete", id: "photo" }] });
  });
  await assert.rejects(
    commitOperations([
      { op: "node.move", id: "photo", position: { x: 160, y: 90 } },
    ]),
    /节点不存在/,
  );
  assert.equal(attempts, 2);
  assert.deepEqual(service.store.get().nodes, []);
});

test("viewer image resolution follows the displayed size and screen density", () => {
  const asset = {
    width: 1536,
    height: 1024,
    url: "/assets/photo",
    thumbnailUrl: "/thumbnails/photo",
  };
  assert.equal(
    imageSource(asset, { width: 720, height: 480, zoom: 0.3, pixelRatio: 2 }),
    asset.thumbnailUrl,
  );
  assert.equal(
    imageSource(asset, { width: 720, height: 480, zoom: 1, pixelRatio: 2 }),
    asset.url,
  );
  // The importer creates thumbnails inside a 480 px square, not a 512 px one.
  assert.equal(
    imageSource(asset, { width: 500, height: 400, zoom: 1 }),
    asset.url,
  );

  const portrait = { ...asset, width: 1000, height: 2000 };
  // object-fit: contain renders a 150 x 300 image inside this 500 x 300 box.
  assert.equal(
    imageSource(portrait, { width: 500, height: 300, zoom: 1 }),
    asset.thumbnailUrl,
  );
  assert.equal(
    imageSource(portrait, { width: 500, height: 300, zoom: 2 }),
    asset.url,
  );
  assert.equal(
    imageSource(
      { ...asset, thumbnailWidth: 768, thumbnailHeight: 512 },
      { width: 720, height: 480, zoom: 1 },
    ),
    asset.thumbnailUrl,
  );
});

test("viewer image resolution keeps legacy assets and small originals usable", () => {
  const asset = {
    width: 120,
    height: 80,
    url: "/assets/photo",
    thumbnailUrl: "/thumbnails/photo",
  };
  assert.equal(
    imageSource(asset, { width: 120, height: 80, zoom: 1 }),
    asset.thumbnailUrl,
  );
  assert.equal(
    imageSource(asset, { width: 240, height: 160, zoom: 1 }),
    asset.url,
  );
  assert.equal(
    imageSource(
      { ...asset, thumbnailUrl: undefined },
      { width: 100, height: 100, zoom: 0.1 },
    ),
    asset.url,
  );
  assert.equal(
    imageSource(
      { ...asset, width: undefined },
      { width: 100, height: 100, zoom: 0.1 },
    ),
    asset.url,
  );
});

test("viewer undo and redo use authenticated history requests and displayed revisions", async (t) => {
  const attempts = [];
  const service = await setup(t, (store, count, body, options) => {
    attempts.push(body);
    assert.equal(options.headers["X-Canvas-Token"], service.token);
    assert.match(body.requestId, /^[a-f\d-]{36}$/i);
  });
  service.store.apply({
    operations: [{ op: "node.move", id: "photo", position: { x: 100, y: 60 } }],
  });
  const beforeUndo = service.store.get().revision;
  const undone = await commitHistory("undo", beforeUndo);
  assert.deepEqual(undone.nodes[0].position, { x: 0, y: 0 });
  assert.equal(attempts[0].revision, beforeUndo);
  assert.ok(undone.revision > beforeUndo);
  const redone = await commitHistory("redo", undone.revision);
  assert.deepEqual(redone.nodes[0].position, { x: 100, y: 60 });
  assert.equal(attempts[1].revision, undone.revision);
  assert.notEqual(attempts[0].requestId, attempts[1].requestId);
});

for (const direction of ["undo", "redo"]) {
  test(`viewer ${direction} conflicts do not retry or overwrite a concurrent CLI edit`, async (t) => {
    const attempts = [];
    const service = await setup(t, (store, count, body) => {
      attempts.push(body);
      if (count === 1)
        store.apply({
          operations: [
            {
              op: "node.patch",
              id: "photo",
              patch: { title: "new CLI edit" },
            },
          ],
        });
    });
    service.store.apply({
      operations: [
        { op: "node.move", id: "photo", position: { x: 100, y: 60 } },
      ],
    });
    if (direction === "redo") service.store.undo();
    const displayedRevision = service.store.get().revision;
    await assert.rejects(
      commitHistory(direction, displayedRevision),
      (error) => error.status === 409,
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].revision, displayedRevision);
    const result = service.store.get();
    assert.equal(result.nodes[0].data.title, "new CLI edit");
    assert.deepEqual(
      result.nodes[0].position,
      direction === "undo" ? { x: 100, y: 60 } : { x: 0, y: 0 },
    );
  });
}

test("viewer rejects unsupported history actions before making a request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("Unexpected request");
  });
  await assert.rejects(commitHistory("reset", 1), /无效的历史操作/);
  assert.equal(calls, 0);
});
