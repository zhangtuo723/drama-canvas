import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const idSchema = z.string().min(1).max(120);
const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
const styleSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});
const generationSchema = z.object({
  id: z.string().min(1),
  startedAt: z.string(),
  prompt: z.string(),
  tool: z.string().min(1),
  inputs: z.array(
    z.object({
      nodeId: idSchema,
      assetId: z.string().min(1),
      generationId: z.string().optional(),
    }),
  ),
  completedAt: z.string().optional(),
  failedAt: z.string().optional(),
  outputAssetId: z.string().optional(),
  error: z.string().optional(),
});
const nodeSchema = z.object({
  id: idSchema,
  type: z.enum(["image", "video"]),
  position: positionSchema,
  data: z.object({
    title: z.string().max(500),
    assetId: z.string().min(1).optional(),
    generation: generationSchema.optional(),
    status: z.enum(["pending", "running", "ready", "failed"]).optional(),
  }),
  style: styleSchema.optional(),
});
const patchSchema = z
  .object({
    title: nodeSchema.shape.data.shape.title.optional(),
    assetId: z.string().min(1).nullable().optional(),
    type: nodeSchema.shape.type.optional(),
    position: positionSchema.partial().optional(),
    style: styleSchema.partial().optional(),
  })
  .strict();
const writeSchema = z.object({
  requestId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative().optional(),
});
const edgeSchema = z.object({
  id: z.string().min(1).optional(),
  source: idSchema,
  target: idSchema,
});
const dependencyId = (source, target) =>
  "dependency:" + JSON.stringify([source, target]);
const fail = (code, message, status = 400) =>
  Object.assign(new Error(message), { code, status });
function guarded(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof z.ZodError) throw fail("VALIDATION_ERROR", e.message);
    throw e;
  }
}
// Key order is insignificant; operation order and every supplied semantic field
// remain significant. The envelope deliberately excludes revision/requestId.
function requestFingerprint(operation) {
  const ordered = (value) => {
    if (Array.isArray(value)) return value.map(ordered);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])]),
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(ordered(operation)))
    .digest("hex");
}
function normalizeEdges(edges) {
  const byPair = new Map();
  for (const edge of edges) {
    const id = dependencyId(edge.source, edge.target);
    if (!byPair.has(id))
      byPair.set(id, { id, source: edge.source, target: edge.target });
  }
  return [...byPair.values()];
}
// Computed flags never enter persisted snapshots or generation provenance.
function decorate(state) {
  const s = structuredClone(state);
  const nodes = new Map(s.nodes.map((node) => [node.id, node]));
  const incoming = new Map(s.nodes.map((node) => [node.id, []]));
  for (const edge of s.edges) incoming.get(edge.target)?.push(edge.source);
  const memo = new Map(),
    visiting = new Set();
  const isStale = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return true;
    const node = nodes.get(id);
    if (!node) return true;
    visiting.add(id);
    const sources = incoming.get(id) || [];
    const generation = node.data.generation;
    let stale = false;
    if (generation) {
      const snapshots = new Map(
        generation.inputs.map((input) => [input.nodeId, input]),
      );
      stale =
        sources.length !== snapshots.size ||
        sources.some((source) => {
          const current = nodes.get(source),
            saved = snapshots.get(source);
          return (
            !current ||
            !saved ||
            current.data.assetId !== saved.assetId ||
            current.data.generation?.id !== saved.generationId
          );
        });
      if (
        generation.outputAssetId &&
        generation.outputAssetId !== node.data.assetId
      )
        stale = true;
    }
    // Propagate changed upstream input even when this node predates provenance support.
    stale ||= sources.some((source) => isStale(source));
    visiting.delete(id);
    memo.set(id, stale);
    return stale;
  };
  for (const node of s.nodes) {
    delete node.data.stale;
    delete node.data.provenanceUnknown;
    if (node.data.generation || (incoming.get(node.id)?.length ?? 0) > 0) {
      node.data.stale = isStale(node.id);
      if (!node.data.generation) node.data.provenanceUnknown = true;
    }
  }
  return s;
}

export class Store {
  constructor(dir) {
    this.dir = path.resolve(dir);
    mkdirSync(path.join(this.dir, "assets"), { recursive: true });
    this.db = new Database(path.join(this.dir, "canvas.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS canvas_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        action TEXT NOT NULL,
        revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS canvas_history_cursor (id INTEGER PRIMARY KEY, history_id INTEGER NOT NULL);
    `);
    this.db.transaction(() => {
      if (
        !this.db
          .pragma("table_info(requests)")
          .some((column) => column.name === "fingerprint")
      )
        this.db.exec("ALTER TABLE requests ADD COLUMN fingerprint TEXT");
      this.pruneRequests();
      if (!this.db.prepare("SELECT value FROM state WHERE id=1").get())
        this.db.prepare("INSERT INTO state VALUES (1,?)").run(
          JSON.stringify({
            name: path.basename(this.dir),
            revision: 0,
            nodes: [],
            edges: [],
          }),
        );
      // Existing projects retain their current canvas as the first recoverable version.
      const s = this.raw();
      s.edges = normalizeEdges(s.edges);
      this.save(s);
      if (
        !this.db
          .prepare("SELECT history_id FROM canvas_history_cursor WHERE id=1")
          .get()
      ) {
        const row = this.db
          .prepare(
            "INSERT INTO canvas_history(created_at,action,revision,snapshot) VALUES (?,?,?,?)",
          )
          .run(
            new Date().toISOString(),
            "initial",
            s.revision,
            JSON.stringify(s),
          );
        this.db
          .prepare("INSERT INTO canvas_history_cursor VALUES (1,?)")
          .run(Number(row.lastInsertRowid));
      }
    })();
  }
  raw() {
    return JSON.parse(
      this.db.prepare("SELECT value FROM state WHERE id=1").get().value,
    );
  }
  get() {
    return decorate(this.raw());
  }
  save(state) {
    this.db
      .prepare("UPDATE state SET value=? WHERE id=1")
      .run(JSON.stringify(state));
  }
  assets() {
    return this.db
      .prepare("SELECT value FROM assets")
      .all()
      .map((row) => JSON.parse(row.value));
  }
  async import(file, name = path.basename(file)) {
    const { importMedia } = await import("./media.js");
    const asset = await importMedia(this.dir, file, name);
    return this.db.transaction(() => {
      this.db
        .prepare("INSERT OR IGNORE INTO assets VALUES (?,?)")
        .run(asset.id, JSON.stringify(asset));
      const existing = JSON.parse(
        this.db.prepare("SELECT value FROM assets WHERE id=?").get(asset.id)
          .value,
      );
      if (existing.mime !== asset.mime)
        throw fail(
          "ASSET_METADATA_CONFLICT",
          "已有素材的类型与文件检测结果不一致: " + asset.id,
          409,
        );
      const merged = { ...existing };
      for (const key of [
        "width",
        "height",
        "duration",
        "thumbnail",
        "thumbnailUrl",
      ])
        if (asset[key] !== undefined) merged[key] = asset[key];
      this.db
        .prepare("UPDATE assets SET value=? WHERE id=?")
        .run(JSON.stringify(merged), asset.id);
      return merged;
    })();
  }
  node(state, id) {
    const node = state.nodes.find((entry) => entry.id === id);
    if (!node) throw fail("NODE_NOT_FOUND", "节点不存在: " + id, 404);
    return node;
  }
  validate(state) {
    state.nodes = state.nodes.map((node) => nodeSchema.parse(node));
    const nodes = new Map();
    const assets = new Map(this.assets().map((asset) => [asset.id, asset]));
    for (const node of state.nodes) {
      if (nodes.has(node.id))
        throw fail("NODE_EXISTS", "节点 ID 已存在: " + node.id, 409);
      nodes.set(node.id, node);
      if (node.data.assetId) {
        const asset = assets.get(node.data.assetId);
        if (!asset)
          throw fail(
            "ASSET_NOT_FOUND",
            "素材不存在: " + node.data.assetId,
            404,
          );
        if (!asset.mime.startsWith(node.type + "/"))
          throw fail(
            "ASSET_TYPE_MISMATCH",
            "节点类型与素材类型不匹配: " + node.id,
          );
      }
    }
    state.edges = normalizeEdges(
      state.edges.map((edge) => edgeSchema.parse(edge)),
    );
    const incoming = new Map(state.nodes.map((node) => [node.id, 0]));
    const outgoing = new Map(state.nodes.map((node) => [node.id, []]));
    for (const edge of state.edges) {
      if (!nodes.has(edge.source) || !nodes.has(edge.target))
        throw fail("EDGE_ENDPOINT_NOT_FOUND", "连线端点不存在");
      if (edge.source === edge.target)
        throw fail("SELF_DEPENDENCY", "节点不能依赖自身");
      incoming.set(edge.target, incoming.get(edge.target) + 1);
      outgoing.get(edge.source).push(edge.target);
    }
    const queue = [...incoming.keys()].filter((id) => incoming.get(id) === 0);
    for (let i = 0; i < queue.length; i++) {
      for (const target of outgoing.get(queue[i])) {
        incoming.set(target, incoming.get(target) - 1);
        if (incoming.get(target) === 0) queue.push(target);
      }
    }
    if (queue.length !== nodes.size)
      throw fail("DEPENDENCY_CYCLE", "生成依赖不能形成循环");
  }
  inputSnapshots(state, id) {
    const evaluated = new Map(
      decorate(state).nodes.map((node) => [node.id, node]),
    );
    return normalizeEdges(state.edges)
      .filter((edge) => edge.target === id)
      .map((edge) => {
        const node = this.node(state, edge.source);
        if (!node.data.assetId)
          throw fail("INPUT_NOT_READY", "输入节点尚无素材: " + node.id, 409);
        if (
          ["running", "failed"].includes(node.data.status) ||
          evaluated.get(node.id)?.data.stale
        )
          throw fail(
            "INPUT_NOT_READY",
            "输入节点正在生成、生成失败或结果已过期: " + node.id,
            409,
          );
        return {
          nodeId: node.id,
          assetId: node.data.assetId,
          ...(node.data.generation?.id
            ? { generationId: node.data.generation.id }
            : {}),
        };
      });
  }
  remember(state, action) {
    const cursor = this.db
      .prepare("SELECT history_id FROM canvas_history_cursor WHERE id=1")
      .get().history_id;
    this.db.prepare("DELETE FROM canvas_history WHERE id>?").run(cursor);
    const row = this.db
      .prepare(
        "INSERT INTO canvas_history(created_at,action,revision,snapshot) VALUES (?,?,?,?)",
      )
      .run(
        new Date().toISOString(),
        action,
        state.revision,
        JSON.stringify(state),
      );
    this.db
      .prepare("UPDATE canvas_history_cursor SET history_id=? WHERE id=1")
      .run(Number(row.lastInsertRowid));
    this.db
      .prepare(
        "DELETE FROM canvas_history WHERE id NOT IN (SELECT id FROM canvas_history ORDER BY id DESC LIMIT 100)",
      )
      .run();
  }
  pruneRequests() {
    // The latest 500 successful writes form the bounded idempotency window.
    this.db
      .prepare(
        "DELETE FROM requests WHERE rowid NOT IN (SELECT rowid FROM requests ORDER BY rowid DESC LIMIT 500)",
      )
      .run();
  }
  write(input, operation, mutate) {
    return guarded(() =>
      this.db.transaction(() => {
        const body = writeSchema.parse(input);
        const fingerprint = body.requestId
          ? requestFingerprint(operation)
          : undefined;
        if (body.requestId) {
          const old = this.db
            .prepare("SELECT value,fingerprint FROM requests WHERE id=?")
            .get(body.requestId);
          if (old) {
            if (!old.fingerprint)
              throw fail(
                "REQUEST_ID_CONFLICT",
                "旧版请求缺少操作指纹，无法安全重放；请重新读取画布确认结果后使用新的 requestId",
                409,
              );
            if (old.fingerprint !== fingerprint)
              throw fail(
                "REQUEST_ID_CONFLICT",
                "requestId 已用于不同的操作内容，请使用新的 requestId",
                409,
              );
            return JSON.parse(old.value);
          }
        }
        const state = this.raw();
        if (body.revision !== undefined && body.revision !== state.revision)
          throw fail("REVISION_CONFLICT", "画布已更新，请重新读取后重试", 409);
        const next = mutate(state);
        this.validate(next);
        next.revision = state.revision + 1;
        this.save(next);
        const result = decorate(next);
        if (body.requestId) {
          this.db
            .prepare(
              "INSERT INTO requests(id,value,fingerprint) VALUES (?,?,?)",
            )
            .run(body.requestId, JSON.stringify(result), fingerprint);
          this.pruneRequests();
        }
        return result;
      })(),
    );
  }
  apply(input) {
    return this.write(
      input,
      { action: "apply", operations: input?.operations },
      (state) => {
        const operations = z
          .array(z.record(z.string(), z.unknown()))
          .max(1000)
          .parse(input.operations);
        for (const operation of operations) {
          const o = operation;
          if (o.op === "node.create" || o.op === "node.put") {
            const node = nodeSchema.parse(o.node);
            const index = state.nodes.findIndex(
              (entry) => entry.id === node.id,
            );
            if (o.op === "node.create" && index >= 0)
              throw fail("NODE_EXISTS", "节点 ID 已存在: " + node.id, 409);
            if (index >= 0) state.nodes[index] = node;
            else state.nodes.push(node);
          } else if (o.op === "node.patch") {
            const node = this.node(state, o.id),
              patch = patchSchema.parse(o.patch);
            if (patch.title !== undefined) node.data.title = patch.title;
            if (patch.assetId === null) delete node.data.assetId;
            else if (patch.assetId !== undefined)
              node.data.assetId = patch.assetId;
            if (patch.type !== undefined) node.type = patch.type;
            if (patch.position)
              node.position = { ...node.position, ...patch.position };
            if (patch.style)
              node.style = {
                width: 300,
                height: 260,
                ...node.style,
                ...patch.style,
              };
          } else if (o.op === "node.inputs") {
            this.node(state, o.id);
            const inputs = z.array(idSchema).parse(o.inputs);
            state.edges = state.edges.filter((edge) => edge.target !== o.id);
            for (const source of new Set(inputs))
              state.edges.push({
                id: dependencyId(source, o.id),
                source,
                target: o.id,
              });
          } else if (o.op === "node.move") {
            this.node(state, o.id).position = positionSchema.parse(o.position);
          } else if (o.op === "node.delete") {
            state.nodes = state.nodes.filter((node) => node.id !== o.id);
            state.edges = state.edges.filter(
              (edge) => edge.source !== o.id && edge.target !== o.id,
            );
          } else if (o.op === "edge.put") {
            const edge = edgeSchema.parse(o.edge);
            state.edges.push({
              ...edge,
              id: dependencyId(edge.source, edge.target),
            });
          } else if (o.op === "edge.delete") {
            state.edges = state.edges.filter((edge) => edge.id !== o.id);
          } else if (
            o.op === "generation.start" ||
            o.op === "generation.record"
          ) {
            const node = this.node(state, o.id);
            if (o.op === "generation.start" && node.data.status === "running")
              throw fail(
                "GENERATION_ALREADY_RUNNING",
                "节点已有进行中的生成任务，请先完成或标记失败",
                409,
              );
            if (o.op === "generation.record" && !node.data.assetId)
              throw fail("OUTPUT_NOT_READY", "节点尚无生成结果", 409);
            const now = new Date().toISOString();
            node.data.generation = generationSchema.parse({
              id: randomUUID(),
              startedAt: now,
              prompt: z.string().parse(o.prompt),
              tool: z.string().min(1).parse(o.tool),
              inputs: this.inputSnapshots(state, o.id),
              ...(o.op === "generation.record"
                ? { completedAt: now, outputAssetId: node.data.assetId }
                : {}),
            });
            node.data.status =
              o.op === "generation.start" ? "running" : "ready";
          } else if (
            o.op === "generation.complete" ||
            o.op === "generation.fail"
          ) {
            const node = this.node(state, o.id);
            if (o.generationId !== undefined) {
              const generationId = z.string().min(1).parse(o.generationId);
              if (
                node.data.status !== "running" ||
                node.data.generation?.id !== generationId
              )
                throw fail(
                  "GENERATION_CONFLICT",
                  "生成任务已变更，不能写入过期任务的结果",
                  409,
                );
            }
            if (!node.data.generation || node.data.status !== "running")
              throw fail(
                "GENERATION_NOT_RUNNING",
                "节点没有进行中的生成任务",
                409,
              );
            if (o.op === "generation.complete") {
              node.data.assetId = z.string().min(1).parse(o.assetId);
              node.data.generation.outputAssetId = node.data.assetId;
              node.data.generation.completedAt = new Date().toISOString();
              node.data.status = "ready";
            } else {
              node.data.generation.error = z.string().min(1).parse(o.error);
              node.data.generation.failedAt = new Date().toISOString();
              node.data.status = "failed";
            }
          } else throw fail("UNKNOWN_OPERATION", "未知操作: " + o.op);
        }
        this.validate(state);
        // The snapshot's revision is the revision of this write, not the previous state.
        const snapshot = { ...state, revision: state.revision + 1 };
        this.remember(
          snapshot,
          operations.map((o) => o.op).join(", ") || "apply",
        );
        return state;
      },
    );
  }
  history({ limit = 20, offset = 0 } = {}) {
    return guarded(() => {
      const paging = z
        .object({
          limit: z.coerce.number().int().min(1).max(100),
          offset: z.coerce.number().int().nonnegative(),
        })
        .parse({ limit, offset });
      const cursor = this.db
        .prepare("SELECT history_id FROM canvas_history_cursor WHERE id=1")
        .get().history_id;
      const total = this.db
        .prepare("SELECT COUNT(*) AS count FROM canvas_history")
        .get().count;
      const entries = this.db
        .prepare(
          "SELECT * FROM canvas_history ORDER BY id DESC LIMIT ? OFFSET ?",
        )
        .all(paging.limit, paging.offset)
        .map((row) => {
          const s = JSON.parse(row.snapshot);
          return {
            id: row.id,
            createdAt: row.created_at,
            action: row.action,
            revision: row.revision,
            nodeCount: s.nodes.length,
            edgeCount: s.edges.length,
            current: row.id === cursor,
          };
        });
      return {
        entries,
        cursor,
        total,
        ...paging,
        canUndo: !!this.db
          .prepare("SELECT id FROM canvas_history WHERE id<? LIMIT 1")
          .get(cursor),
        canRedo: !!this.db
          .prepare("SELECT id FROM canvas_history WHERE id>? LIMIT 1")
          .get(cursor),
      };
    });
  }
  travel(direction, input = {}) {
    return this.write(input, { action: direction }, (state) => {
      const cursor = this.db
        .prepare("SELECT history_id FROM canvas_history_cursor WHERE id=1")
        .get().history_id;
      const row =
        direction === "undo"
          ? this.db
              .prepare(
                "SELECT id,snapshot FROM canvas_history WHERE id<? ORDER BY id DESC LIMIT 1",
              )
              .get(cursor)
          : this.db
              .prepare(
                "SELECT id,snapshot FROM canvas_history WHERE id>? ORDER BY id ASC LIMIT 1",
              )
              .get(cursor);
      if (!row)
        throw fail(
          direction === "undo" ? "NOTHING_TO_UNDO" : "NOTHING_TO_REDO",
          direction === "undo" ? "没有可撤销的操作" : "没有可重做的操作",
          409,
        );
      this.db
        .prepare("UPDATE canvas_history_cursor SET history_id=? WHERE id=1")
        .run(row.id);
      return { ...JSON.parse(row.snapshot), revision: state.revision };
    });
  }
  undo(input = {}) {
    return this.travel("undo", input);
  }
  redo(input = {}) {
    return this.travel("redo", input);
  }
  restore(historyId, input = {}) {
    const id = guarded(() =>
      z.coerce.number().int().positive().parse(historyId),
    );
    return this.write(input, { action: "restore", historyId: id }, (state) => {
      const row = this.db
        .prepare("SELECT snapshot FROM canvas_history WHERE id=?")
        .get(id);
      if (!row) throw fail("HISTORY_NOT_FOUND", "历史版本不存在: " + id, 404);
      const restored = {
        ...JSON.parse(row.snapshot),
        revision: state.revision,
      };
      this.validate(restored);
      this.remember(
        { ...restored, revision: state.revision + 1 },
        "restore:" + id,
      );
      return restored;
    });
  }
  close() {
    this.db.close();
  }
}
