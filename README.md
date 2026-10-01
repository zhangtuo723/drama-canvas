# 幕间 · Drama Canvas

由 Codex 通过 CLI 管理的本地图片、视频画布。画布展示媒体及其生成依赖，工程、原图、视频和提示词保存在工作目录；生成模型由 Codex 的其他工具调用。

## 启动

需要 Node.js 22.12+。

```bash
npm install
npm run build
node src/cli.js --project ./demo start --port 4317
```

`start` 在后台启动服务，端口被占用时自动选择空闲端口，返回实际 URL。默认只监听本机。前台运行可用 `serve`，或 `npm start`；Ctrl+C 停止前台服务。

```bash
node src/cli.js --project ./demo status
node src/cli.js --project ./demo stop
node src/cli.js --project ./demo restart
```

后台日志在工程的 `.server.log`。`status` 返回服务状态，服务未启动时退出码非零。

## 安装 CLI 与插件

GitHub 源码、npm 发布、插件 marketplace 安装与官方目录提交见 [发布说明](https://github.com/zhangtuo723/drama-canvas/blob/main/docs/PUBLISHING.md)。

无需先发布到 npm registry，用户或 agent 可以直接从 GitHub 安装（需要 Git 和 Node.js 22.12+）：

```bash
npm install --prefix "$HOME/.local/share/drama-canvas-cli" 'git+https://github.com/zhangtuo723/drama-canvas.git#main'
"$HOME/.local/share/drama-canvas-cli/node_modules/.bin/drama-canvas" --version
```

安装时 `prepare` 自动构建画布前端。当前尚未发布到 npm registry，因此不要使用仅包名的 `npm install -g drama-canvas`。

也可以从源码制作本地安装包：

```bash
npm run build
npm pack
npm install -g ./drama-canvas-0.2.1.tgz
drama-canvas init ./我的画布
drama-canvas --project ./我的画布 start
```

这是本地安装包，尚未发布 npm。媒体处理使用 `sharp` 和按平台安装的 FFprobe，SQLite 使用 `better-sqlite3`；缺少相应预编译包的平台可能需要编译环境。

插件目录为 `plugin/`，Skill 位于 `plugin/skills/drama-canvas/SKILL.md`。插件加载本身不会运行安装命令；agent 在首次执行画布任务时会检查 CLI，缺失时按 Skill 中的 GitHub 安装步骤处理。也可以使用当前源码仓库的 `node src/cli.js`。

以下示例都以 `node src/cli.js --project ./demo` 指定工程；全局安装后可以替换为 `drama-canvas --project ./demo`。

## 添加、查看与更新节点

一条命令导入图片或视频并添加节点，自动分配 ID、识别媒体类型和比例、选择空白位置，返回创建的节点：

```bash
node src/cli.js --project ./demo node add --file ./demo/generated/scene.png --title '草原'
node src/cli.js --project ./demo node add --id result-01 --type image --title '生成结果'
node src/cli.js --project ./demo node update result-01 --file ./demo/generated/result.png
node src/cli.js --project ./demo node update result-01 --x 800 --y 200 --width 640 --height 467
node src/cli.js --project ./demo node delete result-01
```

`node add` 也支持 `--asset <素材ID>`、手动位置和尺寸。指定同名 ID 默认报错；只有明确使用 `--replace` 才完整替换旧节点。普通编辑使用 `node update`，保留未修改字段。删除节点会清理相关连线，保留媒体文件。

```bash
node src/cli.js --project ./demo inspect --summary
node src/cli.js --project ./demo inspect --type image --limit 20 --offset 0
node src/cli.js --project ./demo node get image-1
node src/cli.js --project ./demo inspect --node image-1
```

`node get` 与 `inspect --node` 返回目标节点、当前输入、下游 ID、素材绝对路径，以及生成时记录的输入版本。`inspect` 不带筛选时返回全部节点、依赖线、素材和 revision；服务停止后仍可读取本地工程。

所有命令默认输出 JSON。画布写操作默认只返回成功状态、revision 和本次相关信息；需要完整画布状态时加全局 `--full`。错误包含 `error`、`code` 并以非零状态退出。默认请求超时为 150000 毫秒，可用全局 `--timeout <毫秒>` 调整。

## 生成依赖与任务记录

仅支持图片、视频节点。箭头从输入素材指向结果，没有“下一步”等标签。输入去重，并禁止自依赖与循环依赖。

```bash
node src/cli.js --project ./demo node inputs result-01 image-1 image-2
node src/cli.js --project ./demo edge add --from image-4 --to result-01
```

`node inputs` 替换全部输入，不传来源 ID 则清空；`edge add` 追加单条依赖。新建节点也可以使用 `--inputs image-1 image-2`。

生成前先设置依赖，将提示词保存到工程目录，再记录任务：

```bash
node src/cli.js --project ./demo generation start result-01 --tool image_gen --prompt-file ./demo/generated/result.prompt.txt
node src/cli.js --project ./demo node get result-01
```

保存 `start` 返回的 `node.data.generation.id`。Codex 读取 `generationInputs` 文件路径，交给实际可用的生成工具。生成得到真实文件后完成任务；下例的 `实际任务ID` 必须替换为本次 start 返回的 ID：

```bash
node src/cli.js --project ./demo generation complete result-01 --generation-id 实际任务ID --file ./demo/generated/result.png
# 仅在生成失败时执行这一条：
node src/cli.js --project ./demo generation fail result-01 --generation-id 实际任务ID --error '生成工具返回的实际失败原因'
```

任务 ID 防止较早的异步任务误写入后来启动的任务。记录包含提示词、工具名、开始/结束时间、输入节点及素材版本和输出素材。`start` 只记录“生成中”，不会调用模型；`complete` 导入真实输出，`fail` 记录失败。输入节点缺少素材、生成中、失败或已过期时，不能作为新任务的输入。`node update --file` 会直接完成该节点当前进行中的任务，异步生成推荐使用带任务 ID 的 `generation complete`。

若已有真实结果，并且可以确认它使用的就是当前输入版本，可补记：

```bash
node src/cli.js --project ./demo generation record result-01 --tool image_gen --prompt-file ./demo/generated/result.prompt.txt
```

`record` 使用当前时间和当前输入版本，不用于推测历史来源。旧工程没有生成记录的结果会保留“生成出处未知”，不会伪造当时的提示词或输入版本。

已记录任务的输入素材、依赖或上游生成版本变化后，下游显示“输入已变化”（`stale`），并沿依赖继续传递；不会自动重新生成。Codex 可读取状态，按用户要求重新调用工具。生成期间输入发生变化也不会被完成操作悄悄标记为最新。

## 排列与定位

```bash
node src/cli.js --project ./demo layout wedding-1 wedding-2 wedding-3 --mode grid --columns 3
node src/cli.js --project ./demo layout image-1 image-2 result-01 --mode dependencies
node src/cli.js --project ./demo view focus result-01
node src/cli.js --project ./demo view fit
```

`layout` 必须提供节点 ID，或明确加 `--all` 才排列整个画布；支持 `--gap`、`--x`、`--y`。网格排列适合成组图片，`dependencies` 按输入到输出排列。只移动指定节点，未选节点不受影响，但请为整组内容选择足够的空白区域。

`view focus <ID...>` 聚焦节点，`view fit [ID...]` 适配指定节点或全部节点。这些命令通知已连接的查看页面，不改变节点坐标，也不写入工程历史。

## 撤销、重做与恢复

```bash
node src/cli.js --project ./demo history --limit 20
node src/cli.js --project ./demo undo
node src/cli.js --project ./demo redo
node src/cli.js --project ./demo restore 12
```

`restore` 的参数是 `history` 返回的历史条目 ID，不是 revision。最多保留 100 个画布快照，包含节点、布局、依赖和生成记录。撤销后再编辑会建立新分支并清除后续重做记录；恢复旧快照也会产生新的画布版本。删除节点、撤销和历史裁剪都不删除原始媒体文件。历史只从此次升级后开始记录，不能还原升级前未保存的操作。

## 媒体导入与旧素材优化

```bash
node src/cli.js --project ./demo asset import ./demo/generated/scene.png
node src/cli.js --project ./demo asset optimize
node src/cli.js --project ./demo asset optimize asset_素材ID
```

导入支持 PNG/JPG/WebP/GIF/AVIF/MP4/WebM/MOV，检查实际格式、解码有效性和扩展名。原文件通过流式复制进入 `assets/`，按内容去重且不覆盖已有原图。图片记录尺寸与方向，生成最大 480px 的 WebP 缩略图；视频记录尺寸和时长。图像最多 1 亿像素，视频解码校验最多 120 秒。视频在画布中的播放能力仍取决于浏览器编码支持。

`asset optimize` 为旧素材补充元信息和图片缩略图，不传 ID 时处理全部素材；保留原图。动图缩略图使用静态首帧。工程升级不会重新生成媒体，也不会自动补写未知的生成出处。

## 简洁画布

前端保留全屏画布、平移缩放、查看全部、视频播放和轻量整理，没有素材库、上传栏或属性面板。

- 点击图片或标题选中，Shift 多选；图片不弹出大图，使用画布缩放查看细节。
- 拖动图片或标题移动，松手保存；右上角 × 删除当前节点，Delete/Backspace 删除选中节点。
- 显示生成中、失败及输入变化状态，并提供撤销、重做。
- 小尺寸预览使用缩略图，放大时加载原图；CLI 更新通过 SSE 同步到页面。

## 工作目录与批量操作

工程目录包含 `canvas.sqlite`、`assets/`、`thumbnails/`。生成源文件与提示词也应保存在工作目录，例如 `generated/`。`.server.json`、`.server.lock`、`.server.log` 是本机服务运行文件；不要把本地访问令牌加入版本控制。完整备份时先停止服务，再复制整个工程目录，避免遗漏 SQLite WAL 中的数据。

`apply --file operations.json` 提交一个原子批次。优先使用 `node.create` 新建、`node.patch` 局部更新；`node.put` 是显式完整替换，需要保留所有未打算清除的字段。批次包含读取到的 `revision` 和唯一 `requestId`；冲突后重新读取并协调，结果未知的重试使用同一请求 ID 和相同内容。最近 500 条请求保存幂等记录，同一 ID 不能用于不同操作。完整示例见插件 Skill。

```bash
npm run build
npm test
```
