# 幕间 · Drama Canvas

**使用 Codex 辅助创作短剧的本地画布插件。**

在 Codex 中用自然语言描述创作需求，逐步制作角色设定图、场景参考、分镜图片和视频素材。Codex 调用可用的生成工具完成创作，再通过 Drama Canvas CLI 将结果放到画布上，并连接它们所使用的参考素材。

![使用 Codex 辅助创作短剧：左侧对话生成素材，右侧画布展示角色、场景、分镜和依赖连线](https://raw.githubusercontent.com/zhangtuo723/drama-canvas/main/docs/images/codex-short-drama-canvas.png)

*在 Codex 中对话创作，右侧画布同步展示角色、咖啡店场景、多视角参考和分镜素材；连线表示素材之间的生成依赖。*

## 在 Codex 中创作短剧

在 Codex 中安装 Drama Canvas 插件后，直接描述你的短剧创作需求。首次使用时，Codex 会按插件指引检查 CLI，缺失或版本过旧时安装或升级，并启动画布。例如：

> 为这部咖啡店短剧创建一个画布，先生成男女主角的角色设定图。
>
> 生成咖啡店俯视图，再以它为参考，生成前后左右四个角度的场景图。
>
> 使用这些角色和场景参考生成一组分镜，把结果放入画布，并连接对应的输入素材。

Codex 负责调用生成工具和操作 CLI；画布用于查看图片、播放视频、缩放浏览，也支持移动和删除节点。工程、原图、视频和提示词保存在本地工作目录。CLI 本身不调用生成模型，图片和视频的生成能力取决于 Codex 当前可用的工具。

## 安装与使用

插件的安装方式见 [安装 Codex 插件](docs/PUBLISHING.md#通过-github-安装-codex-插件)。插件提供 Codex 操作画布的指引，CLI 是实际执行操作的独立工具；安装或更新插件与安装或更新 CLI 是两件事。

**CLI 是打包好的工具，安装后即可使用，无需手动构建前端。** 日常操作可以交给 Codex：它调用已安装的 CLI，添加素材时自动启动或复用共享服务。你不需要每次创建工程都执行安装、构建或启动命令。

本机需要 Node.js 22.12+。从 npm 安装无需 Git，安装包包含 CLI 和构建好的画布前端。共享服务需要 CLI **0.3.0 或更高版本**；更新插件后仍需检查实际调用的 CLI 版本，旧版 CLI 要单独升级。

<details>
<summary>手动安装或升级 CLI（可选）</summary>

从 npm 安装到用户目录，安装和升级使用同一条命令：

```bash
npm install --prefix "$HOME/.local/share/drama-canvas-cli" drama-canvas@latest
"$HOME/.local/share/drama-canvas-cli/node_modules/.bin/drama-canvas" --version
```

也可以安装为全局命令：

```bash
npm install -g drama-canvas@latest
drama-canvas --version
drama-canvas --project ./我的画布 start
```

插件加载本身不会执行安装命令；Codex 在首次处理画布任务时按插件指引检查版本并安装或升级。媒体处理使用 `sharp`、FFprobe 和 SQLite 原生依赖，安装时会按平台处理依赖；缺少预编译包的平台可能需要编译环境。

**备选：从 GitHub 安装。** 这种方式还需要 Git，安装脚本会自动构建前端，无需额外运行 `npm run build`：

```bash
npm install --prefix "$HOME/.local/share/drama-canvas-cli" 'git+https://github.com/zhangtuo723/drama-canvas.git#main'
"$HOME/.local/share/drama-canvas-cli/node_modules/.bin/drama-canvas" --version
```

如果已经拿到打包好的 `.tgz` 文件，也可执行 `npm install -g ./drama-canvas-0.3.0.tgz`。

</details>

## CLI 命令参考

以下命令通常由 Codex 执行，也可以在终端中手动使用。示例以 `drama-canvas --project ./demo` 指定工程；如果安装在上面的用户目录，将 `drama-canvas` 替换为 `"$HOME/.local/share/drama-canvas-cli/node_modules/.bin/drama-canvas"` 即可。

### 服务与工程

一个用户共用一个本地后台服务，多个工程使用同一端口，通过 `/p/<工程ID>/` 区分画布。数据库、原图和提示词仍保存在各自工程目录。`start` 自动启动或复用共享服务并打开当前工程，返回该工程的实际 URL；首次启动时首选端口被占用会自动选择空闲端口。服务默认只监听本机。

```bash
# 打开画布，自动启动或复用共享服务
drama-canvas --project ./demo start

# 第二个工程复用同一后台进程和端口
drama-canvas --project ./另一个工程 start

# 查看当前工程及所有已打开工程
drama-canvas --project ./demo status
drama-canvas projects

# 只关闭或重开 demo，其他工程继续运行
drama-canvas --project ./demo stop
drama-canvas --project ./demo restart

# 管理共享后台服务；stop 会关闭所有工程的服务
drama-canvas server status
drama-canvas server stop
drama-canvas server start
drama-canvas server restart
```

添加节点、导入媒体等写操作以及 `view` 命令也会按需启动共享服务并打开目标工程，无需每次先执行 `start`。`inspect`、`node get` 和 `history` 在服务停止时直接读取本地工程，不会仅为查看数据而启动服务。

`status` 检查当前工程是否已打开，未打开时返回 `PROJECT_NOT_OPEN`，并通过 `serverRunning` 说明共享服务是否运行；`server status` 检查共享服务，未运行时返回 `SERVER_NOT_RUNNING`。这两种未运行状态均使用非零退出码。`projects` 列出已打开工程的路径、URL 等信息。工程的 `stop` 会释放该工程的数据库和页面连接，保留全部工程文件，并从待恢复列表中移除它；后续写操作或 `start` 可以再次打开。即使所有工程都关闭，共享进程也会保留，暂未启用空闲自动退出。

`server stop` 停止整个共享服务；已打开工程的列表保存在本机，下次 `server start` 或 `server restart` 会恢复它们。关闭 Codex 或浏览器标签页不会停止后台服务。前台运行可用 `drama-canvas --project ./demo serve`；此时 Ctrl+C 关闭整个共享服务及其所有工程连接。

共享服务的日志、访问令牌和已打开工程列表保存在 `~/.local/state/drama-canvas/`。可用绝对路径环境变量 `DRAMA_CANVAS_RUNTIME_DIR` 隔离测试或另一套服务；同一套服务的后续命令须使用相同变量。工程迁移到共享服务后，请使用 `start` 返回的新 URL。`start` 和 `restart` 会识别该工程的旧版独立服务，通过认证接口正常关闭后迁移，不会终止占用端口的无关进程。

## 添加、查看与更新节点

一条命令导入图片或视频并添加节点，自动分配 ID、识别媒体类型和比例、选择空白位置，返回创建的节点：

```bash
drama-canvas --project ./demo node add --file ./demo/generated/scene.png --title '草原'
drama-canvas --project ./demo node add --id result-01 --type image --title '生成结果'
drama-canvas --project ./demo node update result-01 --file ./demo/generated/result.png
drama-canvas --project ./demo node update result-01 --x 800 --y 200 --width 640 --height 467
drama-canvas --project ./demo node delete result-01
```

`node add` 也支持 `--asset <素材ID>`、手动位置和尺寸。指定同名 ID 默认报错；只有明确使用 `--replace` 才完整替换旧节点。普通编辑使用 `node update`，保留未修改字段。删除节点会清理相关连线，保留媒体文件。

```bash
drama-canvas --project ./demo inspect --summary
drama-canvas --project ./demo inspect --type image --limit 20 --offset 0
drama-canvas --project ./demo node get image-1
drama-canvas --project ./demo inspect --node image-1
```

`node get` 与 `inspect --node` 返回目标节点、当前输入、下游 ID、素材绝对路径，以及生成时记录的输入版本。`inspect` 不带筛选时返回全部节点、依赖线、素材和 revision；服务停止后仍可读取本地工程。

所有命令默认输出 JSON。画布写操作默认只返回成功状态、revision 和本次相关信息；需要完整画布状态时加全局 `--full`。错误包含 `error`、`code` 并以非零状态退出。默认请求超时为 150000 毫秒，可用全局 `--timeout <毫秒>` 调整。

## 生成依赖与任务记录

仅支持图片、视频节点。箭头从输入素材指向结果，没有“下一步”等标签。输入去重，并禁止自依赖与循环依赖。

```bash
drama-canvas --project ./demo node inputs result-01 image-1 image-2
drama-canvas --project ./demo edge add --from image-4 --to result-01
```

`node inputs` 替换全部输入，不传来源 ID 则清空；`edge add` 追加单条依赖。新建节点也可以使用 `--inputs image-1 image-2`。

生成前先设置依赖，将提示词保存到工程目录，再记录任务：

```bash
drama-canvas --project ./demo generation start result-01 --tool image_gen --prompt-file ./demo/generated/result.prompt.txt
drama-canvas --project ./demo node get result-01
```

保存 `start` 返回的 `node.data.generation.id`。Codex 读取 `generationInputs` 文件路径，交给实际可用的生成工具。生成得到真实文件后完成任务；下例的 `实际任务ID` 必须替换为本次 start 返回的 ID：

```bash
drama-canvas --project ./demo generation complete result-01 --generation-id 实际任务ID --file ./demo/generated/result.png
# 仅在生成失败时执行这一条：
drama-canvas --project ./demo generation fail result-01 --generation-id 实际任务ID --error '生成工具返回的实际失败原因'
```

任务 ID 防止较早的异步任务误写入后来启动的任务。记录包含提示词、工具名、开始/结束时间、输入节点及素材版本和输出素材。`start` 只记录“生成中”，不会调用模型；`complete` 导入真实输出，`fail` 记录失败。输入节点缺少素材、生成中、失败或已过期时，不能作为新任务的输入。`node update --file` 会直接完成该节点当前进行中的任务，异步生成推荐使用带任务 ID 的 `generation complete`。

若已有真实结果，并且可以确认它使用的就是当前输入版本，可补记：

```bash
drama-canvas --project ./demo generation record result-01 --tool image_gen --prompt-file ./demo/generated/result.prompt.txt
```

`record` 使用当前时间和当前输入版本，不用于推测历史来源。旧工程没有生成记录的结果会保留“生成出处未知”，不会伪造当时的提示词或输入版本。

已记录任务的输入素材、依赖或上游生成版本变化后，下游显示“输入已变化”（`stale`），并沿依赖继续传递；不会自动重新生成。Codex 可读取状态，按用户要求重新调用工具。生成期间输入发生变化也不会被完成操作悄悄标记为最新。

## 排列与定位

```bash
drama-canvas --project ./demo layout wedding-1 wedding-2 wedding-3 --mode grid --columns 3
drama-canvas --project ./demo layout image-1 image-2 result-01 --mode dependencies
drama-canvas --project ./demo view focus result-01
drama-canvas --project ./demo view fit
```

`layout` 必须提供节点 ID，或明确加 `--all` 才排列整个画布；支持 `--gap`、`--x`、`--y`。网格排列适合成组图片，`dependencies` 按输入到输出排列。只移动指定节点，未选节点不受影响，但请为整组内容选择足够的空白区域。

`view focus <ID...>` 聚焦节点，`view fit [ID...]` 适配指定节点或全部节点。这些命令通知已连接的查看页面，不改变节点坐标，也不写入工程历史。

## 撤销、重做与恢复

```bash
drama-canvas --project ./demo history --limit 20
drama-canvas --project ./demo undo
drama-canvas --project ./demo redo
drama-canvas --project ./demo restore 12
```

`restore` 的参数是 `history` 返回的历史条目 ID，不是 revision。最多保留 100 个画布快照，包含节点、布局、依赖和生成记录。撤销后再编辑会建立新分支并清除后续重做记录；恢复旧快照也会产生新的画布版本。删除节点、撤销和历史裁剪都不删除原始媒体文件。历史只从此次升级后开始记录，不能还原升级前未保存的操作。

## 媒体导入与旧素材优化

```bash
drama-canvas --project ./demo asset import ./demo/generated/scene.png
drama-canvas --project ./demo asset optimize
drama-canvas --project ./demo asset optimize asset_素材ID
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

工程目录包含 `canvas.sqlite`、`assets/`、`thumbnails/`。生成源文件与提示词也应保存在工作目录，例如 `generated/`。共享服务的 `server.json`、`server.lock`、`server.log` 和 `projects.json` 位于用户级 `~/.local/state/drama-canvas/`，无需随工程分发。每个已打开工程仍会写入自己的 `.server.json` 和 `.server.lock`，用于身份识别并防止旧版服务同时打开该工程；工程中的 `.server.log` 可能是旧版遗留日志。共享运行文件及工程运行文件都不应提交版本控制，尤其不要公开其中的访问令牌。完整备份时先用 `--project <目录> stop` 关闭目标工程，再复制整个工程目录，避免遗漏 SQLite WAL 中的数据；其他工程可继续使用。

`apply --file operations.json` 提交一个原子批次。优先使用 `node.create` 新建、`node.patch` 局部更新；`node.put` 是显式完整替换，需要保留所有未打算清除的字段。批次包含读取到的 `revision` 和唯一 `requestId`；冲突后重新读取并协调，结果未知的重试使用同一请求 ID 和相同内容。最近 500 条请求保存幂等记录，同一 ID 不能用于不同操作。完整示例见插件 Skill。

## 源码开发

修改 CLI 或画布前端时，在源码仓库目录中执行：

```bash
npm install
node src/cli.js --project ./demo start
```

`npm install` 的 `prepare` 脚本会自动构建前端。后续修改前端代码后再执行 `npm run build`；这属于源码开发流程，普通插件用户无需操作。

```bash
# 运行测试
npm test

# 制作包含 CLI 和前端的安装包，打包时自动构建
npm pack
```

CLI 与插件的发布和更新方式见 [发布说明](docs/PUBLISHING.md)。
