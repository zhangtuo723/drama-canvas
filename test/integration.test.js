import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { Store } from "../src/store.js";
import { serve } from "../src/server.js";
const temp = () => mkdtempSync(path.join(os.tmpdir(), "drama-test-"));
const pngBytes = () =>
  sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: "#82a8bf",
    },
  })
    .png()
    .toBuffer();
const node = (id) => ({
  id,
  type: "image",
  position: { x: 0, y: 0 },
  data: { title: id },
});
test("atomic batch, persistence, idempotency, conflict and edge cleanup", () => {
  const dir = temp();
  let s = new Store(dir);
  try {
    const batch = {
      requestId: "one",
      revision: 0,
      operations: [
        { op: "node.put", node: node("a") },
        { op: "node.put", node: node("b") },
        { op: "edge.put", edge: { id: "ab", source: "a", target: "b" } },
      ],
    };
    assert.equal(s.apply(batch).revision, 1);
    assert.equal(s.apply(batch).revision, 1);
    assert.throws(() => s.apply({ revision: 0, operations: [] }));
    assert.throws(() =>
      s.apply({
        operations: [
          { op: "node.put", node: node("c") },
          {
            op: "edge.put",
            edge: { id: "bad", source: "c", target: "missing" },
          },
        ],
      }),
    );
    assert.equal(s.get().nodes.length, 2);
    s.close();
    s = new Store(dir);
    assert.equal(s.get().edges.length, 1);
    s.apply({ operations: [{ op: "node.delete", id: "a" }] });
    assert.equal(s.get().edges.length, 0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("HTTP writes, SSE, media ranges and origin protection", async () => {
  const dir = temp(),
    s = await serve(dir, 0);
  try {
    await assert.rejects(serve(dir, 0), /已有服务/);
    const html = await (await fetch(s.url)).text();
    const scriptPath = html.match(/src="([^"]+\.js)"/)[1];
    const scriptResponse = await fetch(s.url + scriptPath);
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get("content-type"), /javascript/);
    const headers = {
      "Content-Type": "application/json",
      "X-Canvas-Token": s.token,
    };
    assert.equal(
      (
        await fetch(s.url + "/api/operations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(s.url + "/api/session", {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    const controller = new AbortController();
    const events = await fetch(s.url + "/api/events", {
      signal: controller.signal,
    });
    const reader = events.body.getReader();
    await reader.read();
    const put = await fetch(s.url + "/api/operations", {
      method: "POST",
      headers,
      body: JSON.stringify({
        operations: [{ op: "node.put", node: node("cli") }],
      }),
    });
    assert.equal(put.status, 200);
    const event = await reader.read();
    assert.match(new TextDecoder().decode(event.value), /revision/);
    controller.abort();
    const file = path.join(dir, "sample.png");
    const bytes = await pngBytes();
    writeFileSync(file, bytes);
    const imported = await fetch(s.url + "/api/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: file }),
    });
    assert.equal(imported.status, 200);
    const asset = await imported.json();
    const range = await fetch(s.url + asset.url, {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-type"), "image/png");
    assert.equal(
      range.headers.get("content-range"),
      `bytes 2-5/${bytes.length}`,
    );
    assert.deepEqual(
      Buffer.from(await range.arrayBuffer()),
      bytes.subarray(2, 6),
    );
    assert.equal(
      (await (await fetch(s.url + "/api/state")).json()).nodes[0].id,
      "cli",
    );
  } finally {
    s.close();
    await new Promise((r) => s.server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI placeholder, generated media attachment and resize preserve node data", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const dir = temp(),
    service = await serve(dir, 0);
  const run = async (...args) =>
    JSON.parse(
      (
        await exec(process.execPath, [
          path.resolve("src/cli.js"),
          "--project",
          dir,
          ...args,
        ])
      ).stdout,
    );
  try {
    await run(
      "node",
      "add",
      "--id",
      "image-01",
      "--type",
      "image",
      "--title",
      "场景参考",
      "--x",
      "12",
    );
    const file = path.join(dir, "generated.png");
    writeFileSync(file, await pngBytes());
    await run("node", "update", "image-01", "--file", file);
    await run(
      "node",
      "update",
      "image-01",
      "--width",
      "600",
      "--height",
      "450",
      "--y",
      "80",
    );
    const state = await run("inspect");
    const n = state.nodes[0];
    assert.equal(n.data.title, "场景参考");
    assert.equal(n.type, "image");
    assert.deepEqual(n.position, { x: 12, y: 80 });
    assert.deepEqual(n.style, { width: 600, height: 450 });
    assert.equal(n.data.assetId, state.assets[0].id);
    assert.equal((await fetch(service.url + state.assets[0].url)).status, 200);
    await assert.rejects(run("node", "update", "image-01", "--width", "-1"));
    const reopened = new Store(dir);
    assert.deepEqual(reopened.get(), service.store.get());
    reopened.close();
    const session = await fetch(service.url + "/api/session");
    assert.equal(session.status, 200);
    assert.equal(session.headers.get("cache-control"), "no-store");
    assert.equal((await session.json()).token, service.token);
  } finally {
    service.close();
    await new Promise((resolve) => service.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser session moves and deletes persist with conflicts and media retained", async () => {
  const dir = temp(),
    service = await serve(dir, 0),
    controller = new AbortController();
  try {
    const session = await fetch(service.url + "/api/session", {
      headers: { Origin: service.url },
    });
    assert.equal(session.status, 200);
    assert.equal(session.headers.get("cache-control"), "no-store");
    const { token } = await session.json();
    assert.equal(token, service.token);
    const headers = {
      "Content-Type": "application/json",
      "X-Canvas-Token": token,
      Origin: service.url,
    };
    const write = (body, overrideHeaders = {}) =>
      fetch(service.url + "/api/operations", {
        method: "POST",
        headers: { ...headers, ...overrideHeaders },
        body: JSON.stringify(body),
      });
    const file = path.join(dir, "photo.png");
    const bytes = await pngBytes();
    writeFileSync(file, bytes);
    const imported = await fetch(service.url + "/api/import", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: file }),
    });
    assert.equal(imported.status, 200);
    const asset = await imported.json();
    const photo = {
      ...node("photo"),
      data: { title: "合影", assetId: asset.id },
      style: { width: 320, height: 480 },
    };
    const created = await write({
      revision: 0,
      operations: [
        { op: "node.put", node: node("input") },
        { op: "node.put", node: photo },
        { op: "node.put", node: node("output") },
        { op: "node.inputs", id: "photo", inputs: ["input"] },
        { op: "node.inputs", id: "output", inputs: ["photo"] },
      ],
    });
    assert.equal(created.status, 200);
    const createdState = await created.json();
    assert.equal(createdState.revision, 1);
    const createdPhoto = createdState.nodes.find((n) => n.id === "photo");
    assert.deepEqual(createdPhoto, {
      ...photo,
      data: { ...photo.data, stale: false, provenanceUnknown: true },
    });
    const events = await fetch(service.url + "/api/events", {
      signal: controller.signal,
    });
    const reader = events.body.getReader();
    await reader.read();
    const position = { x: 240, y: -80 };
    const move = {
      requestId: "browser-drag",
      revision: 1,
      operations: [{ op: "node.move", id: "photo", position }],
    };
    assert.equal(
      (await write(move, { "X-Canvas-Token": "wrong-token" })).status,
      403,
    );
    assert.equal(service.store.get().revision, 1);
    const moved = await write(move);
    assert.equal(moved.status, 200);
    const movedState = await moved.json();
    assert.equal(movedState.revision, 2);
    assert.deepEqual(
      movedState.nodes.find((n) => n.id === "photo"),
      { ...createdPhoto, position },
    );
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /"revision":2/,
    );
    const staleDelete = await write({
      revision: 1,
      operations: [{ op: "node.delete", id: "photo" }],
    });
    assert.equal(staleDelete.status, 409);
    assert.match((await staleDelete.json()).error, /重新读取/);
    assert.deepEqual(service.store.get(), movedState);
    const reopenedAfterMove = new Store(dir);
    try {
      assert.deepEqual(reopenedAfterMove.get(), movedState);
    } finally {
      reopenedAfterMove.close();
    }
    const deleted = await write({
      requestId: "browser-delete",
      revision: movedState.revision,
      operations: [{ op: "node.delete", id: "photo" }],
    });
    assert.equal(deleted.status, 200);
    const deletedState = await deleted.json();
    assert.equal(deletedState.revision, 3);
    assert.deepEqual(
      deletedState.nodes.map((n) => n.id),
      ["input", "output"],
    );
    assert.deepEqual(deletedState.edges, []);
    assert.match(
      new TextDecoder().decode((await reader.read()).value),
      /"revision":3/,
    );
    controller.abort();
    const retained = await fetch(service.url + asset.url);
    assert.equal(retained.status, 200);
    assert.deepEqual(Buffer.from(await retained.arrayBuffer()), bytes);
    const reopenedAfterDelete = new Store(dir);
    try {
      assert.deepEqual(reopenedAfterDelete.get(), deletedState);
      assert.deepEqual(reopenedAfterDelete.assets(), [asset]);
    } finally {
      reopenedAfterDelete.close();
    }
  } finally {
    controller.abort();
    service.close();
    await new Promise((resolve) => service.server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple generation inputs replace incoming dependencies atomically", () => {
  const dir = temp(),
    s = new Store(dir);
  try {
    s.apply({
      operations: ["image-1", "image-2", "image-3"].map((id) => ({
        op: "node.put",
        node: node(id),
      })),
    });
    s.apply({
      operations: [
        { op: "node.inputs", id: "image-3", inputs: ["image-1", "image-2"] },
      ],
    });
    assert.deepEqual(
      s.get().edges.map((e) => [e.source, e.target]),
      [
        ["image-1", "image-3"],
        ["image-2", "image-3"],
      ],
    );
    assert.throws(() =>
      s.apply({
        operations: [{ op: "node.inputs", id: "image-3", inputs: ["missing"] }],
      }),
    );
    assert.equal(s.get().edges.length, 2);
    s.apply({
      operations: [{ op: "node.inputs", id: "image-3", inputs: ["image-2"] }],
    });
    assert.equal(s.get().edges.length, 1);
    assert.throws(() =>
      s.apply({
        operations: [
          { op: "node.put", node: { ...node("text"), type: "text" } },
        ],
      }),
    );
    s.apply({ operations: [{ op: "node.inputs", id: "image-3", inputs: [] }] });
    assert.equal(s.get().edges.length, 0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
