import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  existsSync,
  readdirSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { connect } from "node:net";
import { once } from "node:events";
import { createServer } from "node:http";
import { serve, serveShared } from "../src/server.js";
import {
  canonicalProject,
  projectId,
  readJson,
  writeJson,
  runtimeFiles,
} from "../src/runtime.js";

const node = (id) => ({
  id,
  type: "image",
  position: { x: 0, y: 0 },
  data: { title: id },
});
const post = (url, token, body = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
    body: JSON.stringify(body),
  });
async function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canvas-shared-"));
  const runtimeDir = path.join(dir, "runtime");
  const service = await serveShared(0, { runtimeDir });
  t.after(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, runtimeDir, service };
}
async function picture(dir) {
  const file = path.join(dir, "source.png");
  await sharp({
    create: { width: 32, height: 24, channels: 3, background: "green" },
  })
    .png()
    .toFile(file);
  return file;
}
async function events(t, url) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(url + "/api/events", {
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  await reader.read();
  return {
    reader,
    controller,
    read: async () => new TextDecoder().decode((await reader.read()).value),
  };
}

test("shared daemon isolates projects, assets, tokens and SSE on one port", async (t) => {
  const { dir, service } = await fixture(t);
  const a = service.openProject(path.join(dir, "a"));
  const b = service.openProject(path.join(dir, "b"));
  assert.equal(new URL(a.url).origin, new URL(b.url).origin);
  assert.notEqual(a.token, b.token);
  assert.notEqual(service.token, a.token);
  const health = await (await fetch(service.url + "/api/health")).json();
  assert.equal(health.mode, "shared");
  assert.equal(health.apiVersion, 2);
  assert.equal(health.projects, 2);
  assert.equal(
    (await (await fetch(a.url + "/api/health")).json()).project,
    a.project,
  );
  assert.equal((await post(a.url + "/api/operations", b.token)).status, 403);
  assert.equal(
    (
      await post(service.url + "/api/projects/open", a.token, {
        path: path.join(dir, "forbidden"),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(service.url + "/api/session", {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  for (const item of [a, b]) {
    assert.equal(
      (
        await post(item.url + "/api/operations", item.token, {
          operations: [{ op: "node.put", node: node(item.id) }],
        })
      ).status,
      200,
    );
  }
  const aEvents = await events(t, a.url);
  const bEvents = await events(t, b.url);
  await post(a.url + "/api/view", a.token, {
    action: "fit",
    requestId: "only-a",
  });
  await post(b.url + "/api/view", b.token, {
    action: "fit",
    requestId: "only-b",
  });
  assert.match(await aEvents.read(), /only-a/);
  const bEvent = await bEvents.read();
  assert.match(bEvent, /only-b/);
  assert.doesNotMatch(bEvent, /only-a/);
  const imported = await post(a.url + "/api/import", a.token, {
    path: await picture(dir),
  });
  const asset = await imported.json();
  assert.ok(asset.url.startsWith(`/p/${a.id}/assets/`));
  assert.ok(asset.thumbnailUrl.startsWith(`/p/${a.id}/thumbnails/`));
  assert.equal((await fetch(service.url + asset.url)).status, 200);
  assert.equal((await fetch(service.url + asset.thumbnailUrl)).status, 200);
  assert.equal((await fetch(b.url + "/assets/" + asset.id)).status, 404);
  const state = await (await fetch(a.url + "/api/state")).json();
  assert.equal(state.assets[0].url, asset.url);
  assert.deepEqual(
    state.nodes.map((n) => n.id),
    [a.id],
  );
  assert.deepEqual(
    (await (await fetch(b.url + "/api/state")).json()).nodes.map((n) => n.id),
    [b.id],
  );
  const list = await (await fetch(service.url + "/api/projects")).json();
  assert.equal(list.projects.length, 2);
  assert.ok(list.projects.every((p) => !Object.hasOwn(p, "token")));
  aEvents.controller.abort();
  bEvents.controller.abort();
});

test("project close ends its events, preserves its files and never reopens on GET", async (t) => {
  const { dir, service, runtimeDir } = await fixture(t);
  const a = service.openProject(path.join(dir, "a"));
  const b = service.openProject(path.join(dir, "b"));
  const stream = await events(t, a.url);
  assert.equal((await post(a.url + "/api/shutdown", a.token)).status, 200);
  assert.match(await stream.read(), /project-closed/);
  assert.equal((await stream.reader.read()).done, true);
  assert.equal(existsSync(path.join(a.project, "canvas.sqlite")), true);
  assert.equal(existsSync(path.join(a.project, ".server.json")), false);
  assert.equal(existsSync(path.join(a.project, ".server.lock")), false);
  for (const route of [
    a.url,
    a.url + "/api/state",
    service.url + "/p/unknown/api/state",
  ]) {
    const response = await fetch(route);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "PROJECT_NOT_OPEN");
  }
  assert.equal((await fetch(b.url + "/api/state")).status, 200);
  assert.equal(service.projects.size, 1);
  assert.deepEqual(readJson(runtimeFiles(runtimeDir).projects).projects, [
    { path: b.project },
  ]);
  const root = await fetch(service.url, { redirect: "manual" });
  assert.equal(root.headers.get("location"), `/p/${b.id}/`);
});

test("canonical paths deduplicate symlinks and opened projects survive daemon restart", async (t) => {
  const { dir, service, runtimeDir } = await fixture(t);
  const actual = path.join(dir, "actual");
  mkdirSync(actual);
  const alias = path.join(dir, "alias");
  symlinkSync(actual, alias);
  const a = service.openProject(actual);
  const duplicate = service.openProject(alias);
  assert.equal(a.id, duplicate.id);
  assert.equal(duplicate.alreadyOpen, true);
  assert.equal(service.projects.size, 1);
  assert.equal(
    canonicalProject(path.join(alias, "new")),
    path.join(canonicalProject(actual), "new"),
  );
  assert.equal(projectId(alias), projectId(actual));
  await post(a.url + "/api/operations", a.token, {
    operations: [{ op: "node.put", node: node("retained") }],
  });
  await service.close();
  assert.equal(existsSync(runtimeFiles(runtimeDir).endpoint), false);
  const restarted = await serveShared(0, { runtimeDir });
  t.after(() => restarted.close());
  assert.equal(restarted.projects.size, 1);
  const recovered = [...restarted.projects.values()][0];
  assert.equal(recovered.id, a.id);
  assert.notEqual(recovered.endpoint.token, a.token);
  assert.equal(
    (await (await fetch(recovered.url + "/api/state")).json()).nodes[0].id,
    "retained",
  );
  await restarted.close();
});

test("global and project locks prevent duplicate services and cleanup respects ownership", async (t) => {
  const { dir, service, runtimeDir } = await fixture(t);
  await assert.rejects(serveShared(0, { runtimeDir }), {
    code: "SERVER_ALREADY_RUNNING",
  });
  const project = path.join(dir, "legacy");
  const legacy = await serve(project, 0);
  t.after(async () => {
    legacy.close();
    await new Promise((resolve) => legacy.server.close(resolve));
  });
  assert.throws(() => service.openProject(project), {
    code: "LEGACY_SERVER_RUNNING",
  });
  assert.equal((await fetch(legacy.url + "/api/health")).status, 200);
  const a = service.openProject(path.join(dir, "shared"));
  const replacement = { pid: process.pid, instanceId: "replacement-owner" };
  for (const file of [
    runtimeFiles(runtimeDir).endpoint,
    runtimeFiles(runtimeDir).lock,
    path.join(a.project, ".server.json"),
    path.join(a.project, ".server.lock"),
  ])
    writeJson(file, replacement);
  await service.close();
  for (const file of [
    runtimeFiles(runtimeDir).endpoint,
    runtimeFiles(runtimeDir).lock,
    path.join(a.project, ".server.json"),
    path.join(a.project, ".server.lock"),
  ])
    assert.deepEqual(readJson(file), replacement);
  legacy.close();
  await new Promise((resolve) => legacy.server.close(resolve));
});

test("busy projects reject close and global shutdown drains an in-flight media import", async (t) => {
  const { dir, service } = await fixture(t);
  const a = service.openProject(path.join(dir, "a"));
  const entry = service.projects.get(a.id);
  const original = entry.service.store.import.bind(entry.service.store);
  let releaseImport, markEntered;
  const gate = new Promise((resolve) => {
    releaseImport = resolve;
  });
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  entry.service.store.import = async (...args) => {
    markEntered();
    await gate;
    return original(...args);
  };
  const importing = post(a.url + "/api/import", a.token, {
    path: await picture(dir),
  });
  await entered;
  const rejected = await post(
    service.url + `/api/projects/${a.id}/close`,
    service.token,
  );
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, "PROJECT_BUSY");
  assert.equal((await fetch(a.url + "/api/state")).status, 200);
  const closing = service.close();
  try {
    assert.equal((await fetch(a.url + "/api/state")).status, 503);
  } catch (error) {
    assert.match(error.message, /fetch failed/);
  } finally {
    releaseImport();
  }
  assert.equal((await importing).status, 200);
  await closing;
  await assert.rejects(fetch(service.url + "/api/health"));
  assert.equal(existsSync(path.join(a.project, "canvas.sqlite")), true);
});

test(
  "concurrent daemon starts reclaim a stale lock without launching two servers",
  { timeout: 20000 },
  async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "canvas-stale-lock-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const files = runtimeFiles(dir);
    const deadPid = Number(
      execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(String(process.pid))"],
        { encoding: "utf8" },
      ),
    );
    writeJson(files.lock, { pid: deadPid, instanceId: "dead-daemon" });
    const script = `
    const { serveShared } = await import(process.argv[1]);
    let service;
    process.stdin.once("data", async () => {
      try {
        service = await serveShared(0, { runtimeDir: process.argv[2] });
        console.log(JSON.stringify({ acquired: true, pid: process.pid, url: service.url }));
      } catch (error) { console.log(JSON.stringify({ acquired: false, code: error.code })); }
    });
    process.stdin.once("end", async () => { await service?.close(); });
    process.stdin.resume();
    console.log("ready");
  `;
    const children = Array.from({ length: 12 }, () => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          script,
          pathToFileURL(path.resolve("src/server.js")).href,
          dir,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      t.after(() => child.kill());
      const lines = createInterface({ input: child.stdout })[
        Symbol.asyncIterator
      ]();
      return { child, lines };
    });
    const ready = await Promise.all(children.map(({ lines }) => lines.next()));
    assert.ok(ready.every((line) => line.value === "ready"));
    for (const { child } of children) child.stdin.write("start\n");
    const results = await Promise.all(
      children.map(async ({ lines }) => JSON.parse((await lines.next()).value)),
    );
    const winners = results.filter((result) => result.acquired);
    assert.equal(winners.length, 1);
    assert.equal(readJson(files.lock).pid, winners[0].pid);
    assert.equal(
      (await (await fetch(winners[0].url + "/api/health")).json()).pid,
      winners[0].pid,
    );
    assert.ok(
      results
        .filter((result) => !result.acquired)
        .every((result) => result.code === "SERVER_ALREADY_RUNNING"),
    );
    const stopped = children.map(({ child }) => once(child, "close"));
    for (const { child } of children) child.stdin.end();
    await Promise.all(stopped);
    assert.equal(existsSync(files.lock), false);
    assert.equal(existsSync(files.lock + ".reclaim"), false);
  },
);

test(
  "shared shutdown closes partial HTTP requests and exposes restore failures",
  { timeout: 5000 },
  async (t) => {
    const { service, runtimeDir } = await fixture(t);
    const socket = connect(Number(new URL(service.url).port), "127.0.0.1");
    t.after(() => socket.destroy());
    await once(socket, "connect");
    socket.write(
      `POST /api/projects/open HTTP/1.1\r\nHost: ${new URL(service.url).host}\r\nX-Canvas-Token: ${service.token}\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{`,
    );
    const health = await (await fetch(service.url + "/api/health")).json();
    assert.deepEqual(health.restoredFailures, []);
    await service.close();
    assert.equal(existsSync(runtimeFiles(runtimeDir).endpoint), false);
  },
);

test("occupied port releases the shared daemon lock so startup can retry", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canvas-shared-port-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const occupied = createServer((req, res) => res.end("occupied"));
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  await assert.rejects(
    serveShared(occupied.address().port, { runtimeDir: dir }),
    { code: "EADDRINUSE" },
  );
  assert.equal(existsSync(runtimeFiles(dir).lock), false);
  assert.equal(existsSync(runtimeFiles(dir).endpoint), false);
  const retry = await serveShared(0, { runtimeDir: dir });
  t.after(() => retry.close());
  assert.equal((await fetch(retry.url + "/api/health")).status, 200);
  await retry.close();
});

test("daemon restore reports missing projects without recreating directories or databases", async (t) => {
  const { dir, service, runtimeDir } = await fixture(t);
  const removed = service.openProject(path.join(dir, "removed"));
  const databaseRemoved = service.openProject(
    path.join(dir, "database-removed"),
  );
  const retained = service.openProject(path.join(dir, "retained"));
  await service.close();
  rmSync(removed.project, { recursive: true, force: true });
  rmSync(path.join(databaseRemoved.project, "canvas.sqlite"));
  const originalFiles = readdirSync(databaseRemoved.project);
  const restarted = await serveShared(0, { runtimeDir });
  t.after(() => restarted.close());
  assert.deepEqual([...restarted.projects.keys()], [retained.id]);
  assert.deepEqual(
    restarted.restoredFailures.map(({ project, code }) => ({ project, code })),
    [
      { project: removed.project, code: "PROJECT_NOT_FOUND" },
      { project: databaseRemoved.project, code: "PROJECT_NOT_FOUND" },
    ],
  );
  const health = await (await fetch(restarted.url + "/api/health")).json();
  assert.deepEqual(health.restoredFailures, restarted.restoredFailures);
  assert.equal(existsSync(removed.project), false);
  assert.equal(
    existsSync(path.join(databaseRemoved.project, "canvas.sqlite")),
    false,
  );
  assert.deepEqual(readdirSync(databaseRemoved.project), originalFiles);
  const explicitlyOpened = restarted.openProject(removed.project);
  assert.equal(explicitlyOpened.id, removed.id);
  assert.equal(existsSync(path.join(removed.project, "canvas.sqlite")), true);
  await restarted.close();
});

test("daemon shutdown ends SSE without permanently closing registered projects", async (t) => {
  const { dir, service, runtimeDir } = await fixture(t);
  const project = service.openProject(path.join(dir, "persistent"));
  const stream = await events(t, project.url);
  assert.equal(
    (await post(service.url + "/api/shutdown", service.token)).status,
    200,
  );
  let received = "";
  for (;;) {
    const chunk = await stream.reader.read();
    if (chunk.done) break;
    received += new TextDecoder().decode(chunk.value);
  }
  assert.doesNotMatch(received, /project-closed/);
  await service.close();
  const restarted = await serveShared(Number(new URL(service.url).port), {
    runtimeDir,
  });
  t.after(() => restarted.close());
  assert.equal(restarted.projects.has(project.id), true);
  const restored = restarted.projects.get(project.id);
  assert.equal(restored.url, project.url);
  const reconnected = await events(t, restored.url);
  await post(restored.url + "/api/view", restored.endpoint.token, {
    action: "fit",
    requestId: "after-restart",
  });
  assert.match(await reconnected.read(), /after-restart/);
  assert.equal(
    (await post(restored.url + "/api/shutdown", restored.endpoint.token))
      .status,
    200,
  );
  assert.match(await reconnected.read(), /project-closed/);
  assert.equal((await reconnected.reader.read()).done, true);
  await restarted.close();
});
