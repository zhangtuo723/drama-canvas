---
name: drama-canvas
description: Manage a local Drama Canvas of images, videos, and generation dependencies through its CLI. Use to add, arrange, inspect, or recover media on an existing or requested canvas and record results from separate generation tools.
---

# Drama Canvas

Use `drama-canvas`, or `node /absolute/repository/src/cli.js` in a source checkout. Pass `--project /absolute/project/path` before the subcommand. Keep the project, generated originals and prompt files in the user's working directory. Plugin installation does not install the CLI or its Node.js 22.12+ dependencies.

The browser is a media canvas; only image/video nodes and input-to-result dependency arrows are supported. Do not create text/group nodes or “下一步” sequence labels. Use separate available tools for generation: this CLI never calls a model or executes a dependency graph.

## Ensure the CLI is available

Before the first canvas operation, check the version of the exact CLI executable you will invoke. On macOS/Linux, check both PATH (`drama-canvas --version`) and `$HOME/.local/share/drama-canvas-cli/node_modules/.bin/drama-canvas --version`; use an existing source checkout when appropriate. **Shared-service operations require CLI 0.3.0 or later.** Installing or refreshing this plugin does not update the CLI. If the CLI is missing or older than 0.3.0, install or upgrade it as part of setting up the user's requested canvas task, then verify the new version before continuing.

Prefer the npm package, installed in a writable user directory:

```bash
npm install --prefix "$HOME/.local/share/drama-canvas-cli" drama-canvas@latest
"$HOME/.local/share/drama-canvas-cli/node_modules/.bin/drama-canvas" --version
```

This requires Node.js 22.12+ and npm, but not Git or an npm login. The registry package includes the built viewer; no manual frontend build is needed. Invoke the verified installed absolute path for subsequent commands, so an older CLI on PATH cannot accidentally start separate services. For other platforms use an equivalent writable tool directory. If a global command is explicitly desired, use `npm install -g drama-canvas@latest`, then check `drama-canvas --version`.

As an alternative, install from the public GitHub repository:

```bash
npm install --prefix "$HOME/.local/share/drama-canvas-cli" 'git+https://github.com/zhangtuo723/drama-canvas.git#main'
"$HOME/.local/share/drama-canvas-cli/node_modules/.bin/drama-canvas" --version
```

Git installation additionally requires Git; the package's `prepare` script builds the viewer automatically. Prefer a non-global Git install: some npm 10 versions inherit global mode into the Git preparation subprocess and fail. If a global Git install is explicitly desired, first run `npm pack` for the Git URL without global mode, then `npm install -g` the returned local tarball.

Do not disable lifecycle scripts: native dependencies need them, and Git installation also builds the viewer. Do not use sudo or change shell startup files just to install this tool. Follow the host's execution permissions and report any real installation failure. Plugin loading itself does not perform installation; the agent runs this setup only when using the CLI for a requested task.

## Connect and inspect

One user-level background service hosts multiple projects on one port. Each project keeps its database and media in its own working directory and has a URL under `/p/<projectID>/`. Use `init <dir>` to create a project, `status` to check whether the intended project is open, and `start` to start or reuse the shared service and open that project. Always read the returned project URL. `start --port 4317` is a preferred port when starting the daemon, with fallback if occupied; an existing shared service is reused at its current port. Do not terminate unrelated processes to free a port.

Writes and `view` commands automatically start the shared service and open the requested project when needed. Read-only `inspect`, `node get`, and `history` work directly from the local project when the service is stopped and do not start it. Do not launch a separate server for each project.

```bash
drama-canvas --project /work/project start
drama-canvas --project /work/another-project start
drama-canvas projects
drama-canvas --project /work/project status
drama-canvas --project /work/project stop
drama-canvas --project /work/project restart
drama-canvas server status
```

`projects` lists open projects with their paths and URLs. Project `status` returns `PROJECT_NOT_OPEN` when the project is not open, with `serverRunning` indicating whether the shared daemon is running. `server status` returns `SERVER_NOT_RUNNING` when the daemon is stopped. Both unavailable statuses have a nonzero exit code. Project `stop` releases only that project's database and viewer connections, removes it from the list restored on daemon startup, and preserves project files. Other projects remain available. Project `restart` reopens only that project. A later write or `start` can open a stopped project again.

`server start`, `server stop`, and `server restart` manage the shared daemon. **`server stop` closes service access for every open project**; use project `stop` when the user only wants to close one canvas. The daemon persists its open-project list and restores it on `server start` or `server restart`; an explicitly stopped project stays closed. Closing Codex or a browser does not stop the background daemon. It currently has no idle shutdown, even when no projects are open. `serve` runs the shared service in the foreground; Ctrl+C stops that whole service.

Runtime files live under `~/.local/state/drama-canvas/`, separate from project data. For isolated tests or a separate runtime, set `DRAMA_CANVAS_RUNTIME_DIR` to an absolute path and use the same value for subsequent commands. `start` and `restart` recognize an old single-project service and gracefully shut it down through its authenticated endpoint before migrating it. Use the newly returned project URL; do not assume the old root URL remains the canvas. Legacy writes can still use the old service for compatibility, but use `start` to migrate deliberately.

Prefer targeted reads:

```bash
drama-canvas --project /work/project inspect --summary
drama-canvas --project /work/project inspect --type image --limit 20 --offset 0
drama-canvas --project /work/project node get image-1
drama-canvas --project /work/project inspect --node image-1
```

The two targeted node commands return the node, current inputs, downstream IDs, local asset paths, and recorded `generationInputs`. Full `inspect` returns nodes, edges, assets and revision. Read-only inspection also works with the server stopped. Browser selection is local: resolve a referenced node from provided evidence, titles and IDs instead of guessing from node order.

All output is JSON; errors include `error` and `code` with a nonzero exit status. Writes return compact results by default. Add global `--full` only when the full resulting canvas state is needed. The default request timeout is 150000 ms; global `--timeout <milliseconds>` overrides it.

## Add and edit media

```bash
drama-canvas --project /work/project node add --file /work/project/generated/scene.png --title '场景参考'
drama-canvas --project /work/project node add --id result-01 --type image --title '生成结果' --inputs image-1 image-2
drama-canvas --project /work/project node update result-01 --file /work/project/generated/result.png
drama-canvas --project /work/project node update result-01 --x 800 --y 200 --width 640 --height 467
```

`node add --file` imports the file, infers media type and proportions, chooses free space, and returns an automatically assigned ID unless `--id` is supplied. Capture the returned ID. It also accepts an existing `--asset`. Duplicate IDs fail; `--replace` explicitly replaces the whole node. Use `node update` for partial edits so other data survives. `node delete <IDs...>` removes nodes and their incident edges while retaining source files.

`asset import <absolute-file>` imports without adding a node. PNG/JPEG/WebP/GIF/AVIF/MP4/WebM/MOV are validated against actual content. Imports stream into `assets/`, deduplicate by content, preserve originals, and record dimensions; images also get thumbnails and videos get duration. `asset optimize [assetIDs...]` validates existing originals and adds missing metadata/thumbnails; omitting IDs handles all assets. Inspect its results and report individual failures. It does not recover missing originals or unknown generation provenance.

## Record actual generation

`node inputs <resultID> [inputIDs...]` replaces all incoming dependencies; omit input IDs to clear them. `edge add --from <input> --to <result>` appends a dependency. Duplicate pairs are deduplicated; self-dependencies, cycles and missing endpoints fail.

For requested generation, set dependencies and save the actual prompt before starting the external tool:

```bash
drama-canvas --project /work/project node inputs result-01 image-1 image-2
drama-canvas --project /work/project generation start result-01 --tool image_gen --prompt-file /work/project/generated/result.prompt.txt
drama-canvas --project /work/project node get result-01
```

Save the ID returned by `start` at `node.data.generation.id`. Read `generationInputs` and pass those recorded asset paths to the available generator. This preserves the actual input versions even if a node changes while generation runs. Save the real output under the project, then complete using the saved ID; replace `ACTUAL_START_ID` with that value:

```bash
drama-canvas --project /work/project generation complete result-01 --generation-id ACTUAL_START_ID --file /work/project/generated/result.png
```

On actual generator failure, use `generation fail result-01 --generation-id ACTUAL_START_ID --error 'actual error'`. Always pass the captured task ID for asynchronous work so an old completion/failure cannot overwrite a newer task. A failed task leaves its previous media or placeholder intact. These commands record status; they do not run or retry generation. `generation start` can be used again for an authorized retry. Source nodes must have media and cannot be running, failed or stale. Empty-dependency generation is permitted. `node update --file` completes the currently running generation directly; prefer the task-ID-checked complete command for asynchronous results.

Generation records include prompt, tool, timestamps, input asset/generation versions and output asset. Replacing an input or changing dependencies marks recorded downstream outputs `stale` and propagates through their descendants. It does not automatically regenerate them. A completion retains its original input snapshot; if inputs changed meanwhile, the result can still be stale. Read fresh state when deciding what to generate next.

For an existing output, `generation record <id> --tool <actual-tool> --prompt-file <path>` captures the current input versions and recording time. Use it only when those inputs are known to match the actual generation. Old results with no record have `provenanceUnknown`; do not invent historical prompts, tools, timestamps or input versions to clear that flag. A dependency line alone does not establish the original generation versions.

## Arrange, focus and recover

```bash
drama-canvas --project /work/project layout wedding-1 wedding-2 wedding-3 --mode grid --columns 3
drama-canvas --project /work/project layout image-1 image-2 result-01 --mode dependencies
drama-canvas --project /work/project view focus result-01
drama-canvas --project /work/project view fit
drama-canvas --project /work/project history --limit 20
drama-canvas --project /work/project undo
drama-canvas --project /work/project redo
drama-canvas --project /work/project restore 12
```

`layout` requires explicit IDs or `--all`. Prefer the involved IDs to preserve unrelated layout; choose `--x`, `--y` and `--gap` when an entire group needs a clear region. Dependencies mode places inputs before outputs; grid supports `--columns`. `view fit [IDs...]` and `view focus <IDs...>` notify connected viewers without changing node coordinates or history. Check the reported delivery result rather than assuming a browser was open.

History retains at most 100 canvas snapshots, including nodes, positions, dependencies and generation records. `restore` takes a history entry ID, not a revision, and creates a new canvas version. Editing after undo discards the redo branch. Restore/undo do not delete imported or generated files, and cannot recover unrecorded operations from before history support was installed.

## Atomic batches

Use `apply --file /absolute/operations.json` when several related edits must succeed together. Include an inspected revision and unique requestId. For an uncertain response, retry the same request ID and body; for a revision conflict, reread and reconcile before forming a new request. The server retains the latest 500 request records. Reusing an ID for different operations is rejected; do not treat old IDs outside the retained window as indefinitely idempotent. Example:

```json
{
  "revision": 7,
  "requestId": "a-unique-operation-id",
  "operations": [
    {
      "op": "node.create",
      "node": {
        "id": "result-02",
        "type": "image",
        "position": { "x": 800, "y": 500 },
        "data": { "title": "结果 2" },
        "style": { "width": 320, "height": 260 }
      }
    },
    { "op": "node.inputs", "id": "result-02", "inputs": ["image-1", "image-2"] },
    { "op": "node.patch", "id": "image-1", "patch": { "title": "草原参考" } }
  ]
}
```

`node.create` rejects an existing ID. `node.patch` merges title, assetId, type, position and style; `assetId: null` detaches the asset. `node.put` explicitly replaces the entire node, so preserve any generation and status data that should remain. Other operations are `node.move`, `node.delete`, `node.inputs`, `edge.put`, `edge.delete` and generation start/complete/fail/record. Prefer the high-level generation commands for file imports and task records.

## Viewer and files

The viewer supports pan/zoom, selecting and dragging media/title areas, video playback, and an upper-right × per node. Images do not open a separate enlarged preview. Delete/Backspace deletes selected nodes; undo/redo and compact generation-status indicators are available. Dragging/deletion persists and can race with CLI writes, so honor revisions. Viewer changes arrive through SSE; do not require manual browser work for CLI actions or claim visual verification unless actually inspected.

The project includes `canvas.sqlite`, `assets/`, `thumbnails/` and user-generated sources/prompts such as `generated/`. Shared runtime files `server.json`, `server.lock`, `server.log`, and `projects.json`, including the local access token and open-project list, are stored under `~/.local/state/drama-canvas/` (or `DRAMA_CANVAS_RUNTIME_DIR`); do not publish them or include them in portable project backups. Each open project also writes its own `.server.json` and `.server.lock` for identity and protection against being opened concurrently by a legacy service. These project runtime files and their tokens are local-only too; a project `.server.log` may remain from the old service. For a complete portable backup, run `--project /absolute/project/path stop` and copy the whole project directory; other projects can remain open. End with the actual changes and returned project URL, including any unresolved failure.
