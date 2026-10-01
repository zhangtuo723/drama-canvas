import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  realpath,
  access,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serve } from "../src/server.js";
const exec = promisify(execFile);
const binary = path.resolve("src/cli.js");
async function fixture(t) {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "shared-cli-")),
  );
  const env = {
    ...process.env,
    DRAMA_CANVAS_RUNTIME_DIR: path.join(dir, "runtime"),
  };
  const run = async (project, ...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [binary, "--project", path.join(dir, project), ...args],
          { env, cwd: dir, timeout: 25000 },
        )
      ).stdout,
    );
  t.after(async () => {
    await run("unused", "server", "stop").catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, env, run };
}
const errorCode = (expected) => (error) => {
  const output = error.stderr || error.stdout;
  assert.equal(JSON.parse(output).code, expected);
  return true;
};

test("CLI automatically opens multiple projects in one daemon and scopes close/restart", async (t) => {
  const { dir, run } = await fixture(t);
  await assert.rejects(
    run("a", "server", "status"),
    errorCode("SERVER_NOT_RUNNING"),
  );
  await run("a", "node", "add", "--id", "photo", "--title", "A");
  await run("b", "node", "add", "--id", "photo", "--title", "B");
  const a = await run("a", "status"),
    b = await run("b", "status");
  assert.equal(a.mode, "shared");
  assert.equal(a.pid, b.pid);
  assert.equal(new URL(a.url).origin, new URL(b.url).origin);
  assert.notEqual(a.url, b.url);
  assert.equal((await run("a", "node", "get", "photo")).node.data.title, "A");
  assert.equal((await run("b", "node", "get", "photo")).node.data.title, "B");
  assert.equal((await run("a", "projects")).projects.length, 2);
  assert.equal((await run("a", "stop")).stopped, true);
  await assert.rejects(run("a", "status"), errorCode("PROJECT_NOT_OPEN"));
  assert.equal((await run("b", "status")).pid, b.pid);
  assert.equal((await run("a", "inspect", "--summary")).nodes, 1);
  assert.ok((await run("a", "history")).entries.length);
  assert.equal((await run("a", "projects")).projects.length, 1);
  const reopen = await run("a", "start");
  assert.equal(reopen.pid, b.pid);
  assert.equal((await run("a", "restart")).pid, b.pid);
  await run("a", "stop");
  const restarted = await run("b", "server", "restart");
  assert.notEqual(restarted.pid, b.pid);
  assert.equal((await run("b", "status")).pid, restarted.pid);
  assert.deepEqual(
    (await run("b", "projects")).projects.map((p) => p.project),
    [path.join(dir, "b")],
  );
  assert.equal((await run("b", "node", "get", "photo")).node.data.title, "B");
  await run("b", "server", "stop");
  assert.equal((await run("b", "inspect", "--summary")).nodes, 1);
  await assert.rejects(
    run("b", "server", "status"),
    errorCode("SERVER_NOT_RUNNING"),
  );
  await run("a", "node", "update", "photo", "--title", "A2");
  assert.equal((await run("a", "projects")).projects.length, 2);
});

test("concurrent CLI starts converge on a single daemon and global start creates no canvas", async (t) => {
  const { dir, run } = await fixture(t);
  const [a, b, c] = await Promise.all(
    ["a", "b", "c"].map((p) => run(p, "start", "--port", "0")),
  );
  assert.equal(a.pid, b.pid);
  assert.equal(b.pid, c.pid);
  assert.equal((await run("a", "projects")).projects.length, 3);
  await run("a", "server", "stop");
  const global = await run("unused", "server", "start", "--port", "0");
  assert.equal(global.mode, "shared");
  await assert.rejects(access(path.join(dir, "unused", "canvas.sqlite")));
});

test("start migrates an authenticated legacy service without losing its canvas", async (t) => {
  const { dir, run } = await fixture(t);
  const old = await serve(path.join(dir, "old"), 0);
  let closed = false;
  const closeOld = () => {
    if (closed) return;
    closed = true;
    old.close();
    old.server.closeAllConnections();
    old.server.close();
  };
  old.app.locals.shutdown = closeOld;
  t.after(closeOld);
  await run("old", "node", "add", "--id", "preserved");
  const started = await run("old", "start", "--port", "0");
  assert.equal(closed, true);
  assert.equal(started.mode, "shared");
  assert.notEqual(started.pid, process.pid);
  assert.equal(
    (await run("old", "node", "get", "preserved")).node.id,
    "preserved",
  );
  assert.equal((await run("old", "projects")).projects.length, 1);
});

test("stale project endpoint pointing to another canvas cannot leak reads or close that canvas", async (t) => {
  const { dir, run } = await fixture(t);
  await run("a", "node", "add", "--id", "own", "--title", "A");
  await run("b", "node", "add", "--id", "other", "--title", "B");
  const other = await readFile(path.join(dir, "b", ".server.json"), "utf8");
  await run("a", "stop");
  await writeFile(path.join(dir, "a", ".server.json"), other);
  assert.equal((await run("a", "inspect")).nodes[0].id, "own");
  assert.equal((await run("a", "stop")).stopped, false);
  assert.equal((await run("b", "status")).ok, true);
  assert.ok((await run("a", "history")).entries.length > 0);
});
