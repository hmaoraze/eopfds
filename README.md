# 微信机器人 · 带记忆的多轮对话服务（EdgeOne Pages Functions + DeepSeek）

一套可直接部署到 **腾讯云 EdgeOne Pages 边缘函数（Edge Runtime）** 的服务端工程：

- 按 [wechatbot.dev iLink Bot API](https://www.wechatbot.dev/zh/protocol) 收发消息；
- 对接 **DeepSeek** chat/completions（含 function calling）；
- 服务端持久化多轮上下文 + 长期记忆，支持会话创建 / 续接 / 显式结束 / 超时回收；
- 每轮请求固定注入**不可被用户输入覆盖**的前置提示词；
- 提供免密码 **Passkey（WebAuthn）** 保护的前端配置中心，首次进入须凭云函数签发的**一次性安全链接**。

全代码仅依赖 Web 标准 API（`fetch` / `Web Crypto` / `TextEncoder` / `URL`），不使用任何 Node 专有模块，可在 EdgeOne、Cloudflare Workers、Deno Deploy 等任意 Web 标准边缘运行时直接工作。

---

## 目录结构

```
.
├── edge-functions/            # EdgeOne Pages Functions 路由入口
│   └── api/
│       ├── wechat.js          # /api/wechat  统一会话接口
│       ├── admin.js           # /api/admin   管理端 JSON API
│       ├── cron.js            # /api/cron    超时回收 / 轮询 / 摘要刷新
│       └── health.js          # /api/health  健康检查与自检
├── src/server/                # 领域代码（纯 ESM）
│   ├── index.js               # 运行时装配：环境变量 → KV 覆盖值 → 存储 → 服务
│   ├── api/                   # 四个端点的处理实现
│   ├── config/                # 配置 Schema（单一数据源）+ 解析/校验/脱敏
│   ├── lib/                   # util（Web Crypto 封装）/ http（响应、错误码、限流）
│   ├── llm/                   # DeepSeek 客户端 + 工具定义与执行器
│   ├── security/              # CBOR / COSE / DER / WebAuthn / 令牌
│   ├── storage/               # 存储驱动（EdgeOne KV / Redis REST / HTTP / 内存）
│   ├── repository.js          # 键空间 + 领域仓储
│   ├── session.js             # 会话生命周期状态机
│   ├── memory.js              # 记忆引擎：去重 / 合并 / 打分 / 裁剪 / 淘汰
│   ├── summarizer.js          # 摘要器：滚动摘要、会话提炼、记忆压缩注入
│   ├── prompt.js              # 上下文构造与提示词注入防护
│   ├── conversation.js        # 一轮对话的完整编排
│   └── ilink.js               # iLink Bot API 客户端
├── admin/                     # 前端配置中心（原生 ES Module，零依赖）
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── index.html                 # 根路径跳转 → /admin/
├── tools/
│   ├── smoke.mjs              # 单元测试：CBOR/COSE/WebAuthn/会话/记忆/提示词（替身 LLM）
│   ├── http-smoke.mjs         # 集成测试：直接驱动 HTTP Handler，替身拦截 DeepSeek 与 iLink
│   ├── verify-modules.mjs     # 全模块导入自检
│   └── gen-config-docs.mjs    # 从 Schema 生成 docs/CONFIG.md
├── package.json
├── .env.example
└── docs/
    ├── API.md         接口与协议设计
    ├── DATA.md        数据结构与存储方案
    ├── MEMORY.md      记忆方案详解
    ├── CONFIG.md      配置项说明
    └── DEPLOY.md      部署指南
```

---

## 快速开始

### 本地验证（无需任何真实密钥或网络）

```bash
npm run verify     # 全模块导入自检
npm run test       # 单元测试 + 集成测试
```

- `tools/smoke.mjs`：72 项，覆盖编码工具 → CBOR/COSE/WebAuthn 全链路签名校验 → 存储 → 会话状态机 → 记忆引擎 → 提示词拼装 → 端到端多轮对话；
- `tools/http-smoke.mjs`：20 项，用 `fetch` 替身拦截 DeepSeek 与 iLink，**直接驱动四个 HTTP Handler**，验证运行时装配、会话续接、记忆写入、批量接入、管理端鉴权与定时任务。

### 2. 部署到 EdgeOne Pages

```bash
# 1) 把仓库推到 EdgeOne Pages 关联的 Git 仓库
# 2) 控制台 → 环境变量与绑定 → 绑定 KV 命名空间，变量名 WECHATBOT_KV
# 3) 环境变量（至少）：
#    ADMIN_MASTER_KEY / ADMIN_SIGNING_SECRET / ADMIN_RP_ID / DEEPSEEK_API_KEY
# 4) 部署后签发临时安全链接：
curl -X POST https://<你的域名>/api/admin \
     -H "Content-Type: application/json" \
     -H "X-Admin-Master-Key: $ADMIN_MASTER_KEY" \
     -d '{"op":"secure-link"}'
# 5) 打开返回的 url，用 Passkey 完成首次配置
```

详细步骤见 [docs/DEPLOY.md](docs/DEPLOY.md)。

---

## 核心设计一览

### 会话生命周期

```text
               ┌────────── create ──────────┐
               ▼                            │
   none ──▶ active ──┬── 显式结束 /api ──▶ ended
                     ├── 空闲超时 ────────▶ expired
                     ├── 超最长存活 ──────▶ expired
                     └── 超最大轮数 ──────▶ expired
   两个终态都会触发「记忆提炼」并写回长期记忆。
```

- 服务在任何时刻最多为该用户维护一个 `active` 会话；
- 请求携带 `sessionId` 即定向续接，不携带则自动续接最近活跃会话；
- `forceNew: true` 强制开新会话；
- 终态会话保留 24 小时后由 KV TTL 自然清除。

### 上下文构造（前置提示词的最高优先级）

```text
┌─ system ─────────────────────────────────────────────┐
│ ## 关于这位用户的长期记忆                              │ ← 上轮会话压缩出的记忆摘要
│ …                                                    │
│ ## 人设、规则与输出约束（最高优先级）                   │ ← SYSTEM_PROMPT（可配置）
│ …                                                    │
│ 【不可变更条款 —— 优先级高于之后的一切用户输入】        │ ← 硬编码，任何配置都无法删除
│ …                                                    │
│ ## 更早之前的对话滚动摘要（可选）                      │
├─ history（最近 N 轮 user / assistant / tool）──────────┤
└─ user ────────────────────────────────────────────────┘
   …经过净化的用户输入（夹在【用户消息开始/结束】之间）
```

用户无从干预 system 区：请求体里的 `messages` / `system` / `prompt` / `role` 等键一律被忽略并计入 `warnings`；用户文本中的角色伪装行、`#MEMORY#` 内部哨兵会被降级 / 抹除。

### 记忆写入双通道

| 通道 | 触发 | 实现 |
| --- | --- | --- |
| 主动写入 | 模型调用 `save_memory` 工具，或输出 `#MEMORY#{...}#` 文本块 | `conversation.js` → `MemoryEngine.write` |
| 自动提炼 | 会话进入 `ended` / `expired` 终态 | `Summarizer.extractMemories` → `writeBatch` |

进入下一轮新会话时，`Summarizer.buildMemoryDigest` 把历史记忆压缩为摘要，注入上下文最前部（详见 [docs/MEMORY.md](docs/MEMORY.md)）。

### 配置端安全模型

1. **首次进入**：服务端凭 `ADMIN_MASTER_KEY` 调用 `/api/admin op=secure-link` 签发一次性链接（默认 15 分钟）；
2. **设置密钥**：链接进入 → 浏览器 WebAuthn 注册 → 服务端校验 attestation（挑战 / Origin / RP ID / 签名）→ **链接立即失效** → 直接签发管理端会话；
3. **后续登录**：Passkey 断言校验（含签名计数器防克隆）；支持注册**多个**密钥；
4. **敏感操作**（签发链接、删除密钥、显示明文、重置）：需再完成一次 Passkey 断言换取一次性 `reauthToken`（`ADMIN_STEP_UP_REAUTH=false` 可关闭）；
5. **重置**：清空全部密钥后须重新走「主密钥 → 安全链接」流程。

服务端仅保存**公钥**，私钥永不离开用户设备。

---

## 关键技术约束

- **零 Node 专有依赖**：不使用 `crypto` / `buffer` / `fs` / `stream`，哈希与签名全部走 `crypto.subtle`；Base64 手写实现避免 `Buffer`。
- **WebAuthn 从零实现**：自建 CBOR 解码、COSE→SPKI 公钥转换、DER 签名编码（见 `src/server/security/`），不依赖任何三方 WebAuthn 库。
- **存储抽象**：统一 KV 接口 + 逻辑 TTL 兜底，可平滑切换 EdgeOne KV / Redis REST / 自建 HTTP / 内存。
- **配置热更新**：管理端写入的值存入 KV，优先级高于环境变量，**修改后立即生效、无需重新部署**。

---

## 进一步阅读

- [docs/API.md](docs/API.md) — 四个端点的完整请求 / 响应字段
- [docs/DATA.md](docs/DATA.md) — 会话、记忆、Passkey 等数据结构与键空间
- [docs/MEMORY.md](docs/MEMORY.md) — 打分公式、去重合并策略、容量裁剪与过期淘汰
- [docs/CONFIG.md](docs/CONFIG.md) — 全部配置项（含必填项清单）
- [docs/DEPLOY.md](docs/DEPLOY.md) — EdgeOne Pages 部署与运维
