import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import sharp from "sharp";
import { serve } from "../src/server.js";
import { arrange, freePosition } from "../src/layout.js";

const exec = promisify(execFile);
const cli =
  (dir, env = process.env) =>
  async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [path.resolve("src/cli.js"), "--project", dir, ...args],
          { timeout: 20000, env },
        )
      ).stdout,
    );
async function project(t, server = true) {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "canvas-cli-upgrade-")),
  );
  const service = server ? await serve(dir, 0) : null;
  const env = {
    ...process.env,
    DRAMA_CANVAS_RUNTIME_DIR: path.join(dir, "runtime"),
  };
  t.after(async () => {
    if (service) {
      service.close();
      service.server.closeAllConnections();
      await new Promise((r) => service.server.close(r));
    }
    if (!service) await cli(dir, env)("server", "stop").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, service, run: cli(dir, env) };
}
async function picture(dir, name, background = "green") {
  const file = path.join(dir, name + ".png");
  await sharp({ create: { width: 600, height: 400, channels: 3, background } })
    .png()
    .toFile(file);
  return file;
}
const errorCode = (code) => (error) => {
  assert.equal(JSON.parse(error.stderr).code, code);
  return true;
};

test("CLI auto import/place, targeted inspection, generation identity and stale inputs work together", async (t) => {
  const { dir, service, run } = await project(t);
  const source = await picture(dir, "source");
  await assert.rejects(run("--unknown-flag"), errorCode("INVALID_ARGUMENT"));
  const output = await picture(dir, "output", "blue");
  const added = await run("node", "add", "--file", source, "--title", "草原");
  const id = added.node.id;
  assert.ok(id);
  assert.equal(added.nodes, undefined);
  assert.deepEqual(added.node.style, { width: 320, height: 253 });
  await assert.rejects(
    run("node", "add", "--id", id, "--title", "不应覆盖"),
    errorCode("NODE_EXISTS"),
  );
  assert.equal((await run("node", "get", id)).node.data.title, "草原");
  const child = (await run("node", "add", "--id", "derived", "--inputs", id))
    .node;
  assert.notDeepEqual(child.position, added.node.position);
  const started = await run(
    "generation",
    "start",
    "derived",
    "--prompt",
    "参考草原生成婚纱照",
    "--tool",
    "external-test",
  );
  const generationId = started.node.data.generation.id;
  await assert.rejects(
    run(
      "generation",
      "complete",
      "derived",
      "--file",
      output,
      "--generation-id",
      "old-job",
    ),
    errorCode("GENERATION_CONFLICT"),
  );
  assert.equal(
    (await run("node", "get", "derived")).node.data.status,
    "running",
  );
  await run(
    "generation",
    "complete",
    "derived",
    "--file",
    output,
    "--generation-id",
    generationId,
  );
  const inspected = await run("inspect", "--node", "derived");
  assert.equal(inspected.node.data.stale, false);
  assert.equal(inspected.inputs[0].nodeId, id);
  assert.equal(
    inspected.generationInputs[0].asset.id,
    inspected.inputs[0].asset.id,
  );
  assert.deepEqual(
    await readFile(inspected.inputs[0].asset.path),
    await readFile(source),
  );
  await run("node", "update", id, "--file", output);
  assert.equal(
    (await run("inspect", "--node", "derived")).node.data.stale,
    true,
  );
  assert.equal((await run("inspect", "--summary")).stale, 1);
  const paged = await run(
    "inspect",
    "--type",
    "image",
    "--limit",
    "1",
    "--offset",
    "1",
  );
  assert.equal(paged.total, 2);
  assert.equal(paged.nodes.length, 1);
  assert.equal(paged.assets, undefined);
  await assert.rejects(
    run("inspect", "--type", "text"),
    errorCode("INVALID_ARGUMENT"),
  );
  const thumb = await fetch(
    service.url + inspected.inputs[0].asset.thumbnailUrl,
  );
  assert.equal(thumb.status, 200);
  assert.match(thumb.headers.get("content-type"), /image\/webp/);
  const metadata = await sharp(
    Buffer.from(await thumb.arrayBuffer()),
  ).metadata();
  assert.equal(metadata.width, 480);
});

test("CLI history restores removed dependencies, layout affects only requested nodes, view emits without editing", async (t) => {
  const { service, run } = await project(t);
  for (const id of ["a", "b", "untouched"])
    await run("node", "add", "--id", id, "--x", "100", "--y", "100");
  await run("node", "inputs", "b", "a");
  const before = await run("inspect");
  const history = await run("history", "--limit", "1");
  await assert.rejects(run("layout"), errorCode("INVALID_ARGUMENT"));
  await run(
    "layout",
    "a",
    "b",
    "--mode",
    "dependencies",
    "--x",
    "0",
    "--y",
    "0",
  );
  const laid = await run("inspect");
  assert.deepEqual(
    laid.nodes.find((n) => n.id === "untouched"),
    before.nodes.find((n) => n.id === "untouched"),
  );
  assert.ok(
    laid.nodes.find((n) => n.id === "b").position.x >
      laid.nodes.find((n) => n.id === "a").position.x,
  );
  await run("node", "delete", "a");
  assert.equal((await run("inspect")).edges.length, 0);
  await run("undo");
  assert.equal((await run("inspect")).edges.length, 1);
  await run("redo");
  assert.equal((await run("inspect")).nodes.length, 2);
  await run("restore", String(history.entries[0].id));
  const restored = await run("inspect");
  assert.equal(restored.edges.length, 1);
  assert.deepEqual(restored.nodes, before.nodes);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const events = await fetch(service.url + "/api/events", {
    signal: controller.signal,
  });
  const reader = events.body.getReader();
  await reader.read();
  const reply = await run("view", "fit", "a", "b");
  assert.equal(reply.delivered, 1);
  const event = new TextDecoder().decode((await reader.read()).value);
  assert.match(event, /event: view/);
  assert.match(event, /"ids":\["a","b"\]/);
  assert.equal((await run("inspect", "--summary")).revision, restored.revision);
  controller.abort();
});

test("detached CLI lifecycle handles occupied ports, duplicate start, restart, stop, and offline inspection", async (t) => {
  const { dir, run } = await project(t, false);
  const occupied = createServer((req, res) => res.end("occupied"));
  await new Promise((r) => occupied.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => occupied.close(r)));
  // Register this before assertions so a failed assertion cannot leave a server behind.
  t.after(async () => {
    try {
      await run("server", "stop");
    } catch {}
  });
  try {
    const first = await run("start", "--port", String(occupied.address().port));
    assert.notEqual(Number(new URL(first.url).port), occupied.address().port);
    assert.equal(first.service, "drama-canvas");
    assert.equal(first.project, dir);
    const again = await run("start");
    assert.equal(again.pid, first.pid);
    assert.equal(again.alreadyRunning, true);
    await run("node", "add", "--id", "preserved");
    const next = await run("restart");
    assert.equal(next.pid, first.pid);
    assert.equal(next.url, first.url);
    assert.equal((await run("status")).ok, true);
    assert.equal((await run("stop")).stopped, true);
    assert.equal((await run("stop")).stopped, false);
    assert.equal(
      (await run("inspect", "--node", "preserved")).node.id,
      "preserved",
    );
    await assert.rejects(
      run("start", "--port", "-1"),
      errorCode("INVALID_ARGUMENT"),
    );
  } finally {
    try {
      await run("server", "stop");
    } catch {}
  }
});

test("layout respects mixed aspect ratios and detects a cyclic dependency graph", () => {
  const nodes = [
    {
      id: "portrait",
      position: { x: 0, y: 0 },
      style: { width: 200, height: 700 },
    },
    {
      id: "wide",
      position: { x: 0, y: 0 },
      style: { width: 600, height: 200 },
    },
    {
      id: "next",
      position: { x: 0, y: 0 },
      style: { width: 320, height: 200 },
    },
  ];
  const grid = arrange(nodes, [], { columns: 2, gap: 50 });
  assert.deepEqual(
    grid.map((n) => n.position),
    [
      { x: 0, y: 0 },
      { x: 250, y: 0 },
      { x: 0, y: 750 },
    ],
  );
  const placed = freePosition(nodes, 320, 260);
  assert.ok(placed.x >= 640 || placed.y >= 740);
  assert.throws(
    () =>
      arrange(
        nodes,
        [
          { source: "portrait", target: "wide" },
          { source: "wide", target: "portrait" },
        ],
        { mode: "dependencies" },
      ),
    /环路/,
  );
});
