import test from "node:test";
import assert from "node:assert/strict";
import {
  canvasUrl,
  commitHistory,
  commitOperations,
  openCanvasEvents,
  requestJson,
} from "../web/canvas-client.js";

function setGlobal(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete globalThis[key];
  });
}

test("viewer resolves API paths inside its selected project and supports standalone URLs", () => {
  for (const pathname of [
    "/p/project-a",
    "/p/project-a/",
    "/p/project-a/index.html",
  ])
    assert.equal(
      canvasUrl("/api/history?limit=1", pathname),
      "/p/project-a/api/history?limit=1",
    );
  assert.equal(
    canvasUrl("api/state", "/p/project-b/"),
    "/p/project-b/api/state",
  );
  assert.equal(canvasUrl("/api/state", "/"), "/api/state");
  assert.equal(canvasUrl("/api/state", "/index.html"), "/api/state");
  assert.equal(canvasUrl("/api/state"), "/api/state");
});

test("viewer operations, session, state, history and SSE stay on the tab's project", async (t) => {
  setGlobal(t, "location", { pathname: "/p/project-b/" });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    const body = url.endsWith("/session")
      ? { token: "project-b-token" }
      : { revision: 8 };
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  });
  setGlobal(
    t,
    "EventSource",
    class {
      constructor(url) {
        this.url = url;
      }
    },
  );

  await commitOperations([
    { op: "node.move", id: "photo", position: { x: 100, y: 80 } },
  ]);
  await commitHistory("undo", 8);
  await requestJson("/api/history?limit=1");
  assert.equal(openCanvasEvents().url, "/p/project-b/api/events");
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "/p/project-b/api/session",
      "/p/project-b/api/state",
      "/p/project-b/api/operations",
      "/p/project-b/api/session",
      "/p/project-b/api/history/undo",
      "/p/project-b/api/history?limit=1",
    ],
  );
  for (const { options } of requests.filter(
    ({ options }) => options.method === "POST",
  ))
    assert.equal(options.headers["X-Canvas-Token"], "project-b-token");
});

test("closed projects expose their error without falling back to another canvas", async (t) => {
  setGlobal(t, "location", { pathname: "/p/closed-project/" });
  const requested = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(url);
    return new Response(
      JSON.stringify({ error: "工程未打开", code: "PROJECT_NOT_OPEN" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  });
  await assert.rejects(commitOperations([{ op: "node.delete", id: "photo" }]), {
    message: "工程未打开",
    status: 404,
    code: "PROJECT_NOT_OPEN",
  });
  assert.deepEqual(requested, ["/p/closed-project/api/session"]);
});
