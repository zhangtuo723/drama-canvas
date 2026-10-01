import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs";

export function runtimeDirectory() {
  const override = process.env.DRAMA_CANVAS_RUNTIME_DIR;
  if (override && !path.isAbsolute(override))
    throw Object.assign(new Error("DRAMA_CANVAS_RUNTIME_DIR 必须是绝对路径"), {
      code: "INVALID_ARGUMENT",
    });
  return override || path.join(os.homedir(), ".local", "state", "drama-canvas");
}

export function runtimeFiles(dir = runtimeDirectory()) {
  if (!path.isAbsolute(dir))
    throw Object.assign(new Error("服务运行目录必须是绝对路径"), {
      code: "INVALID_ARGUMENT",
    });
  return {
    dir,
    endpoint: path.join(dir, "server.json"),
    lock: path.join(dir, "server.lock"),
    log: path.join(dir, "server.log"),
    projects: path.join(dir, "projects.json"),
  };
}

export function canonicalProject(dir, { create = false } = {}) {
  const absolute = path.resolve(dir);
  if (create) mkdirSync(absolute, { recursive: true });
  let current = absolute;
  const suffix = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      if (!statSync(real).isDirectory())
        throw Object.assign(new Error("工程路径必须是目录"), {
          code: "INVALID_ARGUMENT",
        });
      return path.join(real, ...suffix.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

export function projectId(dir) {
  return (
    "p_" +
    createHash("sha256")
      .update(canonicalProject(dir))
      .digest("hex")
      .slice(0, 24)
  );
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export function removeOwned(file, instanceId) {
  if (readJson(file)?.instanceId !== instanceId) return false;
  try {
    unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export function acquireLock(
  file,
  {
    instanceId = randomUUID(),
    code = "SERVER_ALREADY_RUNNING",
    message = "已有服务进程，请先停止旧服务",
  } = {},
) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const value = { pid: process.pid, instanceId };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      return () => removeOwned(file, instanceId);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Empty or malformed locks may be a process between exclusive create and write.
      // Never unlink these on sight, because doing so can start duplicate daemons.
      let raw;
      try {
        raw = readFileSync(file, "utf8");
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw readError;
      }
      let previous;
      try {
        previous = JSON.parse(raw);
      } catch {}
      const pid = typeof previous === "number" ? previous : previous?.pid;
      if (alive(pid) || !Number.isInteger(pid) || pid < 1)
        throw Object.assign(new Error(message), { code, status: 409 });
      // Only one process may reclaim a dead owner's file. Re-read while holding
      // this guard: the main lock may already belong to a newer daemon now.
      const reclaim = `${file}.reclaim`;
      const reclaimId = randomUUID();
      try {
        writeFileSync(
          reclaim,
          JSON.stringify({ pid: process.pid, instanceId: reclaimId }),
          { flag: "wx", mode: 0o600 },
        );
      } catch (claimError) {
        if (claimError.code !== "EEXIST") throw claimError;
        throw Object.assign(
          new Error("服务锁正在回收；若回收进程已退出，请清理 " + reclaim),
          { code, status: 409 },
        );
      }
      try {
        let latest;
        try {
          latest = readFileSync(file, "utf8");
        } catch (readError) {
          if (readError.code === "ENOENT") continue;
          throw readError;
        }
        let owner;
        try {
          owner = JSON.parse(latest);
        } catch {}
        const currentPid = typeof owner === "number" ? owner : owner?.pid;
        if (
          alive(currentPid) ||
          !Number.isInteger(currentPid) ||
          currentPid < 1
        )
          throw Object.assign(new Error(message), { code, status: 409 });
        unlinkSync(file);
        try {
          writeFileSync(file, JSON.stringify(value), {
            flag: "wx",
            mode: 0o600,
          });
        } catch (writeError) {
          if (writeError.code !== "EEXIST") throw writeError;
          throw Object.assign(new Error(message), { code, status: 409 });
        }
        return () => removeOwned(file, instanceId);
      } finally {
        removeOwned(reclaim, reclaimId);
      }
    }
  }
  throw Object.assign(new Error(message), { code, status: 409 });
}
