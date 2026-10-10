import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SelectionRegistry } from "../src/selection.js";
import { serveShared } from "../src/server.js";
import {
  createSelectionPublisher,
  selectionReference,
} from "../web/selection-client.js";
const tabA = "aaaaaaaa-1111-1111-1111-111111111111";
const tabB = "bbbbbbbb-1111-1111-1111-111111111111";
const node = (id) => ({
  id,
  type: "image",
  position: { x: 0, y: 0 },
  data: { title: id },
});
function fixture() {
  let now = 1000;
  const state = { nodes: [node("a"), node("b")], edges: [], revision: 1 };
  const registry = new SelectionRegistry(
    { dir: "/tmp/project-a", get: () => state, assets: () => [] },
    { now: () => now, ttl: 100 },
  );
  const update = (overrides = {}) =>
    registry.update({
      sessionId: tabA,
      sequence: 1,
      selectedIds: ["a"],
      revision: state.revision,
      ...overrides,
    });
  return { registry, state, update, advance: (n) => (now += n) };
}
const rejects = (fn, code) => assert.throws(fn, { code });

test("selection distinguishes unavailable, empty, expired and unknown sessions", () => {
  const { registry, update, advance } = fixture();
  rejects(() => registry.get(), "SELECTION_UNAVAILABLE");
  rejects(() => registry.get(tabA), "SELECTION_SESSION_NOT_FOUND");
  update({ selectedIds: [] });
  rejects(() => registry.get(), "SELECTION_EMPTY");
  update({ sequence: 2 });
  assert.deepEqual(registry.get().selectedIds, ["a"]);
  advance(100);
  rejects(() => registry.get(), "SELECTION_EXPIRED");
  rejects(() => registry.get(tabA), "SELECTION_EXPIRED");
  assert.equal(registry.list().sessions[0].status, "expired");
});

test("multiple tabs never choose a winner, including an empty second tab", () => {
  const { registry, update } = fixture();
  update();
  update({ sessionId: tabB, selectedIds: [] });
  rejects(() => registry.get(), "SELECTION_AMBIGUOUS");
  assert.equal(registry.get(tabA).nodes[0].node.id, "a");
  rejects(() => registry.get(tabB), "SELECTION_EMPTY");
  update({ sessionId: tabB, sequence: 2, closed: true, selectedIds: [] });
  assert.equal(registry.get().sessionId, tabA);
});

test("out of order updates cannot overwrite selection or extend freshness", () => {
  const { registry, update, advance } = fixture();
  update({ sequence: 2, selectedIds: ["b", "b"] });
  advance(50);
  rejects(() => update(), "SELECTION_OUT_OF_ORDER");
  rejects(() => update({ sequence: 2 }), "SELECTION_OUT_OF_ORDER");
  assert.deepEqual(registry.get().selectedIds, ["b"]);
  advance(50);
  rejects(() => registry.get(), "SELECTION_EXPIRED");
});

test("deleted selection is all-or-nothing; details use current generation metadata", () => {
  const { registry, update, state } = fixture();
  update({ selectedIds: ["a", "b"] });
  state.nodes[0].data.status = "failed";
  state.revision++;
  assert.equal(registry.get().nodes[0].node.data.status, "failed");
  assert.equal(registry.get().observedRevision, 1);
  assert.equal(registry.get().revision, 2);
  state.nodes.pop();
  rejects(() => registry.get(), "SELECTION_NODE_DELETED");
  rejects(
    () => update({ sequence: 2, selectedIds: ["b"] }),
    "SELECTION_NODE_DELETED",
  );
  rejects(() => update({ sequence: 3, revision: 1 }), "SELECTION_STALE");
  update({ sequence: 4, selectedIds: [] });
  rejects(() => registry.get(), "SELECTION_EMPTY");
});

test("invalid selection input is rejected without changing the registry", () => {
  const { registry, update } = fixture();
  for (const overrides of [
    { sessionId: "x" },
    { sequence: -1 },
    { revision: null },
    { selectedIds: [1] },
    { closed: "yes" },
    { selectedIds: Array(1001).fill("a") },
  ])
    rejects(() => update(overrides), "INVALID_ARGUMENT");
  assert.equal(registry.list().sessions.length, 0);
  rejects(() => registry.get([tabA]), "INVALID_ARGUMENT");
});

test("selection API is isolated by project/token and does not change history", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "canvas-selection-"));
  const service = await serveShared(0, {
    runtimeDir: path.join(dir, "runtime"),
  });
  t.after(async () => {
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = service.openProject(path.join(dir, "a"));
  const b = service.openProject(path.join(dir, "b"));
  const store = service.projects.get(a.id).service.store;
  store.apply({ operations: [{ op: "node.create", node: node("a") }] });
  const before = store.get(),
    history = store.history();
  const post = (endpoint, token, overrides = {}) =>
    fetch(endpoint.url + "/api/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
      body: JSON.stringify({
        sessionId: tabA,
        sequence: 1,
        selectedIds: ["a"],
        revision: before.revision,
        ...overrides,
      }),
    });
  assert.equal((await post(a, b.token)).status, 403);
  assert.equal((await post(a, a.token)).status, 200);
  const get = async (ep, suffix = "") =>
    (await fetch(ep.url + "/api/selection" + suffix)).json();
  assert.equal((await get(a)).nodes[0].node.id, "a");
  assert.equal((await get(b)).code, "SELECTION_UNAVAILABLE");
  assert.equal(
    (await get(b, "?session=" + tabA)).code,
    "SELECTION_SESSION_NOT_FOUND",
  );
  assert.deepEqual(store.get(), before);
  assert.deepEqual(store.history(), history);
  const response = await fetch(a.url + "/api/selection");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    (await post(a, a.token, { sequence: 2, closed: true })).status,
    200,
  );
  assert.equal((await get(a)).code, "SELECTION_EXPIRED");
  await service.closeProject(a.id);
  const reopened = service.openProject(a.project);
  assert.equal((await get(reopened)).code, "SELECTION_UNAVAILABLE");
});

test("publisher allocates unique per-page IDs and sequences before asynchronous token reads", async () => {
  assert.notEqual(
    createSelectionPublisher().sessionId,
    createSelectionPublisher().sessionId,
  );
  const tokens = [],
    posts = [];
  const request = (url, options) =>
    url === "/api/session"
      ? new Promise((resolve) => tokens.push(resolve))
      : (posts.push(JSON.parse(options.body)),
        Promise.resolve(JSON.parse(options.body)));
  const publisher = createSelectionPublisher({ request, sessionId: tabA });
  const ids = ["a"];
  const older = publisher.publish(ids, 1);
  ids.push("b");
  const newer = publisher.publish(["b"], 1);
  tokens[1]({ token: "token" });
  await newer;
  tokens[0]({ token: "token" });
  await older;
  assert.deepEqual(
    posts.map((p) => p.sequence),
    [2, 1],
  );
  assert.deepEqual(posts[1].selectedIds, ["a"]);
  const ref = JSON.parse(
    selectionReference({
      ...posts[0],
      project: "/tmp/a",
      token: "secret",
      expiresAt: 123,
    }),
  );
  assert.equal(ref.sessionId, tabA);
  assert.equal(ref.token, undefined);
});

test("newer rejected updates invalidate prior selection and retain ordering barrier", () => {
  const { registry, update, state } = fixture();
  update();
  state.revision++;
  rejects(
    () => update({ sequence: 3, selectedIds: ["b"], revision: 1 }),
    "SELECTION_STALE",
  );
  rejects(() => registry.get(), "SELECTION_STALE");
  rejects(() => update({ sequence: 2 }), "SELECTION_OUT_OF_ORDER");
  rejects(() => registry.get(), "SELECTION_STALE");
  update({ sequence: 4, selectedIds: ["b"] });
  assert.deepEqual(registry.get().selectedIds, ["b"]);
  rejects(
    () => update({ sequence: 5, selectedIds: ["deleted"] }),
    "SELECTION_NODE_DELETED",
  );
  rejects(() => registry.get(), "SELECTION_NODE_DELETED");
});

test("pagehide dispatches keepalive synchronously using the cached token", async () => {
  const calls = [];
  const publisher = createSelectionPublisher({
    request: async (url, options) => {
      calls.push({ url, options });
      return url === "/api/session" ? { token: "cached" } : {};
    },
  });
  await publisher.publish(["a"], 1);
  calls.length = 0;
  const closing = publisher.publish(["a"], 1, {
    closed: true,
    keepalive: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/selection");
  assert.equal(calls[0].options.keepalive, true);
  assert.equal(calls[0].options.headers["X-Canvas-Token"], "cached");
  await closing;
});
