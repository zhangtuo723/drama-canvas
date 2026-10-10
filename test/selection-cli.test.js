import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, writeFile, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const binary = path.resolve("src/cli.js");
async function fixture(t, { live = true, wrongProject = false } = {}) {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "selection-cli-")),
  );
  const requests = [];
  const state = {
    response: {
      project: dir,
      projectId: "project-a",
      revision: 7,
      sessionId: "tab-a",
      selectedIds: ["image-a"],
      updatedAt: 100,
      expiresAt: 200,
      nodes: [{ node: { id: "image-a" }, asset: { path: "/current.png" } }],
    },
    error: null,
  };
  let server;
  if (live) {
    server = createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      res.setHeader("Content-Type", "application/json");
      assert.equal(req.headers["x-canvas-token"], "test-token");
      if (req.url === "/api/health") {
        res.end(
          JSON.stringify({
            ok: true,
            service: "drama-canvas",
            project: wrongProject ? path.join(dir, "other") : dir,
            pid: process.pid,
          }),
        );
      } else if (state.error) {
        res.statusCode = 409;
        res.end(
          JSON.stringify({ code: state.error, error: "Selection failed" }),
        );
      } else {
        res.end(JSON.stringify(state.response));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await writeFile(
      path.join(dir, ".server.json"),
      JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}`,
        token: "test-token",
        pid: process.pid,
      }),
    );
  }
  const run = async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [binary, "--project", dir, "selection", ...args],
          {
            cwd: dir,
            env: {
              ...process.env,
              DRAMA_CANVAS_RUNTIME_DIR: path.join(dir, "runtime"),
            },
            timeout: 10000,
          },
        )
      ).stdout,
    );
  t.after(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, requests, state, run };
}

const errorCode = (code, hint) => (error) => {
  const data = JSON.parse(error.stderr);
  assert.equal(data.code, code);
  if (hint) assert.match(data.error, hint);
  return true;
};

test("selection get verifies project health and returns current detail unchanged", async (t) => {
  const { requests, state, run } = await fixture(t);
  assert.deepEqual(await run("get"), state.response);
  assert.deepEqual(requests, [
    { method: "GET", url: "/api/health" },
    { method: "GET", url: "/api/selection" },
  ]);
});

test("selection CLI encodes explicit sessions and lists sessions read-only", async (t) => {
  const { requests, state, run } = await fixture(t);
  await run("get", "--session", "tab /?&");
  assert.equal(requests[1].url, "/api/selection?session=tab+%2F%3F%26");
  state.response = {
    project: state.response.project,
    projectId: "project-a",
    sessions: [],
  };
  assert.deepEqual(await run("sessions"), state.response);
  assert.deepEqual(requests.slice(2), [
    { method: "GET", url: "/api/health" },
    { method: "GET", url: "/api/selection/sessions" },
  ]);
});

test("selection errors keep stable codes and provide recovery instructions", async (t) => {
  const { state, run } = await fixture(t);
  for (const [code, hint] of [
    ["SELECTION_UNAVAILABLE", /选中节点/],
    ["SELECTION_AMBIGUOUS", /selection sessions.*--session/],
    ["SELECTION_EXPIRED", /不要复用/],
    ["SELECTION_SESSION_NOT_FOUND", /selection sessions/],
    ["SELECTION_EMPTY", /选中一个或多个/],
    ["SELECTION_NODE_DELETED", /不要使用旧节点/],
  ]) {
    state.error = code;
    await assert.rejects(run("get"), errorCode(code, hint));
  }
});

for (const command of ["get", "sessions"]) {
  test(`selection ${command} never starts a service or reads offline state`, async (t) => {
    const { dir, run } = await fixture(t, { live: false });
    await assert.rejects(run(command), errorCode("PROJECT_NOT_OPEN", /start/));
    await assert.rejects(access(path.join(dir, "runtime")));
    await assert.rejects(access(path.join(dir, "canvas.sqlite")));
  });
  test(`selection ${command} rejects an endpoint belonging to a different project`, async (t) => {
    const { requests, run } = await fixture(t, { wrongProject: true });
    await assert.rejects(run(command), errorCode("PROJECT_NOT_OPEN"));
    assert.deepEqual(requests, [{ method: "GET", url: "/api/health" }]);
  });
}
