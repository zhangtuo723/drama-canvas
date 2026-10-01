import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const cli = process.argv[2];
if (!cli)
  throw new Error(
    "Usage: node scripts/verify-install.mjs <installed-cli-path>",
  );
const exec = promisify(execFile);
const dir = await mkdtemp(path.join(os.tmpdir(), "drama-installed-smoke-"));
const project = path.join(dir, "project");
const env = {
  ...process.env,
  DRAMA_CANVAS_RUNTIME_DIR: path.join(dir, "runtime"),
};
const run = async (...args) =>
  JSON.parse(
    (
      await exec(process.execPath, [cli, "--project", project, ...args], {
        timeout: 20000,
        env,
      })
    ).stdout,
  );
try {
  const service = await run("start", "--port", "0");
  const result = await run(
    "node",
    "add",
    "--id",
    "install-smoke",
    "--title",
    "安装验证",
  );
  assert.equal(result.node.id, "install-smoke");
  const page = await fetch(service.url, { signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200, "Installed viewer must serve HTML");
  const script = (await page.text()).match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(script, "Installed package must include built viewer JS");
  const response = await fetch(new URL(script, page.url), {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.ok((await response.text()).length > 0);
  console.log(
    "Installed CLI, SQLite writes, background service, and viewer assets passed.",
  );
} finally {
  // Always clean up this isolated daemon, even if opening the project failed.
  // Keep its runtime files for diagnosis if shutdown itself fails.
  await run("server", "stop");
  await rm(dir, { recursive: true, force: true });
}
