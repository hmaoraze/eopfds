# EdgeOne Makers 对话服务

腾讯云 EdgeOne Makers Node Functions 上的微信对话机器人服务端：DeepSeek 对话 + Blob 长期记忆 + iLink 协议。

两阶段交付：

| 阶段 | 产物 | 说明 |
|---|---|---|
| A | [`docs/A-server-prompt.md`](docs/A-server-prompt.md) | 优化后的开发提示词（A/B/C 三组硬约束 + D1~D10 交付物 + 10 条验收口径） |
| B | 本仓库 | 严格按阶段 A 实现的工程代码与文档 |

阶段 B 的每份文档、每个模块都回指阶段 A 的编号，映射表见 `docs/B-api-and-data.md` 第 9 节。

## 快速开始

```bash
npm test                                   # 61 个用例，零外部依赖、不联网
node scripts/dev-server.mjs 8787           # 本地预览（假 Blob + 假上游）
```

部署看 **[`docs/B-deploy-guide.md`](docs/B-deploy-guide.md)**，从创建项目到微信收发一条真实消息，逐步带判断标准。

## 三个平台事实（决定部署形态）

| 事实 | 对本项目的影响 |
|---|---|
| 函数目录是 `node-functions/` | 所有接口都在 `node-functions/api/[[default]].js` |
| Blob 只有 Node.js SDK | 只能部署为 Node Functions，不能放 `edge-functions/` |
| Node Functions 没有 `waitUntil`，单次默认 30 秒 | 提炼任务改为「有 waitUntil 用它，没有就同步等待 + 租约重试」；`maxDuration` 调到 60 |

## 硬约束落点

| 约束 | 落点 |
|---|---|
| `export default function onRequest(context)`，只读 `context.env` | `node-functions/api/[[default]].js`、`src/config.js` |
| Blob `consistency: "strong"`（≥ 0.0.14） | `src/blob.js`，唯一 `getStore` 调用点 |
| 上游无状态，每轮拼完整历史 | `src/prompt.js#composeRequestMessages` |
| `context_token` 原样回传，缺失拒发 | `src/wechat.js#sendText` |
| 一记录一文件 + `onlyIfNew` 幂等 | `src/memory.js`、`src/blob.js#setJSONIfAbsent` |
| 无托管数据库，key 即 schema | `docs/B-api-and-data.md` 第 4 节 |

## 设计上最值得先看的三件事

1. **system 段不落库**。会话文档只存 user/assistant/tool，system 段每轮由配置现场装配；历史里的 `role: "system"` 一律丢弃。落库会产生「可被历史改写的 system 副本」，这是提示词锁定最容易漏的口子。审计靠 `systemSnapshot` 的提示词哈希。
2. **一轮对话分两段短临界区**，上游调用期间不持锁。整轮持锁会把 10~40 秒网络耗时包进锁租约，函数时长与并发都会被锁绑架；改用 `pendingTurn` in-flight 标记，只拒绝真正会撕裂上下文的并发轮次。
3. **记忆淘汰是逻辑删除**。Blob 没有 TTL 自动删除，`isActive = false` 之后必须有人做物理清理，`node-functions/cron/maintenance.js` 就是干这个的——少了它，存储会只增不减。

## 文档

- [`docs/A-server-prompt.md`](docs/A-server-prompt.md) — 阶段 A 提示词
- [`docs/B-deploy-guide.md`](docs/B-deploy-guide.md) — **部署教程**（环境变量、部署三法、定时任务、微信接入、故障排查）
- [`docs/B-api-and-data.md`](docs/B-api-and-data.md) — 端点、错误码、Blob key 方案、数据结构、记忆流水线、并发控制
- [`docs/B-config.md`](docs/B-config.md) — 配置项、鉴权方案、平台侧步骤
- [`docs/B-deploy-verify.md`](docs/B-deploy-verify.md) — 10 条验收口径的逐条判定方法与已知边界
