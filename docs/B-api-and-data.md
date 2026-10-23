# 阶段 B · 接口与数据结构

> 对应阶段 A 交付物 D1 / D2 / D3 / D8。所有示例均为真实响应结构（字段名与源码一一对应）。

## 1. 调用约定

| 项目 | 约定 |
|---|---|
| 基址 | 函数挂载在 `/api/*`（`node-functions/api/[[default]].js`） |
| 编码 | 请求与响应均为 `application/json; charset=utf-8` |
| 缓存 | 所有响应带 `cache-control: no-store` |
| 幂等 | 创建会话用 `onlyIfNew`；结束会话幂等；记忆写入按内容哈希幂等 |
| 错误体 | `{ "error": { "code", "message", "details?", "requestId" } }` |
| 用户标识 | `userId` 只允许 `[A-Za-z0-9_-]{1,64}`（微信侧取 openid，网页侧取自有 id） |

## 2. 端点清单

### 2.1 健康检查

`GET /api/health` — 无需配置即可访问，用于部署后自检。

```json
{
  "ok": true,
  "service": "edgeone-makers-chat",
  "time": 1760000000000,
  "configured": false,
  "requiredMissing": ["DEEPSEEK_API_KEY", "BLOB_STORE_NAME", "SYSTEM_PROMPT", "SESSION_TIMEOUT_MS"],
  "promptInjectionMode": "dual_system",
  "memoryToolEnabled": true
}
```

### 2.2 创建会话（新建）

`POST /api/session/create`

```json
{ "userId": "u_1001", "metadata": { "channel": "web" } }
```

响应 `201`：

```json
{
  "sessionId": "s_mf3k2a9x1b7c",
  "status": "active",
  "createdAt": 1760000000000,
  "expiresAt": 1760001800000,
  "sessionTimeoutMs": 1800000,
  "memorySummaryApplied": true,
  "memorySummaryItemCount": 5,
  "promptInjectionMode": "dual_system"
}
```

创建时执行一次记忆召回（top-K），摘要写入会话文档并缓存在 `memorySummary`；同一会话内不再重算。

### 2.3 续接会话

`POST /api/session/resume` — 有可续接会话则复用，否则新建。

```json
{ "userId": "u_1001" }
```

响应 `200`（复用）或 `201`（新建）：

```json
{
  "created": false,
  "session": { "sessionId": "s_...", "status": "active", "expiresAt": 1760001800000, "turnCount": 3 }
}
```

「可续接」判定：`status === "active"` 且 `now - lastActiveAt <= sessionTimeoutMs`。超时会话会被就地结算为 `expired` 并返回 `created: true`。

### 2.4 发送消息（一轮对话）

`POST /api/session/{sessionId}/message`

```json
{ "userId": "u_1001", "text": "帮我记住：我下周三要去上海出差" }
```

响应 `200`：

```json
{
  "sessionId": "s_...",
  "reply": "记下了，下周三上海出差。",
  "turnCount": 4,
  "lastActiveAt": 1760000120000,
  "expiresAt": 1760001920000,
  "toolRounds": 1,
  "memoryWrites": [{ "ok": true, "memoryId": "9f2c…", "deduped": false, "action": "created" }],
  "usage": { "promptTokens": 820, "completionTokens": 96, "totalTokens": 916 },
  "finishReason": "stop",
  "toolsExhausted": false,
  "stale": false
}
```

错误：
- `404 SESSION_NOT_FOUND`
- `409 SESSION_BUSY`（上一轮未完成，`details.retryAfterMs` 给出建议等待）
- `409 SESSION_ENDED`（显式结束过的会话不可复活）
- `410 SESSION_EXPIRED`（超时，同时已排入提炼队列）
- `502 UPSTREAM_ERROR`（上游失败，in-flight 标记已释放，可直接重试）

### 2.5 会话状态（超时管理）

`GET /api/session/{sessionId}?userId=u_1001`

```json
{
  "sessionId": "s_...",
  "status": "active",
  "createdAt": 1760000000000,
  "lastActiveAt": 1760000120000,
  "expiresAt": 1760001920000,
  "sessionTimeoutMs": 1800000,
  "remainingMs": 1798800,
  "turnCount": 4,
  "messageCount": 8,
  "memorySummaryApplied": true,
  "memorySummaryItemCount": 5,
  "systemSnapshot": { "mode": "dual_system", "promptLength": 42, "promptHash": "8c1f…", "capturedAt": 1760000000000 },
  "distilledAt": null,
  "pending": false,
  "endReason": null
}
```

读到 `status: "expired"` 时前端应引导用户新建会话；`remainingMs` 为 0 表示已过期。

### 2.6 历史

`GET /api/session/{sessionId}/history?userId=u_1001&limit=50`

只返回可读对话（`user` 与有正文的 `assistant`），内部 `tool` 交换与空内容的 tool-call 载体被过滤。

```json
{
  "sessionId": "s_...",
  "count": 2,
  "messages": [
    { "role": "user", "content": "你好", "at": 1760000100000 },
    { "role": "assistant", "content": "你好，有什么可以帮你", "at": 1760000120000 }
  ]
}
```

### 2.7 结束会话

`POST /api/session/{sessionId}/end` → `{ "userId": "u_1001" }`

```json
{
  "sessionId": "s_...",
  "status": "ended",
  "endedAt": 1760000200000,
  "alreadyInactive": false,
  "distillationScheduled": true
}
```

`distillationScheduled` 为 `true` 表示本次调用成功抢到提炼闸门（`distillationStartedAt` 为空或租约已过期）。重复调用返回 `alreadyInactive: true`、`distillationScheduled: false`，不重复扣费。

闸门用「开始标记 + 租约」而不是「成功标记」的原因：Node Functions 的 `context` 没有 `waitUntil`，异步任务可能随函数返回被回收。若一开始就把 `distilledAt` 写成终态，这次提炼就永久丢失；改为租约后，超时未完成会被下一次维护任务接管重试（次数上限 3）。

### 2.8 管理面：脱敏状态

`GET /api/admin/config/status`（需签名，见 2.12）

```json
{
  "ok": true,
  "requiredMissing": [],
  "invalidEntries": [],
  "checks": {
    "deepseekApiKey": { "label": "DeepSeek API Key", "required": true, "configured": true, "masked": "sk-****abcd" },
    "blobStoreName": { "label": "Blob Store 名称", "required": true, "configured": true, "value": "chat-memory", "consistency": "strong", "sdk": "@edgeone/pages-blob >= 0.0.14" },
    "systemPrompt": { "label": "前置提示词", "required": true, "configured": true, "display": "已加载（42 字符）", "length": 42, "hash": "8c1f2a9b7d3e" },
    "sessionTimeoutMs": { "label": "会话超时时间", "required": true, "configured": true, "value": 1800000, "humanReadable": "30 分钟" }
  },
  "runtime": { "deepseekModel": "deepseek-chat", "promptInjectionMode": "dual_system", "memory": { "topK": 8, "maxItems": 500 } },
  "adminAuth": { "mode": "bearer_hmac", "configured": true, "openidAllowlistSize": 0 },
  "wechat": { "configured": true, "baseUrlConfigured": true },
  "warnings": []
}
```

`?stats=1` 追加 `stats: { sessionFiles, memoryFiles }`。

硬约束：该响应体内不得出现 API Key 明文、提示词正文、管理员 token、HMAC 密钥、微信 token。测试 `test/api.test.mjs` 对此做了全文断言。

### 2.9 管理面：记忆观察

`GET /api/admin/memory/{userId}`（需签名）

```json
{
  "userId": "u_1001",
  "totalFiles": 23,
  "activeCount": 20,
  "inactiveCount": 3,
  "topTags": [{ "tag": "偏好", "count": 6 }],
  "topK": 8,
  "recallPreview": [{ "memoryId": "9f2c…", "importance": 0.9, "weight": 0.87, "tags": ["出差"], "isActive": true }]
}
```

### 2.10 维护巡检

两条入口，逻辑相同、鉴权不同：

| 入口 | 鉴权 | 用途 |
|---|---|---|
| `POST /api/admin/maintenance/sweep` | 管理面 HMAC 签名 | 人在控制台手动触发、排障 |
| `POST /cron/maintenance` | `CRON_SECRET`（header / query / payload） | 平台 `schedules` 或外部调度器定时触发 |

`POST /api/admin/maintenance/sweep`（需签名）

```json
{ "userId": "u_1001" }
```

`userId` 省略则全量巡检（最多 100 个用户）：

```json
{
  "mode": "all",
  "result": {
    "scannedUsers": 12,
    "sessionKeys": 34,
    "memoryKeys": 210,
    "results": [{
      "userId": "u_1001",
      "expiredSessions": ["s_..."],
      "retriedSessions": ["s_..."],
      "ttl": { "deactivated": [] },
      "capacity": { "activeCount": 20, "deactivated": [] }
    }],
    "hardDeleted": [{ "userId": "u_1001", "deleted": 3 }]
  }
}
```

`retriedSessions` 是「已结束但提炼失败过、本次被补跑」的会话；每个会话最多重试 3 次。

`POST /cron/maintenance` 的请求体：

```json
{ "token": "<CRON_SECRET>", "maxUsers": 25 }
```

默认只扫 25 个用户——Node Functions 单次运行 60 秒（`edgeone.json` 已调），一次扫全量会超时。靠「每小时跑一次 + 每次推进」收敛。

### 2.11 微信侧

`POST /api/wechat/webhook` — 需请求头 `x-wechatbot-secret`（等于 `WECHATBOT_WEBHOOK_SECRET`），缺失该配置时返回 503，不静默放行。

入站（归一化前的原始报文，字段差异由 `normalizeInbound` 收敛）：

```json
{ "msg": { "from_user_name": "oUser-001", "context_token": "ct-abc", "msg_id": "m-1", "item_list": [{ "type": 1, "text_item": { "text": "在吗" } }] } }
```

响应：`{ "ok": true, "replied": true, "sessionId": "s_..." }`
入站缺 `context_token` → `400 WECHAT_ERROR`，且**不发出任何消息**。

`POST /api/wechat/poll` — 需请求头 `x-cron-secret`。执行一次 `getupdates` 长轮询并逐条回复：

```json
{ "ok": true, "fetched": 3, "replied": 2, "skipped": 1, "failed": 0, "errors": [], "cursor": "buf-1…", "elapsedMs": 1830 }
```

### 2.12 管理面签名

```
base = METHOD \n PATH \n TIMESTAMP \n sha256_hex(rawBody)
sig  = hmac_sha256_hex(ADMIN_HMAC_SECRET, base)
```

- `PATH` 用完整 URL pathname（含 `/api` 前缀），与服务端 `url.pathname` 完全一致。
- `TIMESTAMP` 为毫秒时间戳，与服务器偏差 > `ADMIN_AUTH_MAX_SKEW_MS`（默认 300000）拒绝。
- 请求头：`Authorization: Bearer <ADMIN_TOKEN>`、`X-Admin-Timestamp`、`X-Admin-Signature`。

命令行验证示例：

```bash
PATHNAME=/api/admin/config/status
TS=$(date +%s%3N)
BODY_HASH=$(printf '%s' '' | sha256sum | cut -d' ' -f1)
SIG=$(printf '%s\n%s\n%s\n%s' "GET" "$PATHNAME" "$TS" "$BODY_HASH" \
  | openssl dgst -sha256 -hmac "$ADMIN_HMAC_SECRET" -hex | awk '{print $NF}')

curl -sS "https://your-app.edgeone.app$PATHNAME" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Admin-Timestamp: $TS" \
  -H "X-Admin-Signature: $SIG" | jq
```

## 3. 错误码

| code | HTTP | 含义 | 客户端应对 |
|---|---|---|---|
| `BAD_REQUEST` | 400 | 参数非法（userId/sessionId/text/JSON） | 修正参数 |
| `UNAUTHORIZED` | 401 | 管理面或定时任务鉴权失败 | 重新签名 |
| `NOT_FOUND` | 404 | 未知路由 | 检查路径 |
| `METHOD_NOT_ALLOWED` | 405 | 路径存在但方法不对 | 检查 method |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体或 text 超限 | 截断 |
| `CONFIG_MISSING` | 503 | 必填配置缺失/非法 | 看 `details.requiredMissing` |
| `PROMPT_EMPTY` | 503 | 前置提示词为空 | 配置 `SYSTEM_PROMPT` |
| `STORAGE_UNAVAILABLE` | 503 | Blob 不可用或内容损坏 | 检查 Store 与 SDK 版本 |
| `SESSION_NOT_FOUND` | 404 | 会话不存在 | 新建 |
| `SESSION_EXISTS` | 409 | sessionId 冲突 | 换 id |
| `SESSION_BUSY` | 409 | 上一轮未完成 | 按 `retryAfterMs` 重试 |
| `SESSION_ENDED` | 409 | 会话已结束 | 新建 |
| `SESSION_EXPIRED` | 410 | 会话超时 | 新建 |
| `LOCK_TIMEOUT` | 409 | 应用层锁等待超时 | 重试 |
| `UPSTREAM_ERROR` | 502 | DeepSeek 网络/状态码失败 | 重试 |
| `UPSTREAM_PARSE_ERROR` | 502 | DeepSeek 响应结构异常 | 重试 |
| `WECHAT_ERROR` | 502/400 | 微信网关失败或缺少 context_token | 修协议 |
| `INTERNAL_ERROR` | 500 | 未预期异常 | 报 `requestId` |

## 4. Blob key 命名方案（即 schema）

```
sessions/{userId}/{sessionId}.json          会话文档（唯一整文档读改写的数据）
memories/{userId}/{memoryId}.json           一条记忆一文件（memoryId = sha256(content)）
cursors/session/{userId}.json               该用户当前会话指针（微信续接用）
cursors/wechat/cursor.json                  长轮询游标 + 最近 50 条已处理 msg_id
locks/session/{userId}/{sessionId}.json     会话互斥锁（带租约）
locks/memory/{userId}/{memoryId}.json       记忆合并互斥锁
locks/wechat/cursor.json                    游标更新锁
```

设计约束：
- 所有会被并发追加的数据都是「一文件一条记录」，没有数组聚合文件。
- key 全部可前缀列举（`memories/{userId}/` 即该用户全部记忆），不需要额外索引表。
- 锁单独放 `locks/` 前缀，避免污染业务前缀的扫描结果。
- 前缀扫描有 `limit` 上限（默认 300~2000），单请求不会无限读。

## 5. 数据结构

### 5.1 会话文档

```json
{
  "schemaVersion": 1,
  "sessionId": "s_mf3k2a9x1b7c",
  "userId": "u_1001",
  "createdAt": 1760000000000,
  "lastActiveAt": 1760000120000,
  "status": "active",
  "endedAt": null,
  "endReason": null,
  "messages": [
    { "role": "user", "content": "帮我记住：我下周三要去上海出差", "at": 1760000100000 },
    { "role": "assistant", "content": "", "tool_calls": [{ "id": "call_1", "type": "function", "function": { "name": "save_memory", "arguments": "{\"content\":\"用户下周三去上海出差\"}" } }], "at": 1760000101000 },
    { "role": "tool", "tool_call_id": "call_1", "content": "{\"ok\":true,\"memoryId\":\"9f2c…\",\"deduped\":false}", "at": 1760000101000 },
    { "role": "assistant", "content": "记下了，下周三上海出差。", "at": 1760000120000 }
  ],
  "turnCount": 1,
  "version": 7,
  "source": "api",
  "metadata": {},
  "memorySummary": "- 用户偏好简洁回答\n- 用户是后端工程师",
  "memorySummaryItemCount": 2,
  "recallMemoryIds": ["a1…", "b2…"],
  "systemSnapshot": { "mode": "dual_system", "promptLength": 42, "promptHash": "8c1f…", "capturedAt": 1760000000000 },
  "pendingTurn": null,
  "distilledAt": null,
  "distillationStartedAt": null,
  "distillationAttempts": 0,
  "distillationFailedAt": null,
  "distillationError": null,
  "distilledMemoryCount": null
}
```

要点：
- `messages` 里**没有** `system` 条目。system 段每轮现场装配，避免历史中出现可被累积/篡改的 system 副本。审计靠 `systemSnapshot`。
- `version` 每次写入自增，便于观测写入次数与排查并发。
- `pendingTurn` 是 in-flight 标记，不是锁；它只用于拒绝会撕裂上下文的并发轮次。
- `distillationStartedAt` / `distillationAttempts` / `distilledAt` 三个字段共同表达提炼状态：租约内不重复、租约外可接管、成功后写终态、失败最多重试 3 次。

### 5.2 记忆文档

```json
{
  "memoryId": "9f2c1d…(64 hex)",
  "userId": "u_1001",
  "content": "用户下周三去上海出差",
  "importance": 0.8,
  "tags": ["出差", "行程"],
  "createdAt": 1760000101000,
  "updatedAt": 1760000101000,
  "lastAccessedAt": 1760000101000,
  "accessCount": 0,
  "mergeCount": 0,
  "absorbedCount": 0,
  "source": "tool_call",
  "sourceSessions": ["s_..."],
  "isActive": true,
  "deactivatedAt": null,
  "deactivateReason": null,
  "expiresAt": 1767776101000,
  "contentHash": "9f2c1d…",
  "schemaVersion": 1
}
```

- `memoryId === contentHash === sha256(content)`，key 可预测，写前即可判断是否重复。
- `expiresAt` 是滑动过期：每次合并或被召回访问都会刷新（`lastAccessedAt + MEMORY_TTL_MS`）。
- `weight` 不落库。它随时间变化，落库必然失真，读取时用 `importance × exp(-λ × days)` 现算。

## 6. 记忆流水线

```
                       ┌─ 通道 A：tool_calls.save_memory ─┐
items[] ── sanitize ──▶│                                  ├──▶ writeBatch ──▶ 治理 ──▶ Blob
                       └─ 通道 B：会话终结提炼（JSON 数组）┘
```

`writeBatch` 内部顺序（两条通道完全共用）：

1. **清洗**：去零宽字符/控制字符，压平空白，过滤越权短语，截断 500 字符。空内容丢弃并记 `invalid`。
2. **归一**：`importance` 容错到 0~1（>1 且 ≤10 时按 10 分制折算），`tags` 去重、截断、最多 8 个。
3. **一级去重**：`memoryId = sha256(content)`，命中活跃集直接合并。
4. **二级去重**：与活跃集逐条算 Dice 相似度（拉丁按词 + CJK 按二元字组），取最高分；≥ `MEMORY_DEDUP_THRESHOLD`（默认 0.82）则合并到该条。
5. **写入**：`set(key, value, { onlyIfNew: true })`。返回已存在则转入合并，绝不覆盖原文。
6. **合并/降级**：`importance = max`，标签并集，`lastAccessedAt`/`expiresAt` 刷新，`mergeCount++`；新条目更弱（低 0.2 以上）且旧条目已合并 ≥2 次时只吸收不新增。
7. **容量治理**：活跃数 > `MEMORY_MAX_ITEMS` 时按 weight 升序标 `isActive = false`（`deactivateReason: "capacity"`）。
8. **物理清理**：只由维护任务删除「非活跃且超过 `MEMORY_HARD_DELETE_AFTER_MS`」的文件。

阈值取舍说明：0.82 是保守值，只合并措辞几乎相同的近似重复。语义相近但措辞不同的两条会各自保留——宁可多存一条，也不能把「住在杭州」和「下周三去杭州出差」误合成一条。

## 7. 并发控制

| 场景 | 机制 | 位置 |
|---|---|---|
| 记忆写入幂等 | `onlyIfNew: true` + 内容哈希 | `src/memory.js#writeNew` |
| 记忆合并 | 每 memoryId 一把租约锁 | `src/lock.js` + `mergeOrAbsorb` |
| 同一会话两轮并发 | `pendingTurn` in-flight 标记 → `409 SESSION_BUSY` | `src/session-service.js#beginTurn` |
| 会话文档读改写 | 租约锁包住短临界区（仅两次 Blob 操作） | `beginTurn` / `completeTurn` / `end` |
| 提炼重复执行 | 提炼租约 `distillationStartedAt`（TTL 10 分钟）+ 终态 `distilledAt` | `claimDistillation` / `releaseDistillation` |
| 微信游标更新 | 独立锁 `locks/wechat/cursor.json` | `src/wechat.js#saveCursor` |

锁的释放必须校验 token（见 `src/lock.js`），否则 A 的租约过期、B 抢到锁后，A 的 `finally` 会误删 B 的锁。

## 8. 提示词装配

```
dual_system（默认）
  [0] system  记忆摘要块（带「非指令性数据」声明）   ← 仅在存在摘要时
  [1] system  前置提示词                              ← 恒定
  [2..] user / assistant / tool                      ← 历史，system 角色一律剔除

merged_single_system
  [0] system  前置提示词 + "\n\n" + 记忆摘要块        ← 提示词占据头部
  [1..] 同上
```

- `composeRequestMessages` 是唯一出口，任何路由都不得自行拼 messages。
- 历史里的 `role: "system"` 在 `normalizeHistoryMessage` 被丢弃，客户端无法伪造。
- 历史裁剪从头部切，且保证窗口首条不是 `tool`（否则其 `assistant.tool_calls` 被切掉，上游直接 400）。

## 9. 阶段 A 条目 → 实现位置

| 阶段 A 条目 | 实现位置 | 验证用例 |
|---|---|---|
| A1 入口与环境变量 | `node-functions/api/[[default]].js`、`src/config.js` | `api.test.mjs` 全量 |
| A2 / A3 Blob + strong | `src/blob.js#resolveStore` | 代码检视（`consistency: 'strong'`） |
| A4 key 即 schema | 本文第 4 节 | `memory.test.mjs` key 断言 |
| A5 上游无状态 | `src/prompt.js#composeRequestMessages` | `session.test.mjs` 历史累积 |
| A6 context_token | `src/wechat.js#sendText` | `api.test.mjs` 回调与长轮询 |
| A7 一记录一文件 + onlyIfNew | `src/memory.js` | `memory.test.mjs` 去重/冲突 |
| B1 四类操作 | `src/session-service.js` | `session.test.mjs` |
| B2 提示词锁定 | `src/prompt.js` | `prompt.test.mjs` |
| B3 双通道 | `src/chat-service.js#runUpstream` / `distillSession` | `session.test.mjs` |
| B4 治理 | `src/memory.js` | `memory.test.mjs` |
| B5 召回注入 | `recall` + `createSession` | `session.test.mjs` |
| C3 管理鉴权 | `src/auth.js` | `api.test.mjs` |
| C4 / C5 脱敏与必填 | `src/config.js#buildConfigStatus` | `config.test.mjs`、`api.test.mjs` |
