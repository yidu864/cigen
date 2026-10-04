# 词根词缀记忆工坊 (cigen)

用 [`https://pdfresources.com/`](https://pdfresources.com/) 找到的词根 PDF 起步，从其中自动抽取词根词缀与例词，
构建一个交互式记忆 Web App，并支持从 DeepSeek 分享对话继续导入数据、通过 WebDAV / Google Drive 云同步学习进度。

在线 Pages 地址：<https://yidu864.github.io/cigen/>

> 2.0 已迁移到 **Vue 3 + TypeScript + Vite**，并新增「云同步」与「DeepSeek 分享导入」两大功能。

## 功能

- **词根/词缀检索与浏览**：搜索词根、中文提示、例词释义，支持随机跳转与分页加载
- **词根详情**：例词 + 拆解 + 中文释义，可一键标记「已掌握」
- **闪卡训练**：显示答案 / 再看一次 / 我记住了 / 下一张
- **选择题训练**：本地记录正确率
- **多数据集**：内置 PDF 数据集 + 任意多个导入数据集可自由启用/停用
- **响应式布局**：桌面双栏 → 手机单栏，标签页/统计条横向滑动、按钮全宽可点、适配刘海屏安全区
- **浅色 / 深色主题**：右上角一键切换（自动跟随系统 / 浅色 / 深色），本地记忆选择，首屏无闪烁
- **云同步（新）**：基于 [remoteStorage.js](https://github.com/remotestorage/remotestorage.js)，支持
  - **WebDAV**（Nextcloud / ownCloud / 坚果云 / 任意 WebDAV 目录）
  - **Google Drive**（Google Cloud OAuth 客户端，remoteStorage.js 内置后端）
  - **remoteStorage 协议服务器**（user@host 账号）
  - 以 JSON 文件同步学习进度（`progress.json`）与词根数据集（`datasets/*.json`）
  - 进度合并策略：已掌握词根取并集、测验/闪卡计数取最大值，多设备不会互相覆盖
- **DeepSeek 分享导入（新）**：Node.js 脚本抓取公开分享内容，再用 OpenAI 兼容接口让 LLM 抽取词根数据
- **本地学习进度**：`localStorage` + remoteStorage 本地缓存（IndexedDB）

## 目录结构

```
public/data/roots_affixes.json     内置数据集（PDF 提取结果）
public/data/datasets/index.json    导入数据集清单（由导入脚本维护）
public/data/datasets/*.json        导入的数据集
src/
  App.vue                          页面骨架与标签页
  components/                      学习地图 / 闪卡 / 选择题 / 云同步面板
  data/                            数据集加载、词根索引构建、进度纯函数
  stores/                          数据集、进度、同步的响应式状态
  sync/                            remoteStorage.js 集成 + WebDAV 传输实现
  styles/main.css                  样式（CSS 变量主题 + 响应式断点）
scripts/
  extract_pdf_data.py              从 PDF 生成数据集
  import-deepseek.ts               从 DeepSeek 分享导入词根（Node.js）
  lib/                             抓取伪装、OpenAI 兼容 LLM 客户端、抽取与校验
tests/
  sync.test.ts                      WebDAV 同步链路集成测试（本地假服务器，无需外网）
  import-deepseek.test.ts           导入脚本端到端测试（假分享接口 + 假 LLM）
  theme.test.ts                     主题偏好解析 / 应用 / 持久化
  render-check.ts                   Vite SSR 整体渲染检查
.github/workflows/deploy.yml       GitHub Pages 自动部署
```

## 快速开始

```bash
npm install
npm run dev         # http://localhost:5173
npm run build       # 产物在 dist/，可直接部署到任意静态托管
npm run typecheck
npm test            # 使用本地假服务器跑通 WebDAV 同步与导入脚本（无需外网）
npm run test:render # 用 Vite SSR 渲染整个应用，快速发现模板/数据错误
```

## 1. 导入 DeepSeek 分享的词根数据

分享链接形如 `https://chat.deepseek.com/share/xt2cibe2byagd207uj`，其中 `xt2cibe2byagd207uj` 就是 `share_id`。

脚本分两步：

1. **抓取**：请求 `https://chat.deepseek.com/api/v0/share/content?share_id=<id>`，
   并做了简单的反爬伪装——真实浏览器 `User-Agent`（含 `Sec-CH-UA` / `Sec-Fetch-*` 等客户端提示头）、
   `Referer: https://chat.deepseek.com/share/<id>`、`Origin`、`Accept-Language`，请求间随机延迟 + 指数退避重试 + 超时 + 可选中转代理，原始响应缓存到 `.import-cache/` 便于复跑。
2. **抽取**：把助手回答拼成原文（可含思考过程），按长度切片后发给 **OpenAI 兼容**的
   `POST {baseURL}/chat/completions`（默认 `response_format: {"type":"json_object"}`），
   要求模型只输出 `word / meaning / decomposition / components`，再由脚本做严格校验
   （小写、去重、成分规范化、丢弃「不拆」与无法拆解的条目），最后用与 PDF 脚本一致的算法重算
   `roots`（`wordCount` / `sampleWords` / `gloss`），写成可直接被前端加载的数据集。

```bash
# 默认走 DeepSeek 官方 OpenAI 兼容接口
export DEEPSEEK_API_KEY=sk-xxx
npm run import:deepseek -- --share-id xt2cibe2byagd207uj

# 也可以换成 OpenAI / 任意兼容网关 / 本地 Ollama
export OPENAI_API_KEY=sk-xxx
npm run import:deepseek -- --share-id xt2cibe2byagd207uj \
  --llm-base-url https://api.openai.com/v1 --model gpt-4o-mini

npm run import:deepseek -- --share-id a1b2c3 --id deepseek-roots --append
npm run import:deepseek -- --help
```

常用参数：

| 参数                                                                                               | 说明                                          |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `--share-id <id>`                                                                                  | 可重复或用逗号分隔，也可直接作为位置参数      |
| `--input <file>`                                                                                   | 直接读取已下载的分享 JSON（离线／已有缓存时） |
| `--ua-profile` / `--user-agent` / `--referer` / `--cookie`                                         | 抓取伪装细节                                  |
| `--delay` / `--jitter` / `--retries` / `--timeout` / `--proxy`                                     | 抓取节奏与网络选项                            |
| `--model` / `--llm-base-url` / `--llm-api-key` / `--temperature` / `--chunk-chars` / `--json-mode` | LLM 抽取选项                                  |
| `--out-dir` / `--id` / `--label` / `--append` / `--dry-run` / `--print`                            | 输出控制                                      |

数据写入 `public/data/datasets/<id>.json` 并自动更新 `public/data/datasets/index.json`；
刷新页面后即可在顶部数据集开关里启用。

> 提示：请只导入你有权访问的公开分享内容，并遵守目标站点的服务条款。

## 2. 云同步配置

打开「云同步」标签页，选择后端并填写配置：

### WebDAV

需要服务器允许跨域请求（CORS）并允许 `PROPFIND`、`MKCOL` 方法：

- Nextcloud：在 `config.php` 增加
  `'cors.allowed-domains' => ['https://<你的用户名>.github.io']`
- 公共 WebDAV（如坚果云）若未开放 CORS，浏览器会直接拦截请求，需要自建反向代理补上 `Access-Control-Allow-*` 头

地址填到目录一级即可，例如 `https://cloud.example.com/remote.php/dav/files/me/cigen/`，
脚本会自动创建不存在的目录。密码默认只保存在当前会话（`sessionStorage`），可勾选「在本机记住密码」写入 `localStorage`。

### Google Drive (Google Cloud)

1. 在 Google Cloud Console 创建项目并启用 **Google Drive API**
2. 创建「OAuth 2.0 客户端 ID（Web 应用）」，把站点地址加入 **已获授权的重定向 URI**
   （例如 `https://yidu864.github.io/cigen/`，注意结尾斜杠）
3. 把客户端 ID 填进表单（或在 CI 里配置 `VITE_GOOGLE_CLIENT_ID` 变量）

数据保存在 Drive 的 `remotestorage/cigen/` 目录，授权范围为 Google Drive 文件。

### remoteStorage 协议服务器

填写 `user@host`（例如自建 [armadietto](https://github.com/remotestorage/armadietto)），
点击连接会跳转到服务商完成 OAuth，返回后自动开始同步。

### 同步的文件

| 文件                    | 内容                             | 合并策略                                               |
| ----------------------- | -------------------------------- | ------------------------------------------------------ |
| `cigen/progress.json`   | 已掌握词根、测验正确率、闪卡计数 | 已掌握取并集，计数取最大值；冲突时也会按并集合并后写回 |
| `cigen/datasets/*.json` | 导入的词根数据集                 | 可上传 / 拉取 / 删除，按文件整体覆盖                   |

## 主题与移动端

- 主题偏好保存在 `localStorage`（`cigen-theme-v1`），`index.html` 内联脚本会在首屏绘制前写入 `<html data-theme>`，避免闪烁；
  所有颜色都由 `src/styles/main.css` 顶部的 CSS 变量提供，深色只是换一套变量。
- 切换入口在标题右侧（自动 / 浅色 / 深色），`src/stores/theme.ts` 负责解析与持久化。
- 断点：`≤900px` 学习地图变单栏、闪卡按钮两列；`≤720px` 顶栏与标签页横向滑动、表单控件 16px（防 iOS 缩放）、
  同步面板按钮全宽；`≤420px` 主题切换铺满整行。触屏设备统一加高点击区域。

## 3. 重新生成 PDF 数据集（可选）

```bash
pip install pymupdf
python3 scripts/extract_pdf_data.py            # 输出 public/data/roots_affixes.json
```

## 部署到 GitHub Pages

仓库已包含 `.github/workflows/deploy.yml`：推送到 `main` 后自动 `npm ci → typecheck → test → build`，
并用官方 Pages Actions 发布 `dist/`。

1. 仓库 **Settings → Pages → Source** 选择 **GitHub Actions**
2. （可选）在 **Settings → Secrets and variables → Actions → Variables** 添加
   `VITE_GOOGLE_CLIENT_ID`、`VITE_WEBDAV_URL`、`VITE_REMOTESTORAGE_ADDRESS`
3. 推送后即可通过 `https://<用户名>.github.io/cigen/` 访问

构建时的 `base` 会从 `GITHUB_REPOSITORY` 自动推导；本地构建可用 `VITE_BASE=/ npm run build` 覆盖
（例如部署到用户主页 `https://<用户名>.github.io/` 时）。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=yidu864/cigen&type=Date&theme=dark" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=yidu864/cigen&type=Date" />
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=yidu864/cigen&type=Date" />
</picture>
