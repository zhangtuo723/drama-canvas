#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import { serveShared } from "./server.js";
import { canonicalProject } from "./runtime.js";
import {
  request,
  projectEndpoint,
  projectHealth,
  serverHealth,
  startServer,
  stopServer,
  openProject,
  stopProject,
  listProjects,
} from "./service-client.js";
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
const directory = () => canonicalProject(cli.opts().project);
const fail = (message, code = "INVALID_ARGUMENT") =>
  Object.assign(new Error(message), { code });
const number = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw fail(name + "必须为有效数字");
  return n;
};
async function api(
  route,
  body,
  timeout = number(cli.opts().timeout, "timeout"),
) {
  return request(projectEndpoint(directory()), route, body, timeout);
}
// Read-only inspection stays available offline. Only commands that need the
// running canvas open it automatically; status/stop never wake a service.
cli.hook("preAction", async (_, command) => {
  let top = command;
  while (top.parent && top.parent !== cli) top = top.parent;
  if (
    [
      "asset",
      "edge",
      "generation",
      "apply",
      "layout",
      "view",
      "undo",
      "redo",
      "restore",
    ].includes(top.name()) ||
    (top.name() === "node" && command.name() !== "get")
  ) {
    await openProject(directory());
  }
});
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
  // A leftover port may now belong to another project. Never read its state.
  if (!(await projectHealth(directory()))) return localState(query);
  try {
    return await api(
      "/api/state?" + new URLSearchParams(query),
      undefined,
      5000,
    );
  } catch (e) {
    if (
      [
        "SERVER_NOT_RUNNING",
        "SERVER_UNREACHABLE",
        "PROJECT_NOT_OPEN",
        "PROJECT_CLOSED",
      ].includes(e.code)
    )
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
  .description("前台运行共享服务，Ctrl+C 关闭所有已打开工程")
  .option("--port <number>", "端口；0自动选择", "4317")
  .option("--auto-port", "端口占用时自动选择其他端口")
  .option("--no-project", "只启动共享服务，不打开当前工程")
  .action(async (o) => {
    let service;
    try {
      service = await serveShared(portNumber(o.port));
    } catch (e) {
      if (e.code !== "EADDRINUSE" || !o.autoPort) throw e;
      service = await serveShared(0);
    }
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      await service.close();
    };
    service.app.locals.shutdown = shutdown;
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    try {
      const project = o.project ? await service.openProject(directory()) : null;
      const { token, ...safeProject } = project || {};
      out({
        ok: true,
        mode: "shared",
        pid: process.pid,
        serverUrl: service.url,
        url: project?.url || service.url,
        ...safeProject,
      });
    } catch (error) {
      await shutdown();
      throw error;
    }
  });
cli
  .command("start")
  .description("打开当前工程，自动启动或复用共享服务")
  .option("--port <number>", "共享服务首选端口；占用自动换端口", "4317")
  .action(async (o) =>
    out(
      await openProject(directory(), {
        port: portNumber(o.port),
        migrate: true,
      }),
    ),
  );
cli
  .command("stop")
  .description("仅关闭当前工程；停止全部工程请用 server stop")
  .action(async () => out(await stopProject(directory())));
cli
  .command("restart")
  .description("重新打开当前工程，不重启其他工程")
  .option("--port <number>", "共享服务未运行时的首选端口", "4317")
  .action(async (o) => {
    const port = portNumber(o.port);
    await stopProject(directory());
    out(await openProject(directory(), { port, migrate: true }));
  });
cli.command("status").action(async () => {
  const health = await projectHealth(directory());
  out(
    health || {
      ok: false,
      code: "PROJECT_NOT_OPEN",
      project: directory(),
      serverRunning: !!(await serverHealth()),
    },
  );
  if (!health) process.exitCode = 1;
});
cli
  .command("projects")
  .description("列出共享服务中已打开的工程")
  .action(async () => out(await listProjects()));
const server = cli.command("server").description("管理全部工程共用的后台服务");
server.command("status").action(async () => {
  const health = await serverHealth();
  out(health || { ok: false, code: "SERVER_NOT_RUNNING" });
  if (!health) process.exitCode = 1;
});
server
  .command("start")
  .option("--port <number>", "首选端口；占用自动换端口", "4317")
  .action(async (o) => out(await startServer(portNumber(o.port))));
server
  .command("stop")
  .description("停止共享服务及全部已打开工程，保留所有文件")
  .action(async () => out(await stopServer()));
server
  .command("restart")
  .description("重启共享服务，恢复之前打开的工程")
  .option("--port <number>", "首选端口，默认沿用当前端口")
  .action(async (o) => {
    const health = await serverHealth();
    const port = portNumber(
      o.port ?? (health ? new URL(health.url).port : "4317"),
    );
    await stopServer();
    out(await startServer(port));
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
  .action(async (o) => {
    if (!(await projectHealth(directory()))) {
      if (!existsSync(path.join(directory(), "canvas.sqlite")))
        throw fail("工程不存在，请先 init 或 start", "PROJECT_NOT_FOUND");
      const store = new Store(directory());
      try {
        out(
          store.history({ limit: Number(o.limit), offset: Number(o.offset) }),
        );
      } finally {
        store.close();
      }
    } else
      out(
        await api(
          "/api/history?limit=" +
            encodeURIComponent(o.limit) +
            "&offset=" +
            encodeURIComponent(o.offset),
        ),
      );
  });
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
