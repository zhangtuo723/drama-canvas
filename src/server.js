import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import {
  canonicalProject,
  projectId,
  runtimeFiles,
  readJson,
  writeJson,
  acquireLock,
  removeOwned,
} from "./runtime.js";
import { Store } from "./store.js";
import { queryState } from "./queries.js";
const fail = (message, code, status = 409) =>
  Object.assign(new Error(message), { code, status });
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
function trustedRequest(req, res, next) {
  const host = req.headers.host || "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
    return res.status(403).json({ error: "Invalid host" });
  if (req.headers.origin && req.headers.origin !== `http://${host}`)
    return res.status(403).json({ error: "Invalid origin" });
  next();
}
function prefixMedia(value, prefix) {
  if (!prefix || !value || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => prefixMedia(item, prefix));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      ["url", "thumbnailUrl"].includes(key) &&
      typeof item === "string" &&
      /^\/(assets|thumbnails)\//.test(item)
        ? prefix + item
        : prefixMedia(item, prefix),
    ]),
  );
}
export function createApp(dir, { prefix = "", health = {} } = {}) {
  const store = new Store(dir),
    app = express(),
    clients = new Set(),
    token = randomBytes(24).toString("hex");
  let pending = 0,
    closed = false;
  const drainWaiters = new Set();
  const track = (handler) => async (req, res, next) => {
    pending++;
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    } finally {
      pending--;
      if (!pending) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    }
  };
  app.use(trustedRequest);
  app.use((req, res, next) => {
    if (closed)
      return res
        .status(404)
        .json({ error: "工程已关闭", code: "PROJECT_NOT_OPEN" });
    if (prefix) {
      const json = res.json.bind(res);
      res.json = (value) => json(prefixMedia(value, prefix));
    }
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-canvas-token"] !== token
    )
      return res.status(403).json({ error: "Invalid token" });
    next();
  });
  app.use(express.json({ limit: "4mb" }));
  app.get("/api/session", (_, res) =>
    res.set("Cache-Control", "no-store").json({ token }),
  );
  app.get("/api/state", (req, res) =>
    res.json(queryState(store.get(), store.assets(), store.dir, req.query)),
  );
  app.get("/api/health", (_, res) =>
    res.json({
      ok: true,
      service: "drama-canvas",
      apiVersion: 1,
      project: store.dir,
      pid: process.pid,
      ...health,
    }),
  );
  const emit = () => {
    for (const c of clients)
      c.write(
        "data: " + JSON.stringify({ revision: store.get().revision }) + "\n\n",
      );
  };
  app.post("/api/operations", (req, res) => {
    const s = store.apply(req.body);
    emit();
    res.json(s);
  });
  app.get("/api/history", (req, res) =>
    res.json(
      store.history({
        limit: Number(req.query.limit ?? 20),
        offset: Number(req.query.offset ?? 0),
      }),
    ),
  );
  for (const action of ["undo", "redo", "restore"])
    app.post("/api/history/" + action, (req, res) => {
      const state =
        action === "restore"
          ? store.restore(req.body.id, req.body)
          : store[action](req.body);
      emit();
      res.json(state);
    });
  app.post("/api/view", (req, res) => {
    const { action, ids = [], requestId = randomUUID() } = req.body;
    if (
      !["fit", "focus"].includes(action) ||
      !Array.isArray(ids) ||
      typeof requestId !== "string" ||
      !requestId.length ||
      !ids.every((id) => typeof id === "string") ||
      (action === "focus" && !ids.length)
    )
      return res.status(400).json({
        error: "需要 fit 或 focus 及有效节点 ID",
        code: "INVALID_ARGUMENT",
      });
    const nodeIds = new Set(store.get().nodes.map((n) => n.id));
    if (ids.some((id) => !nodeIds.has(id)))
      return res
        .status(404)
        .json({ error: "聚焦节点不存在", code: "NODE_NOT_FOUND" });
    for (const client of clients)
      client.write(
        "event: view\ndata: " +
          JSON.stringify({ action, ids: [...new Set(ids)], requestId }) +
          "\n\n",
      );
    res.json({ ok: true, delivered: clients.size, requestId });
  });
  app.post(
    "/api/import",
    track(async (req, res) => {
      if (typeof req.body.path !== "string" || !path.isAbsolute(req.body.path))
        return res.status(400).json({ error: "需要绝对文件路径" });
      const a = await store.import(req.body.path);
      emit();
      res.json(a);
    }),
  );
  app.post(
    "/api/assets/optimize",
    track(async (req, res) => {
      const { ids = [] } = req.body;
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
        return res
          .status(400)
          .json({ error: "ids须为数组", code: "INVALID_ARGUMENT" });
      const assets = store.assets();
      if (ids.some((id) => !assets.some((a) => a.id === id)))
        return res
          .status(404)
          .json({ error: "素材不存在", code: "ASSET_NOT_FOUND" });
      const optimized = [],
        failed = [];
      for (const a of assets.filter((a) => !ids.length || ids.includes(a.id))) {
        try {
          optimized.push(
            await store.import(path.join(store.dir, "assets", a.file), a.name),
          );
        } catch (e) {
          failed.push({
            id: a.id,
            error: e.message,
            code: e.code || "IMPORT_FAILED",
          });
        }
      }
      emit();
      res.json({ ok: !failed.length, optimized, failed });
    }),
  );
  app.post("/api/shutdown", async (req, res) => {
    if (app.locals.closeProject)
      return res.json(await app.locals.closeProject());
    if (!app.locals.shutdown)
      return res.status(409).json({
        error: "当前服务不支持远程停止",
        code: "SHUTDOWN_UNAVAILABLE",
      });
    res.json({ ok: true });
    setTimeout(() => app.locals.shutdown(), 25);
  });
  app.get("/assets/:id", (req, res, next) => {
    if (!req.params.id.startsWith("asset_")) return next();
    const a = store.assets().find((a) => a.id === req.params.id);
    if (!a) return res.sendStatus(404);
    res.type(a.mime).sendFile(path.join(store.dir, "assets", a.file));
  });
  app.get("/thumbnails/:id", (req, res) => {
    const a = store.assets().find((a) => a.id === req.params.id);
    if (!a?.thumbnail) return res.sendStatus(404);
    res
      .type("image/webp")
      .sendFile(path.join(store.dir, "thumbnails", a.thumbnail));
  });
  app.get("/api/events", (req, res) => {
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
  });
  const timer = setInterval(() => {
    for (const c of clients) c.write(": heartbeat\n\n");
  }, 20000);
  timer.unref();
  app.use(express.static(dist));
  app.use((err, req, res, next) =>
    res
      .status(err.status || 400)
      .json({ error: err.message, code: err.code || "BAD_REQUEST" }),
  );
  return {
    app,
    store,
    token,
    get busy() {
      return pending > 0;
    },
    get viewers() {
      return clients.size;
    },
    get pending() {
      return pending;
    },
    drain() {
      return pending
        ? new Promise((resolve) => drainWaiters.add(resolve))
        : Promise.resolve();
    },
    close({ notify = true } = {}) {
      if (closed) return;
      if (pending)
        throw fail("工程正在导入或优化素材，请稍后再关闭", "PROJECT_BUSY");
      closed = true;
      clearInterval(timer);
      for (const c of clients) {
        if (notify) c.write("event: project-closed\ndata: {}\n\n");
        c.end();
      }
      clients.clear();
      store.close();
    },
  };
}
export async function serve(dir, port) {
  const project = canonicalProject(dir, { create: true });
  const instanceId = randomUUID();
  const release = acquireLock(path.join(project, ".server.lock"), {
    instanceId,
  });
  const endpointFile = path.join(project, ".server.json");
  let service, server;
  try {
    service = createApp(project);
    server = await listen(service.app, port);
    const endpoint = {
      url: `http://127.0.0.1:${server.address().port}`,
      token: service.token,
      pid: process.pid,
      instanceId,
    };
    writeJson(endpointFile, endpoint);
    return {
      ...service,
      server,
      ...endpoint,
      close() {
        service.close();
        removeOwned(endpointFile, instanceId);
        release();
      },
    };
  } catch (error) {
    service?.close();
    server?.close();
    removeOwned(endpointFile, instanceId);
    release();
    throw error;
  }
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", (error) =>
      error ? reject(error) : resolve(server),
    );
    server.once("error", reject);
  });
}

export async function serveShared(port, { runtimeDir, restore = true } = {}) {
  const files = runtimeFiles(runtimeDir);
  const instanceId = randomUUID();
  const release = acquireLock(files.lock, { instanceId });
  const app = express(),
    projects = new Map();
  const token = randomBytes(24).toString("hex");
  let server,
    url,
    shuttingDown = false,
    closePromise;
  const previouslyOpen = readJson(files.projects)?.projects || [];
  const restoredFailures = [];
  const summary = (entry) => ({
    id: entry.id,
    project: entry.project,
    url: entry.url,
    name: entry.service.store.get().name,
    viewers: entry.service.viewers,
    pending: entry.service.pending,
  });
  const endpoint = () => ({
    url,
    token,
    pid: process.pid,
    instanceId,
    mode: "shared",
  });
  const persist = () =>
    writeJson(files.projects, {
      version: 1,
      projects: [...projects.values()].map(({ project }) => ({
        path: project,
      })),
    });
  const openProject = (directory, { save = true } = {}) => {
    if (shuttingDown) throw fail("服务正在关闭", "SERVER_STOPPING", 503);
    if (typeof directory !== "string" || !path.isAbsolute(directory))
      throw fail("需要绝对工程路径", "INVALID_ARGUMENT", 400);
    const project = canonicalProject(directory, { create: true });
    const id = projectId(project);
    if (projects.has(id))
      return { ...projects.get(id).endpoint, alreadyOpen: true };
    const releaseProject = acquireLock(path.join(project, ".server.lock"), {
      instanceId,
      code: "LEGACY_SERVER_RUNNING",
      message: "该工程已有服务进程，请先停止旧服务后再打开",
    });
    const projectEndpoint = {
      ...endpoint(),
      id,
      project,
      url: `${url}/p/${id}`,
    };
    let service;
    try {
      service = createApp(project, {
        prefix: `/p/${id}`,
        health: { apiVersion: 2, mode: "shared", id, instanceId },
      });
      projectEndpoint.token = service.token;
      const entry = {
        id,
        project,
        url: projectEndpoint.url,
        endpoint: projectEndpoint,
        service,
        release: releaseProject,
      };
      service.app.locals.closeProject = () => closeProject(id);
      writeJson(path.join(project, ".server.json"), projectEndpoint);
      projects.set(id, entry);
      if (save) persist();
      return { ...projectEndpoint, alreadyOpen: false };
    } catch (error) {
      projects.delete(id);
      service?.close();
      removeOwned(path.join(project, ".server.json"), instanceId);
      releaseProject();
      throw error;
    }
  };
  const closeProject = (id) => {
    const entry = projects.get(id);
    if (!entry) throw fail("工程未打开或已关闭", "PROJECT_NOT_OPEN", 404);
    if (entry.service.busy)
      throw fail("工程正在导入或优化素材，请稍后再关闭", "PROJECT_BUSY");
    // Persist first: a failed disk write must leave the mounted project intact.
    writeJson(files.projects, {
      version: 1,
      projects: [...projects.values()]
        .filter((item) => item.id !== id)
        .map(({ project }) => ({ path: project })),
    });
    entry.service.close();
    projects.delete(id);
    removeOwned(path.join(entry.project, ".server.json"), instanceId);
    entry.release();
    return { ok: true, id, project: entry.project, stopped: true };
  };
  const close = () => {
    if (closePromise) return closePromise;
    shuttingDown = true;
    closePromise = (async () => {
      // Stop accepting connections immediately, but allow active Store imports
      // to finish before closing SQLite or cutting their HTTP responses short.
      const stopped = server
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve();
      server?.closeIdleConnections();
      await Promise.all(
        [...projects.values()].map((entry) => entry.service.drain()),
      );
      for (const entry of projects.values()) {
        // The project remains registered across daemon restarts. End its stream
        // without the permanent-close event so EventSource can reconnect.
        entry.service.close({ notify: false });
        removeOwned(path.join(entry.project, ".server.json"), instanceId);
        entry.release();
      }
      projects.clear();
      if (server) {
        server.closeIdleConnections();
        // Partial request bodies and slow media clients must not keep a stopped
        // daemon alive. This timeout starts only after all media work is safe.
        const forceClose = setTimeout(() => server.closeAllConnections(), 250);
        forceClose.unref();
        await stopped;
        clearTimeout(forceClose);
      }
      removeOwned(files.endpoint, instanceId);
      release();
    })();
    return closePromise;
  };
  app.use(trustedRequest);
  app.use((req, res, next) => {
    if (shuttingDown)
      return res
        .status(503)
        .json({ error: "服务正在关闭", code: "SERVER_STOPPING" });
    next();
  });
  app.use(express.json({ limit: "4mb" }));
  app.get("/api/health", (_, res) =>
    res.json({
      ok: true,
      service: "drama-canvas",
      apiVersion: 2,
      mode: "shared",
      pid: process.pid,
      instanceId,
      projects: projects.size,
      restoredFailures,
    }),
  );
  app.get("/api/session", (_, res) =>
    res.set("Cache-Control", "no-store").json({ token }),
  );
  app.get("/api/projects", (_, res) =>
    res.json({ projects: [...projects.values()].map(summary) }),
  );
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-canvas-token"] !== token
    )
      return res.status(403).json({ error: "Invalid token" });
    next();
  });
  app.post("/api/projects/open", (req, res) =>
    res.json(openProject(req.body.path)),
  );
  app.post("/api/projects/:id/close", (req, res) =>
    res.json(closeProject(req.params.id)),
  );
  app.post("/api/shutdown", (_, res) => {
    res.json({ ok: true });
    setImmediate(() =>
      Promise.resolve(
        app.locals.shutdown ? app.locals.shutdown() : close(),
      ).catch((error) => {
        console.error(
          JSON.stringify({
            error: error.message,
            code: error.code || "SHUTDOWN_FAILED",
          }),
        );
      }),
    );
  });
  app.use("/p/:id", (req, res, next) => {
    const entry = projects.get(req.params.id);
    if (!entry)
      return res
        .status(404)
        .json({ error: "工程未打开或已关闭", code: "PROJECT_NOT_OPEN" });
    entry.service.app(req, res, next);
  });
  app.get("/", (_, res) => {
    const first = projects.values().next().value;
    if (first) return res.redirect(`/p/${first.id}/`);
    res
      .type("html")
      .send(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Drama Canvas</title><body><p>服务已启动，还没有打开的工程。请通过 CLI 打开画布。</p></body></html>',
      );
  });
  app.use(express.static(dist, { index: false }));
  app.use((error, req, res, next) =>
    res
      .status(error.status || 400)
      .json({ error: error.message, code: error.code || "BAD_REQUEST" }),
  );
  try {
    server = await listen(app, port);
    url = `http://127.0.0.1:${server.address().port}`;
    if (restore) {
      for (const entry of previouslyOpen) {
        try {
          // Restoring a saved registration must never recreate a project that
          // the user moved or deleted. Explicit opens may still create one.
          let database;
          try {
            database = statSync(path.join(entry.path, "canvas.sqlite"));
          } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
          }
          if (!database?.isFile())
            throw fail(
              "原工程不存在或 canvas.sqlite 已移走",
              "PROJECT_NOT_FOUND",
              404,
            );
          openProject(entry.path, { save: false });
        } catch (error) {
          restoredFailures.push({
            project: entry.path,
            code: error.code || "OPEN_FAILED",
            error: error.message,
          });
        }
      }
    }
    persist();
    writeJson(files.endpoint, endpoint());
    return {
      app,
      server,
      ...endpoint(),
      projects,
      openProject,
      closeProject,
      close,
      restoredFailures,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
