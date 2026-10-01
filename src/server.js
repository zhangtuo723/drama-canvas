import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from "node:fs";
import { Store } from "./store.js";
import { queryState } from "./queries.js";
export function createApp(dir) {
  const store = new Store(dir),
    app = express(),
    clients = new Set(),
    token = randomBytes(24).toString("hex");
  app.use((req, res, next) => {
    const host = req.headers.host || "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return res.status(403).json({ error: "Invalid host" });
    if (req.headers.origin && req.headers.origin !== `http://${host}`)
      return res.status(403).json({ error: "Invalid origin" });
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
  app.post("/api/import", async (req, res) => {
    if (typeof req.body.path !== "string" || !path.isAbsolute(req.body.path))
      return res.status(400).json({ error: "需要绝对文件路径" });
    const a = await store.import(req.body.path);
    emit();
    res.json(a);
  });
  app.post("/api/assets/optimize", async (req, res) => {
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
  });
  app.post("/api/shutdown", (req, res) => {
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
  app.use(express.static(fileURLToPath(new URL("../dist/", import.meta.url))));
  app.use((err, req, res, next) =>
    res
      .status(err.status || 400)
      .json({ error: err.message, code: err.code || "BAD_REQUEST" }),
  );
  return {
    app,
    store,
    token,
    close() {
      clearInterval(timer);
      for (const c of clients) c.end();
      store.close();
    },
  };
}
export async function serve(dir, port) {
  const project = path.resolve(dir);
  mkdirSync(project, { recursive: true });
  const lock = path.join(project, ".server.lock");
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(readFileSync(lock, "utf8"));
    let active = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        active = true;
      } catch (err) {
        if (err.code !== "ESRCH") active = true;
      }
    }
    if (active) throw new Error("该项目已有服务进程，请先停止旧服务");
    unlinkSync(lock);
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  }
  let service;
  try {
    service = createApp(project);
    const server = await new Promise((resolve, reject) => {
      const s = service.app.listen(port, "127.0.0.1", (err) =>
        err ? reject(err) : resolve(s),
      );
      s.on("error", reject);
    });
    const endpoint = {
      url: `http://127.0.0.1:${server.address().port}`,
      token: service.token,
      pid: process.pid,
    };
    writeFileSync(
      path.join(project, ".server.json"),
      JSON.stringify(endpoint),
      { mode: 0o600 },
    );
    return {
      ...service,
      server,
      ...endpoint,
      close() {
        service.close();
        try {
          unlinkSync(lock);
        } catch {}
        try {
          unlinkSync(path.join(project, ".server.json"));
        } catch {}
      },
    };
  } catch (e) {
    service?.close();
    try {
      unlinkSync(lock);
    } catch {}
    throw e;
  }
}
