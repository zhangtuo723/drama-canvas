#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { serve } from "./server.js";
import { freePosition, arrange } from "./layout.js";
import { queryState } from "./queries.js";
const version = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url)),
).version;
const cli = new Command()
  .name("drama-canvas")
  .version(version)
  .option("--project <dir>", "项目目录", ".")
  .option("--json", "JSON 输出（默认）")
  .option("--full", "写操作返回完整画布")
  .option("--timeout <ms>", "请求超时毫秒", "150000")
  .exitOverride()
  .configureOutput({ outputError: () => {} });
const out = (x) => console.log(JSON.stringify(x, null, 2));
const directory = () => path.resolve(cli.opts().project);
const fail = (message, code = "INVALID_ARGUMENT") =>
  Object.assign(new Error(message), { code });
const number = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw fail(name + "必须为有效数字");
  return n;
};
function endpoint() {
  let ep;
  try {
    ep = JSON.parse(
      readFileSync(path.join(directory(), ".server.json"), "utf8"),
    );
  } catch {
    throw fail(
      "画布服务未启动，请运行 drama-canvas start --project <目录>",
      "SERVER_NOT_RUNNING",
    );
  }
  let u;
  try {
    u = new URL(ep.url);
  } catch {
    throw fail("无效的本机服务地址", "INVALID_ENDPOINT");
  }
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw fail("无效的本机服务地址", "INVALID_ENDPOINT");
  return ep;
}
async function api(
  route,
  body,
  timeout = number(cli.opts().timeout, "timeout"),
) {
  const ep = endpoint();
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw fail("timeout必须大于0");
  let r;
  try {
    r = await fetch(ep.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Canvas-Token": ep.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    throw fail(
      e.name === "TimeoutError"
        ? "请求超时，可使用 --timeout 增加等待时间"
        : "无法连接画布服务，请运行 status 或 restart",
      e.name === "TimeoutError" ? "REQUEST_TIMEOUT" : "SERVER_UNREACHABLE",
    );
  }
  let data;
  try {
    data = await r.json();
  } catch {
    throw fail("服务返回了无效响应", "INVALID_RESPONSE");
  }
  if (!r.ok)
    throw fail(
      data.error || "请求失败",
      data.code || (r.status === 409 ? "REVISION_CONFLICT" : "REQUEST_FAILED"),
    );
  return data;
}
async function health() {
  try {
    const h = await api("/api/health", undefined, 1000);
    return h.ok && h.service === "drama-canvas" && h.project === directory()
      ? h
      : null;
  } catch {
    return null;
  }
}
function portNumber(value) {
  const n = number(value, "port");
  if (!Number.isInteger(n) || n < 0 || n > 65535)
    throw fail("port须为0–65535的整数");
  return n;
}
function localState(query = {}) {
  if (!existsSync(path.join(directory(), "canvas.sqlite")))
    throw fail("工程不存在，请先 init 或 start", "PROJECT_NOT_FOUND");
  const store = new Store(directory());
  try {
    return queryState(store.get(), store.assets(), directory(), query);
  } finally {
    store.close();
  }
}
async function state(query = {}) {
  try {
    return await api(
      "/api/state?" + new URLSearchParams(query),
      undefined,
      5000,
    );
  } catch (e) {
    if (["SERVER_NOT_RUNNING", "SERVER_UNREACHABLE"].includes(e.code))
      return localState(query);
    throw e;
  }
}
async function apply(operations, revision) {
  if (revision === undefined) revision = (await api("/api/state")).revision;
  return api("/api/operations", {
    requestId: randomUUID(),
    revision,
    operations,
  });
}
function result(s, extra = {}) {
  out(
    cli.opts().full
      ? { ...s, ...extra }
      : { ok: true, revision: s.revision, ...extra },
  );
}
function nodeResult(s, id) {
  result(s, { node: s.nodes.find((n) => n.id === id) });
}
function requireNode(s, id) {
  const n = s.nodes.find((n) => n.id === id);
  if (!n) throw fail("节点不存在: " + id, "NODE_NOT_FOUND");
  return n;
}
cli.command("init [directory]").action((d) => {
  const s = new Store(d || directory());
  out({ project: s.dir, state: s.get() });
  s.close();
});
cli
  .command("serve")
  .option("--port <number>", "端口；0自动选择", "4317")
  .option("--auto-port", "端口占用时自动选择其他端口")
  .action(async (o) => {
    let service;
    try {
      service = await serve(directory(), portNumber(o.port));
    } catch (e) {
      if (e.code !== "EADDRINUSE" || !o.autoPort) throw e;
      service = await serve(directory(), 0);
    }
    out({ url: service.url, project: service.store.dir, pid: process.pid });
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      service.close();
      service.server.close(() => process.exit(0));
      setTimeout(() => service.server.closeAllConnections(), 1000).unref();
    };
    service.app.locals.shutdown = stop;
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
async function start(port = "4317") {
  const live = await health();
  if (live)
    return { ok: true, alreadyRunning: true, ...live, url: endpoint().url };
  mkdirSync(directory(), { recursive: true });
  const log = path.join(directory(), ".server.log"),
    fd = openSync(log, "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--project",
      directory(),
      "serve",
      "--port",
      String(port),
      "--auto-port",
    ],
    { detached: true, stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  child.unref();
  let spawnError;
  child.on("error", (e) => {
    spawnError = e;
  });
  const deadline = Date.now() + 12000;
  for (; Date.now() < deadline;) {
    if (spawnError) throw fail(spawnError.message, "START_FAILED");
    await delay(150);
    const h = await health();
    if (h) return { ok: true, url: endpoint().url, ...h, log };
  }
  throw fail("服务未能启动，请检查 " + log, "START_FAILED");
}
async function stop() {
  const h = await health();
  if (!h) return { ok: true, stopped: false };
  const ep = endpoint();
  await api("/api/shutdown", {});
  for (let i = 0; i < 50; i++) {
    await delay(100);
    let current;
    try {
      current = endpoint();
    } catch {
      return { ok: true, stopped: true };
    }
    if (current.pid !== ep.pid) return { ok: true, stopped: true };
  }
  throw fail("服务停止超时", "STOP_TIMEOUT");
}
cli
  .command("start")
  .option("--port <number>", "首选端口；占用自动换端口", "4317")
  .action(async (o) => out(await start(portNumber(o.port))));
cli.command("stop").action(async () => out(await stop()));
cli
  .command("restart")
  .option("--port <number>", "首选端口")
  .action(async (o) => {
    let port = o.port;
    if (port === undefined)
      try {
        port = new URL(endpoint().url).port;
      } catch {
        port = "4317";
      }
    const requestedPort = portNumber(port);
    await stop();
    out(await start(requestedPort));
  });
cli.command("status").action(async () => {
  const h = await health();
  out(
    h
      ? { ...h, url: endpoint().url }
      : { ok: false, code: "SERVER_NOT_RUNNING", project: directory() },
  );
  if (!h) process.exitCode = 1;
});
cli
  .command("inspect")
  .option("--node <id>", "只查询某节点、输入和真实文件路径")
  .option("--summary", "只查询统计")
  .option("--type <type>", "image/video")
  .option("--limit <number>", "节点数量")
  .option("--offset <number>", "偏移")
  .action(async (o) => out(await state(o)));
cli
  .command("apply")
  .requiredOption("--file <path>", "JSON操作文件")
  .action(async (o) => {
    let data = JSON.parse(readFileSync(o.file, "utf8"));
    if (Array.isArray(data)) data = { operations: data };
    data.requestId ??= randomUUID();
    data.revision ??= (await api("/api/state")).revision;
    result(await api("/api/operations", data), { requestId: data.requestId });
  });
const asset = cli.command("asset");
asset
  .command("import <file>")
  .action(async (file) =>
    out(await api("/api/import", { path: path.resolve(file) })),
  );
asset
  .command("optimize [ids...]")
  .description("为已有素材补元信息和图片缩略图")
  .action(async (ids) => {
    const response = await api("/api/assets/optimize", { ids });
    out(response);
    if (response.failed.length) process.exitCode = 1;
  });
const node = cli.command("node");
node.command("get <id>").action(async (id) => out(await state({ node: id })));
node
  .command("add")
  .option("--id <id>", "默认自动生成")
  .option("--type <type>", "image/video；可从文件识别")
  .option("--file <path>", "导入并添加图片或视频")
  .option("--asset <id>")
  .option("--title <text>")
  .option("--x <number>")
  .option("--y <number>")
  .option("--width <number>")
  .option("--height <number>")
  .option("--inputs <ids...>", "输入节点")
  .option("--replace", "明确替换同ID节点")
  .action(async (o) => {
    const s = await api("/api/state");
    let id = o.id;
    if (s.nodes.some((n) => n.id === id) && !o.replace)
      throw fail("节点已存在，请使用 update 或明确 --replace", "NODE_EXISTS");
    if (o.file && o.asset) throw fail("--file 与 --asset 不能同时使用");
    const a = o.file
      ? await api("/api/import", { path: path.resolve(o.file) })
      : s.assets.find((a) => a.id === o.asset);
    if (o.asset && !a) throw fail("素材不存在", "ASSET_NOT_FOUND");
    const type = o.type || (a?.mime.startsWith("video/") ? "video" : "image");
    if (!["image", "video"].includes(type)) throw fail("type应为image或video");
    id ||= type + "-" + randomUUID().slice(0, 8);
    const width = o.width === undefined ? 320 : number(o.width, "width"),
      height =
        o.height === undefined
          ? Math.round(
              a?.width && a?.height ? (width * a.height) / a.width + 40 : 260,
            )
          : number(o.height, "height");
    if (width <= 0 || height <= 0) throw fail("节点尺寸须大于0");
    const place = freePosition(s.nodes, width, height);
    const n = {
      id,
      type,
      position: {
        x: o.x === undefined ? place.x : number(o.x, "x"),
        y: o.y === undefined ? place.y : number(o.y, "y"),
      },
      data: {
        title: o.title || a?.name || (type === "image" ? "图片" : "视频"),
        ...(a ? { assetId: a.id } : {}),
      },
      style: { width, height },
    };
    const ops = [{ op: o.replace ? "node.put" : "node.create", node: n }];
    if (o.inputs) ops.push({ op: "node.inputs", id, inputs: o.inputs });
    nodeResult(await apply(ops, s.revision), id);
  });
node
  .command("update <id>")
  .option("--file <path>")
  .option("--title <text>")
  .option("--x <number>")
  .option("--y <number>")
  .option("--width <number>")
  .option("--height <number>")
  .action(async (id, o) => {
    const s = await api("/api/state"),
      n = requireNode(s, id),
      patch = {},
      ops = [];
    if (o.title !== undefined) patch.title = o.title;
    if (o.x !== undefined || o.y !== undefined)
      patch.position = {
        ...n.position,
        ...(o.x !== undefined ? { x: number(o.x, "x") } : {}),
        ...(o.y !== undefined ? { y: number(o.y, "y") } : {}),
      };
    if (o.width !== undefined || o.height !== undefined) {
      patch.style = {
        width: n.style?.width || 320,
        height: n.style?.height || 260,
      };
      for (const k of ["width", "height"])
        if (o[k] !== undefined) {
          patch.style[k] = number(o[k], k);
          if (patch.style[k] <= 0) throw fail("节点尺寸须大于0");
        }
    }
    if (o.file) {
      const a = await api("/api/import", { path: path.resolve(o.file) });
      if (n.data.status === "running")
        ops.push({
          op: "generation.complete",
          id,
          assetId: a.id,
          generationId: n.data.generation?.id,
        });
      else {
        patch.assetId = a.id;
        patch.type = a.mime.startsWith("video/") ? "video" : "image";
      }
    }
    if (Object.keys(patch).length) ops.push({ op: "node.patch", id, patch });
    if (!ops.length) throw fail("请指定至少一个更新字段");
    nodeResult(await apply(ops, s.revision), id);
  });
node.command("delete <ids...>").action(async (ids) =>
  result(await apply(ids.map((id) => ({ op: "node.delete", id }))), {
    deleted: ids,
  }),
);
node
  .command("inputs <id> [sources...]")
  .description("替换全部输入；省略来源则清空")
  .action(async (id, inputs) =>
    nodeResult(await apply([{ op: "node.inputs", id, inputs }]), id),
  );
const edge = cli.command("edge");
edge
  .command("add")
  .requiredOption("--from <id>")
  .requiredOption("--to <id>")
  .action(async (o) =>
    result(
      await apply([
        {
          op: "edge.put",
          edge: {
            id: "dependency:" + JSON.stringify([o.from, o.to]),
            source: o.from,
            target: o.to,
          },
        },
      ]),
    ),
  );
edge
  .command("delete <id>")
  .action(async (id) => result(await apply([{ op: "edge.delete", id }])));
const generation = cli
  .command("generation")
  .description("记录外部工具生成任务；不调用生成模型");
for (const action of ["start", "record"])
  generation
    .command(action + " <id>")
    .option("--prompt <text>")
    .option("--prompt-file <path>")
    .requiredOption("--tool <name>", "实际使用的生成工具")
    .action(async (id, o) => {
      if (o.prompt && o.promptFile)
        throw fail("prompt与prompt-file不能同时使用");
      const prompt = o.promptFile
        ? readFileSync(o.promptFile, "utf8")
        : o.prompt;
      if (!prompt?.trim()) throw fail("需要生成提示词");
      nodeResult(
        await apply([{ op: "generation." + action, id, prompt, tool: o.tool }]),
        id,
      );
    });
generation
  .command("complete <id>")
  .requiredOption("--file <path>")
  .option("--generation-id <id>", "start返回的任务ID，防止旧任务覆盖新任务")
  .action(async (id, o) => {
    const s = await api("/api/state");
    const n = requireNode(s, id);
    const a = await api("/api/import", { path: path.resolve(o.file) });
    nodeResult(
      await apply(
        [
          {
            op: "generation.complete",
            id,
            assetId: a.id,
            generationId: o.generationId || n.data.generation?.id,
          },
        ],
        s.revision,
      ),
      id,
    );
  });
generation
  .command("fail <id>")
  .requiredOption("--error <message>")
  .option("--generation-id <id>", "start返回的任务ID")
  .action(async (id, o) => {
    const s = await api("/api/state"),
      n = requireNode(s, id);
    nodeResult(
      await apply(
        [
          {
            op: "generation.fail",
            id,
            error: o.error,
            generationId: o.generationId || n.data.generation?.id,
          },
        ],
        s.revision,
      ),
      id,
    );
  });
cli
  .command("history")
  .option("--limit <number>", "条目数", "20")
  .option("--offset <number>", "偏移", "0")
  .action(async (o) =>
    out(
      await api(
        "/api/history?limit=" +
          encodeURIComponent(o.limit) +
          "&offset=" +
          encodeURIComponent(o.offset),
      ),
    ),
  );
for (const action of ["undo", "redo"])
  cli.command(action).action(async () => {
    const s = await api("/api/state");
    result(
      await api("/api/history/" + action, {
        requestId: randomUUID(),
        revision: s.revision,
      }),
    );
  });
cli
  .command("restore <historyId>")
  .description("将历史画布快照恢复为新版本")
  .action(async (id) => {
    const s = await api("/api/state");
    result(
      await api("/api/history/restore", {
        id: number(id, "historyId"),
        requestId: randomUUID(),
        revision: s.revision,
      }),
    );
  });
cli
  .command("layout [ids...]")
  .option("--all", "排列全部节点")
  .option("--mode <mode>", "grid/dependencies", "grid")
  .option("--columns <number>", "网格列数", "3")
  .option("--gap <number>", "节点间距", "100")
  .option("--x <number>")
  .option("--y <number>")
  .action(async (ids, o) => {
    if (!ids.length && !o.all)
      throw fail("请指定节点ID，或 --all 明确排列全部节点");
    const s = await api("/api/state");
    ids.forEach((id) => requireNode(s, id));
    const selected = o.all
      ? s.nodes
      : s.nodes.filter((n) => ids.includes(n.id));
    const ops = arrange(selected, s.edges, {
      mode: o.mode,
      columns: number(o.columns, "columns"),
      gap: number(o.gap, "gap"),
      x: o.x === undefined ? undefined : number(o.x, "x"),
      y: o.y === undefined ? undefined : number(o.y, "y"),
    });
    if (!ops.length) {
      out({ ok: true, changed: 0 });
      return;
    }
    result(await apply(ops, s.revision), {
      arranged: selected.map((n) => n.id),
    });
  });
const view = cli.command("view");
view
  .command("fit [ids...]")
  .action(async (ids) =>
    out(
      await api("/api/view", { action: "fit", ids, requestId: randomUUID() }),
    ),
  );
view
  .command("focus <ids...>")
  .action(async (ids) =>
    out(
      await api("/api/view", { action: "focus", ids, requestId: randomUUID() }),
    ),
  );
await cli.parseAsync().catch((e) => {
  if (e.exitCode === 0) return;
  console.error(
    JSON.stringify({
      error: e.message,
      code: e.code?.startsWith("commander.")
        ? "INVALID_ARGUMENT"
        : e.code || "COMMAND_FAILED",
    }),
  );
  process.exitCode = 1;
});
