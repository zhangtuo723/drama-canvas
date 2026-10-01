import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalProject, runtimeFiles } from "./runtime.js";

const fail = (message, code) => Object.assign(new Error(message), { code });

export function readEndpoint(file) {
  let ep;
  try {
    ep = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw fail("画布服务未启动", "SERVER_NOT_RUNNING");
  }
  let url;
  try {
    url = new URL(ep.url);
  } catch {
    throw fail("无效的本机服务地址", "INVALID_ENDPOINT");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:p\/[A-Za-z0-9_-]+\/?)?$/.test(url.pathname) ||
    typeof ep.token !== "string" ||
    !ep.token
  )
    throw fail("无效的本机服务地址", "INVALID_ENDPOINT");
  return { ...ep, url: ep.url.replace(/\/$/, "") };
}

export async function request(ep, route, body, timeout = 150000) {
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw fail("timeout必须大于0", "INVALID_ARGUMENT");
  let response;
  try {
    response = await fetch(ep.url + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Canvas-Token": ep.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw fail(
      error.name === "TimeoutError"
        ? "请求超时，可使用 --timeout 增加等待时间"
        : "无法连接画布服务，请运行 status 或 start",
      error.name === "TimeoutError" ? "REQUEST_TIMEOUT" : "SERVER_UNREACHABLE",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw fail("服务返回了无效响应", "INVALID_RESPONSE");
  }
  if (!response.ok)
    throw fail(data.error || "请求失败", data.code || "REQUEST_FAILED");
  return data;
}

export function projectEndpoint(dir) {
  return readEndpoint(path.join(canonicalProject(dir), ".server.json"));
}

export async function projectHealth(dir) {
  const project = canonicalProject(dir);
  try {
    const ep = projectEndpoint(project);
    const health = await request(ep, "/api/health", undefined, 1000);
    if (
      !health.ok ||
      health.service !== "drama-canvas" ||
      typeof health.project !== "string" ||
      !path.isAbsolute(health.project) ||
      canonicalProject(health.project) !== project ||
      health.pid !== ep.pid ||
      (ep.mode === "shared" && ep.instanceId !== health.instanceId)
    )
      return null;
    return { ...health, url: ep.url, mode: health.mode || "legacy" };
  } catch {
    return null;
  }
}

export async function serverHealth() {
  const files = runtimeFiles();
  try {
    const ep = readEndpoint(files.endpoint);
    const health = await request(ep, "/api/health", undefined, 1000);
    if (
      !health.ok ||
      health.service !== "drama-canvas" ||
      health.mode !== "shared" ||
      health.apiVersion !== 2 ||
      !ep.instanceId ||
      ep.instanceId !== health.instanceId
    )
      return null;
    return { ...health, url: ep.url, runtime: files.dir };
  } catch {
    return null;
  }
}

export async function startServer(port = 4317) {
  const live = await serverHealth();
  if (live) return { ...live, alreadyRunning: true };
  const files = runtimeFiles();
  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  const fd = openSync(files.log, "a", 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./cli.js", import.meta.url)),
        "serve",
        "--no-project",
        "--port",
        String(port),
        "--auto-port",
      ],
      { detached: true, stdio: ["ignore", fd, fd] },
    );
  } finally {
    closeSync(fd);
  }
  child.unref();
  let spawnError;
  child.on("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + 12000;
  do {
    if (spawnError) throw fail(spawnError.message, "START_FAILED");
    await delay(100);
    const health = await serverHealth();
    if (health) return { ...health, log: files.log };
  } while (Date.now() < deadline);
  throw fail("共享服务未能启动，请检查 " + files.log, "START_FAILED");
}

export async function stopProject(dir) {
  const health = await projectHealth(dir);
  if (!health)
    return { ok: true, stopped: false, project: canonicalProject(dir) };
  await request(projectEndpoint(dir), "/api/shutdown", {});
  const deadline = Date.now() + 6000;
  do {
    await delay(100);
    const current = await projectHealth(dir);
    if (
      !current ||
      current.pid !== health.pid ||
      current.instanceId !== health.instanceId
    )
      return {
        ok: true,
        stopped: true,
        project: canonicalProject(dir),
        scope: "project",
      };
  } while (Date.now() < deadline);
  throw fail("工程关闭超时", "STOP_TIMEOUT");
}

export async function openProject(dir, { port = 4317, migrate = false } = {}) {
  const project = canonicalProject(dir);
  const current = await projectHealth(project);
  if (current?.mode === "legacy") {
    if (!migrate) return { ...current, alreadyRunning: true };
    // Authenticate to the old project server. Never kill a process by a stale PID.
    await stopProject(project);
  }
  const server = await startServer(port);
  const opened = await request(
    readEndpoint(runtimeFiles().endpoint),
    "/api/projects/open",
    { path: project },
  );
  const { token, ...safe } = opened;
  return {
    ok: true,
    service: "drama-canvas",
    apiVersion: 2,
    ...safe,
    serverUrl: server.url,
    alreadyRunning: !!current && current.mode === "shared",
  };
}

export async function listProjects() {
  const server = await serverHealth();
  if (!server) return { ok: true, running: false, projects: [] };
  const data = await request(
    readEndpoint(runtimeFiles().endpoint),
    "/api/projects",
  );
  return { ok: true, running: true, pid: server.pid, url: server.url, ...data };
}

export async function stopServer() {
  const health = await serverHealth();
  if (!health) return { ok: true, stopped: false, scope: "server" };
  await request(readEndpoint(runtimeFiles().endpoint), "/api/shutdown", {});
  const deadline = Date.now() + 10000;
  do {
    await delay(100);
    let current;
    try {
      current = readEndpoint(runtimeFiles().endpoint);
    } catch (error) {
      if (error.code !== "SERVER_NOT_RUNNING") throw error;
    }
    if (!current || current.instanceId !== health.instanceId)
      return { ok: true, stopped: true, scope: "server" };
  } while (Date.now() < deadline);
  throw fail("共享服务关闭超时", "STOP_TIMEOUT");
}
