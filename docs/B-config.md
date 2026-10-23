# 阶段 B · 配置项说明

> 对应阶段 A 交付物 D9。所有配置只从 `context.env` 读取（A1），没有第二来源，也没有内置密钥。

## 1. 配置读取规则

| 规则 | 行为 |
|---|---|
| 空字符串 | 视为「未配置」（`"   "` 不等于已配置） |
| 数字越界/非数字 | 记入 `invalidEntries`，业务接口返回 503，不静默使用默认值 |
| 枚举非法 | 同上（例如 `PROMPT_INJECTION_MODE=auto`） |
| 缺省（完全未设置） | 可选项目用默认值；必填项进入 `requiredMissing` |
| 必填项缺失 | 业务接口统一 `503 CONFIG_MISSING` + `details.requiredMissing`，不降级运行 |

## 2. 必填项（4 项，缺失即拒绝服务）

| 变量 | 类型 | 说明 | 缺失后果 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | string | DeepSeek 直连密钥。**不可**用 `MAKERS_MODELS_KEY` 替代（C2） | 503，`requiredMissing` 含本项 |
| `BLOB_STORE_NAME` | string | Blob Store 名称，非敏感，可在状态页明文展示 | 503 |
| `SYSTEM_PROMPT` | string | 前置提示词全文（人设、行为规则、输出格式约束），去空白后不得为空 | 503 / `PROMPT_EMPTY` |
| `SESSION_TIMEOUT_MS` | int(ms) | 会话超时阈值，`1000 ~ 2592000000`（1 秒 ~ 30 天） | 503 |

> 为什么 `SESSION_TIMEOUT_MS` 算必填：超时时长直接决定「什么时候触发记忆提炼」。给一个隐含默认值会让运维在不知情的情况下改变提炼节奏。

## 3. 上游与提示词

| 变量 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `DEEPSEEK_BASE_URL` | string | `https://api.deepseek.com` | — | 末尾斜杠会被去掉 |
| `DEEPSEEK_MODEL` | string | `deepseek-chat` | — | 换成 `deepseek-reasoner` 时注意它不支持 `tools`，需同时 `MEMORY_TOOL_ENABLED=false` |
| `DEEPSEEK_TIMEOUT_MS` | int(ms) | `45000` | 1000~120000 | 单次上游请求超时。部署到平台时建议 20000，须小于 `maxDuration` |
| `DISTILL_TIMEOUT_MS` | int(ms) | `15000` | 3000~60000 | 通道 B 提炼的独立超时，避免它吃掉整轮函数时长 |
| `DISTILL_LOCK_TTL_MS` | int(ms) | `600000` | 60000~3600000 | 提炼租约：进程被回收后，超过该时长才允许另一个任务接管重试 |
| `PROMPT_INJECTION_MODE` | enum | `dual_system` | `dual_system` \| `merged_single_system` | system 段装配形态，非法值直接 503 |
| `HISTORY_MAX_MESSAGES` | int | `60` | 4~400 | 发往上游的历史窗口（不含 system 段） |
| `TOOL_MAX_ROUNDS` | int | `3` | 1~6 | `save_memory` 工具循环上限，用尽后改为无 tools 的终结请求 |
| `SESSION_BUSY_TTL_MS` | int(ms) | `120000` | 5000~900000 | in-flight 标记的有效期，超时后允许下一轮接管（防止进程崩溃锁死会话） |

## 4. 记忆治理

| 变量 | 类型 | 默认 | 范围 | 说明 |
|---|---|---|---|---|
| `MEMORY_TOOL_ENABLED` | bool | `true` | `true`/`false` | 关闭后不声明 `save_memory`，通道 B 仍生效 |
| `MEMORY_MAX_ITEMS` | int | `500` | 1~20000 | 单用户活跃记忆上限，超出按 weight 升序逻辑淘汰 |
| `MEMORY_TTL_MS` | int(ms) | `7776000000`（90 天） | 60000~315360000000 | 滑动过期：每次合并/召回刷新 `expiresAt` |
| `MEMORY_TOP_K` | int | `8` | 1~50 | 新会话召回的条数 |
| `MEMORY_DECAY_LAMBDA` | float | `0.02` | 0~1 | 权重衰减系数（按天）。0.02 ≈ 35 天半衰期 |
| `MEMORY_DEDUP_THRESHOLD` | float | `0.82` | 0.5~1 | 相似度合并阈值。调低会更激进地合并 |
| `MEMORY_DEDUP_SCAN_LIMIT` | int | `300` | 10~5000 | 单次去重/召回扫描的记忆文件上限（读放大控制） |
| `MEMORY_HARD_DELETE_AFTER_MS` | int(ms) | `604800000`（7 天） | 0~315360000000 | 非活跃记忆保留多久后物理删除 |
| `MEMORY_SUMMARY_MAX_CHARS` | int | `1200` | 200~8000 | 注入 system 段的摘要长度上限 |

## 5. 管理面

| 变量 | 类型 | 默认 | 必填 | 说明 |
|---|---|---|---|---|
| `ADMIN_TOKEN` | string | — | 管理面必填 | Bearer token，建议 ≥32 位随机串 |
| `ADMIN_HMAC_SECRET` | string | — | 管理面必填 | 签名密钥，建议 ≥32 位随机串，与 token 不同值 |
| `ADMIN_AUTH_MAX_SKEW_MS` | int(ms) | `300000` | 否 | 时间戳允许偏差，超出视为重放 |
| `ADMIN_OPENID_ALLOWLIST` | csv | 空 | 否 | openid 白名单，逗号分隔 |
| `ADMIN_OPENID_GATEWAY_SECRET` | string | — | 条件必填 | 与白名单同时配置才启用 openid 通道 |

管理面缺凭据时 `/admin/*` 返回 503，**不影响** `/session/*` 与 `/wechat/*`——管理面故障不应阻断对话。

### 5.1 鉴权两种通道

**通道一：Bearer + HMAC（默认，推荐）**

```
base = METHOD \n PATH \n TIMESTAMP \n sha256_hex(rawBody)
sig  = hmac_sha256_hex(ADMIN_HMAC_SECRET, base)
```

服务端依次校验：token（常量时间，先各自哈希再比）→ 时间窗 → 签名（常量时间）。
三个缺一不可：只校验 token 会被抓包重放，只校验签名则签名本身等于凭据。

**通道二：openid 白名单（仅当网关签名可用时）**

```
sig = hmac_sha256_hex(ADMIN_OPENID_GATEWAY_SECRET, openid \n timestamp)
```

为什么必须加网关密钥：`X-Wechat-Openid` 是一个普通请求头，任何人都能填。没有网关签名时，「openid 白名单」等价于「知道某人 openid 就能进管理面」，而 openid 在群里、日志里都可能出现。因此实现上做了硬性要求：白名单与网关密钥缺一不可，否则该通道不启用（状态页会给出 warning）。

### 5.2 不接受的方案

- 前端传 `isAdmin: true` 或 `role: "admin"`：客户端自证，改一行 JS 即可绕过。
- 把 token 放 `localStorage`：配置页刻意只把凭据放在当前标签页内存中，刷新即失效。

## 6. 微信 / iLink

| 变量 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `WECHATBOT_BASE_URL` | url | `https://ilinkai.weixin.qq.com` | 网关地址 |
| `WECHATBOT_TOKEN` | string | — | 网关凭据，缺失则 `wechat.configured=false` |
| `WECHATBOT_WEBHOOK_SECRET` | string | — | 回调校验头 `x-wechatbot-secret`；缺失时回调接口 503（不静默放行） |
| `WECHATBOT_GETUPDATES_PATH` | path | `/ilink/bot/getupdates` | 长轮询端点 |
| `WECHATBOT_SEND_PATH` | path | `/ilink/bot/sendmessage` | 发送端点 |
| `WECHATBOT_POLL_TIMEOUT_MS` | int(ms) | `10000` | 单次长轮询持有时间 |
| `CRON_SECRET` | string | — | 定时任务凭据；缺失时任务接口 503 |

### 6.0 定时任务凭据的三种载体

平台内置 `schedules` 只能配置 path / method / payload，**不能自定义请求头**，所以凭据按以下顺序读取（`src/auth.js#verifyCronRequest`）：

1. `x-cron-secret` 请求头（外部调度器首选，不进访问日志）
2. `?token=` 查询参数（会进访问日志，能不用就不用）
3. `payload.token`（平台 schedules 唯一可行的方式）

三种都走常量时间比较。放入 `edgeone.json` 的 `payload.token` 是明文，建议在控制台配置任务而不要把真实密钥提交进仓库。

### 6.1 字段差异怎么处理

不同租户的 iLink 网关对同一语义字段的命名不同（`text` / `content` / `item_list[0].text_item.text`）。`src/wechat.js#normalizeInbound` 做了多形态归一，**部署时只需按你的实际报文核对该函数**，业务代码零改动。首次接入建议：先用 `/api/wechat/poll` 拉一批真实报文，打印归一结果确认字段映射，再开启自动回复。

### 6.2 为什么不用「一次请求内死等长轮询」

函数有执行时长上限，长轮询只能「短持有 + 高频触发」：单次 `timeout=10s`，调度器每 30 秒调一次 `/api/wechat/poll`。如果平台提供 webhook 推送，优先用 webhook（延迟更低，也不消耗轮询配额）。

## 7. 平台侧配置步骤

1. **确认 Blob 可用**：Blob 不需要在控制台预先创建 Store，`getStore({ name })` 首次调用即按名字创建命名空间，属于「即用即得」。控制台存储页只用来看用量（免费版 1 GB/账户）。强一致写在代码里（`src/blob.js`），不在控制台开关。
2. **确认 SDK 版本**：`package.json` 中 `@edgeone/pages-blob` 为 `>=0.0.14`。`consistency` 与 `onlyIfNew` 依赖该版本。
3. **确认运行时与目录**：函数必须放在 `node-functions/`（Blob 只有 Node.js SDK，`edge-functions/` 会 import 失败）。
4. **写入环境变量**：按第 2~6 节逐项配置。`SYSTEM_PROMPT` 支持多行，控制台输入框通常保留换行。**改完必须重新部署**才会注入。
5. **暴露静态页**：`public/admin.html` 发布在 `/admin.html`，由 `edgeone.json` 的 `outputDirectory: "./public"` 决定；页面默认把当前路径前缀之前的段当作 API base，若挂载点不是 `/api`，改 `guessBase()` 的兜底值。
6. **配置定时任务**：
   - `/cron/maintenance`：每小时一次（结算超时会话 + 提炼 + 记忆淘汰 + 物理清理）。平台 `schedules` 已写在 `edgeone.json`，需替换 `payload.token`。
   - `/api/wechat/poll`：每 30 秒一次。平台 schedules 粒度不够，用外部调度器带 `x-cron-secret`；若网关支持 webhook 推送则不需要它。

完整部署步骤见 [`B-deploy-guide.md`](B-deploy-guide.md)。

## 8. 配置自检顺序

```
GET /api/health
  ├─ requiredMissing 非空 → 补齐必填项
  └─ configured: true
        ↓
GET /api/admin/config/status（签名）
  ├─ checks.*.configured 是否有 false
  ├─ warnings 是否有 MAKERS_MODELS_KEY 误用提示
  └─ ok: true
        ↓
POST /api/session/create → POST /api/session/{id}/message（验证上游连通与记忆写入）
```
