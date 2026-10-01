# 发布 CLI 和 Codex 插件

源码仓库：<https://github.com/zhangtuo723/drama-canvas>。CLI 与插件共用版本，目前是 `0.2.1`。当前仓库发布不代表 npm 或官方插件目录已经上架。

## 未发布 npm 时直接安装

用户或 agent 可以直接让 npm 从公开 GitHub 仓库安装，不需要 npm 登录：

```bash
npm install --prefix "$HOME/.local/share/drama-canvas-cli" 'git+https://github.com/zhangtuo723/drama-canvas.git#main'
"$HOME/.local/share/drama-canvas-cli/node_modules/.bin/drama-canvas" --version
```

需要 Git、Node.js 22.12+ 和 npm。`prepare` 会在 Git 安装时构建画布前端；请允许 npm 执行生命周期脚本。需要固定版本时，把 `#main` 替换为完整提交 SHA。npm 支持的 Git 安装行为见 [官方安装说明](https://docs.npmjs.com/cli/v10/commands/npm-install/)。

上述为 macOS/Linux 的用户目录安装方式，后续用该绝对路径调用即可，不需要改 PATH。也可在独立工具目录中运行 `npm install 'git+https://github.com/zhangtuo723/drama-canvas.git#main'`，再调用 `node_modules/.bin/drama-canvas`。当前 npm 10 的直接 Git 全局安装可能在准备阶段发生冲突，因此优先使用非全局安装。

若需要全局命令，先打包 Git 源，再全局安装构建好的 tgz（第二行文件名以 npm pack 输出为准）：

```bash
npm pack 'git+https://github.com/zhangtuo723/drama-canvas.git#main'
npm install -g ./drama-canvas-0.2.1.tgz
```

插件 Skill 已包含首次使用时检查和安装 CLI 的步骤；插件被加载时不会自行运行安装命令。

## 从 GitHub 源码开发

需要 Node.js 22.12 或更高版本：

```bash
git clone https://github.com/zhangtuo723/drama-canvas.git
cd drama-canvas
npm ci
npm run build
npm link
drama-canvas --version
```

`dist/` 不提交 Git；`npm ci` 会通过 `prepare` 自动构建，改动前端后可再次运行 `npm run build`。

## 发布 CLI 到 npm

1. 确认 npm 账户、包名归属及希望采用的许可证；当前未添加开源许可证。
2. 在本机登录 npm，按提示完成身份及双因素验证。
3. 构建、测试并检查即将上传的包，再发布。

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
npm view drama-canvas name version --registry=https://registry.npmjs.org
npm run build
npm test
npm pack --dry-run
npm publish --access public --registry=https://registry.npmjs.org
```

`npm view` 返回 404 表示当时查不到该包，并不保证发布时名称一定可用。若名称已被占用，使用自己拥有的 npm scope，并同步修改 package.json、lockfile 与安装说明。发布成功后，用户才可运行 `npm install -g drama-canvas`。

项目已配置 `prepublishOnly`，发布前自动执行构建及测试。不要上传 demo、个人照片、数据库和令牌。CLI 的 `files` 白名单仅包含运行代码、构建产物、插件及 README。

也可以先运行 `npm pack`，把 `drama-canvas-0.2.1.tgz` 作为 GitHub Release 附件分发；接收者执行 `npm install -g ./drama-canvas-0.2.1.tgz`。原生依赖会按接收者的平台安装。视频探测使用 FFprobe，目前其安装包不覆盖 Windows ARM64。

npm 账户及发布认证要求以 [npm 官方发布文档](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/) 为准。后续自动发布可使用 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)，此仓库 CI 目前只测试，不会自动发布。

## 通过 GitHub 安装 Codex 插件

仓库的 `.agents/plugins/marketplace.json` 已指向 `./plugin`。在支持这些命令的 Codex CLI 中执行：

```bash
codex plugin marketplace add zhangtuo723/drama-canvas --ref main
codex plugin add drama-canvas@drama-canvas-plugins
```

命令参数已依据本机 `codex plugin --help` 核对。也可以在桌面端插件目录中选择 **Drama Canvas** 来源进行安装。客户端版本可能影响具体入口；必要时重启客户端。

此插件提供 Skill，让 Codex 调用本地 `drama-canvas`，不内置生图模型。可以先手动安装 CLI，也可以让 agent 在首次执行画布任务时按 Skill 指引检查并安装。

更新仓库后，可以刷新 marketplace：

```bash
codex plugin marketplace upgrade drama-canvas-plugins
```

目录结构和 marketplace 分发方式参见 [OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins)。

## 上架官方插件目录

GitHub marketplace 分发与官方目录审核是两个流程。当前插件是本地 CLI 的 Skill 包，需在提交说明中明确本地执行和单独安装 CLI 的要求。

在仓库根目录制作 ZIP，让 manifest 和 skills 位于压缩包根目录：

```bash
mkdir -p release
(cd plugin && zip -r ../release/drama-canvas-plugin-0.2.1.zip plugin.json .codex-plugin skills)
```

使用已验证的开发者身份，在 OpenAI Plugins 页面上传 ZIP，处理自动检查结果后提交审核，获批后再发布。提交资格与审核结果尚未在本项目上验证，不能保证通过。[官方提交说明](https://developers.openai.com/plugins/deploy/submission)

## 后续版本

同步更新 `package.json`、`package-lock.json`、`plugin/plugin.json` 与 `plugin/.codex-plugin/plugin.json` 的版本，运行构建和测试，提交代码，再按所需渠道发布。npm 已发布的版本需通过新版本号更新。

`.github/workflows/ci.yml` 在 main 提交和 PR 上执行 Linux 构建、测试和打包检查。截图、demo、数据库、运行日志、访问令牌和本地产物保留在工作目录，已由 `.gitignore` 排除。
