# 接口与协议设计

所有接口均为 **EdgeOne Pages Functions** 路由，入口在 `edge-functions/api/*.js`，实现在 `src/server/api/*.js`。

统一约定：

- 请求体 / 响应体均为 `application/json; charset=utf-8`；
- 响应一律带 `ret` 字段（`0` 成功，负数错误，见下表）；失败时额外返回 `errmsg`；
- 响应头带 `Cache-Control: no-store`；
- 支持 `OPTIONS` 预检；管理端接口严格限定同源 Origin 并允许携带 Cookie。

## 错误码

| ret | 常量 | HTTP | 含义 |
| --- | --- | --- | --- |
| 0 | `OK` | 200 | 成功 |
| -2 | `PARAM` | 400 | 参数错误 / 未知操作 |
| -14 | `SESSION_EXPIRED` | 200 | 会话已过期（业务语义） |
| -401 | `UNAUTHORIZED` | 401 | 未认证 / 令牌无效 |
| -403 | `FORBIDDEN` | 403 | 凭证错误 / 不允许的操作 |
| -429 | `RATE_LIMITED` | 429 | 触发限流 |
| -500 | `UPSTREAM` | 500 | 上游（DeepSeek / iLink / 存储）失败 |
| -504 | `TIMEOUT` | 504 | 上游超时 |

---

## 1. `POST /api/wechat` —— 统一会话接口

单接口承担：**创建 / 续接 / 显式结束 / iLink 原生消息接入 / 批量**。

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string | 否 | `send`（默认）/ `start` / `ingest` / `send_batch` / `status` |
| `userId` | string | 是 | 用户唯一标识，通常取 iLink 的 `from_user_id` |
| `text` | string | 是（非 start） | 本轮用户输入纯文本 |
| `sessionId` | string | 否 | 定向续接；省略则续接最近活跃会话 |
| `contextToken` | string | 否 | iLink 上下文票据，用于投递回复 |
| `forceNew` | boolean | 否 | 强制开启新会话 |
| `messageId` | string | 否 | 幂等去重键 |
| `deliver` | boolean | 否 | 是否由服务端调用 `sendmessage` 投递；默认取 `ILINK_DELIVER` |
| `maxChars` | number | 否 | 单条回复最大字符数（默认 1200） |
| `wire` | object | 否 | 原始 WireMessage，省略 `text` 时由服务端解析 |
| `updates` / `msgs` | array | 否 | iLink `getupdates` 返回的批量消息 |
| `items` | array | 否 | `send_batch` 的子请求数组 |

> **被忽略的字段**（防注入）：`messages` / `system` / `systemPrompt` / `system_prompt` / `prompt` / `instruction` / `instructions` / `role` / `developer` / `context` / `history` / `function_call` / `tool_calls` / `toolCalls` / `assistant` / `model` / `temperature` / `max_tokens`。出现时会被丢弃并写入 `warnings`。

### 成功响应

```jsonc
{
  "ret": 0,
  "sessionId": "s_l8x9zk2p1aK3fE9sQ2",   // 本次使用的会话
  "userId": "wxid_abc@im.wechat",
  "state": "active",                      // active | ended | expired
  "turn": 3,                              // 本轮结束后的累计轮数
  "created": false,                       // 是否新建会话
  "previousEnded": false,                 // 前一会话是否因超时被回收
  "expiresAt": 1761200000000,             // 毫秒时间戳
  "reply": "好的，我记住了。",             // 回复文本（完整）
  "chunks": ["好的，我记住了。"],          // 按 maxChars 切分后的片段
  "sendMessages": [ /* iLink msg 数组，见下 */ ],
  "contextToken": "CITXn...",
  "memoriesSaved": [
    { "id": "a1b2c3d4e5f60718", "content": "用户住在杭州", "importance": 4, "category": "fact", "merged": false }
  ],
  "toolTrace": [
    { "name": "save_memory", "arguments": { "content": "用户住在杭州", "importance": 4 }, "result": "saved" }
  ],
  "usage": { "prompt_tokens": 812, "completion_tokens": 137, "total_tokens": 949 },
  "warnings": [],                          // 输入被截断 / 检测到伪装角色等
  "deliver": true,
  "latencyMs": 1763,
  "systemPromptFingerprint": "512:433"     // 前置提示词指纹，便于验证每轮一致
}
```

`sendMessages[i]` 结构（可直接喂给 `/ilink/bot/sendmessage`）：

```jsonc
{
  "from_user_id": "",
  "to_user_id": "wxid_abc@im.wechat",
  "client_id": "b3f1...",            // uuid v4
  "message_type": 2,                 // 1=USER 2=BOT
  "message_state": 2,                // 0=NEW 1=GENERATING 2=FINISH
  "context_token": "CITXn...",
  "item_list": [ { "type": 1, "text_item": { "text": "好的，我记住了。" } } ]
}
```

`item_list.type`：`1=TEXT 2=IMAGE 3=VOICE 4=FILE 5=VIDEO`。

### 各 action 说明

#### `action=start`——仅创建会话

```jsonc
// 请求
{ "action": "start", "userId": "wxid_abc@im.wechat", "contextToken": "…" }
// 响应（额外字段）
{
  "sessionId": "…", "state": "active", "expiresAt": 1761200000000,
  "memoryDigest": "· 用户住在杭州\n· 偏好简洁回答",   // 注入本次会话的记忆摘要
  "memoryInjectIds": ["a1b2…", "c3d4…"]              // 被注入的记忆 id
}
```

#### `action=ingest`——iLink 长轮询结果批量接入

```jsonc
{
  "action": "ingest",
  "updates": { "msgs": [ /* WireMessage… */ ] }
}
```

服务端逐条 `parseIncoming` → 过滤非用户消息 → 按 `userId:messageId` 幂等去重 → 逐条走一轮对话 → 逐条投递。

响应：`{ "ret": 0, "count": 2, "results": [ /* 同上成功响应 + delivered */ ] }`。单次最多处理 20 条。

#### `action=send_batch`——批量单条输入

```jsonc
{ "action": "send_batch", "items": [ { "userId": "u1", "text": "你好" }, { "userId": "u2", "text": "你好" } ] }
```

单次最多 10 条。

#### 显式结束指令

用户输入命中 `SESSION_END_COMMANDS`（默认 `结束会话` / `/end` / `退出会话` / `清空上下文` / `重新开始`）时，服务端直接结束会话并提炼记忆，不再调用模型：

```jsonc
{
  "state": "ended", "turn": 5, "previousEnded": true,
  "reply": "本次会话已结束，重要信息我已记下。下次聊～",
  "memoriesSaved": [ … ], "toolTrace": [ { "name": "__end_command__", "arguments": "结束会话" } ]
}
```

### `GET /api/wechat?userId=xxx[&withMemories=1]` —— 查询会话状态

```jsonc
{
  "ret": 0, "userId": "u1",
  "activeSessionId": "s_l8x…", "state": "active", "turn": 3, "expiresAt": 1761200000000,
  "recent": ["s_l8x…", "s_l8y…"],
  "memories": [ /* withMemories=1 时返回，最多 20 条 */ ]
}
```

### `DELETE /api/wechat?userId=xxx[&sessionId=xxx]` —— 显式结束

```jsonc
{ "ret": 0, "ended": true, "sessionId": "s_l8x…", "memoriesSaved": [ { "id": "…", "content": "…" } ] }
```

无活跃会话时：`{ "ret": 0, "ended": false, "reason": "no_active_session" }`。

---

## 2. `POST /api/admin` —— 管理端 JSON API

操作名通过请求体 `op` 或查询串 `?op=` 传递。以下三类之外的接口需先取得管理端会话（Cookie `wb_admin` 或 `Authorization: Bearer <token>`）。

### 公开（无需认证）

| op | 作用 | 主要请求字段 | 主要响应 |
| --- | --- | --- | --- |
| `bootstrap-state` | 是否完成首次配置 | — | `{ initialized, passkeyCount, configComplete, missingRequired[] }` |
| `schema` | 下发配置项元数据 | — | `{ groups[], schema[] }`（含 `required` / `type` / `default` / `options` / `dependsOn` / `desc`） |
| `secure-link` | 凭主密钥签发一次性链接 | Header `X-Admin-Master-Key` 或 body `masterKey` | `{ token, url, purpose, expiresAt, singleUse }` |
| `link-status` | 校验链接是否有效 | `{ token }` | `{ ok, purpose?, expiresAt?, rpId?, rpName?, userVerification?, existingPasskeys?, reason? }` |
| `register-options` | 注册挑战 | `{ token, displayName }` | `{ options, challengeId }` |
| `register-verify` | 校验注册断言 | `{ challengeId, credential, displayName }` | 成功即刻签发管理端会话 + Set-Cookie，链接失效 |
| `auth-options` | 登录挑战 | `{ enumerate? }` | `{ options, challengeId }` |
| `auth-verify` | 校验登录断言 | `{ challengeId, credential, purpose? }` | `{ ok, adminToken, expiresAt, credentialId, userVerified }` |

### 需管理端会话 —— 配置

| op | 请求字段 | 响应 |
| --- | --- | --- |
| `session-state` | — | `{ ok, expiresAt, issuedAt }` |
| `logout` | — | `{ ok }` 并清除 Cookie |
| `config-get` | `{ reveal?: '1', reauthToken? }` | `{ groups, values, meta, validity, overrides }`；`reveal=1` 需先完成 Passkey 断言 |
| `config-save` | `{ values: { KEY: value, … } }` | `{ ok, valid, missingRequired[], note }` |

> 保存即热更新：值写入 KV 覆盖层，优先级高于环境变量，下一个请求立即生效。留空或保留脱敏占位符（`••••••`）表示「不修改」。

### 需管理端会话 —— 密钥与安全

| op | 请求字段 | 说明 |
| --- | --- | --- |
| `passkeys-list` | — | 列出已注册密钥（不含私钥） |
| `reauth-options` | — | 敏感操作前的 step-up：返回 `{ options, challengeId, reauthToken, expiresAt }` |
| `passkey-add-options` | `{ displayName }` | 已登录态新增密钥的注册挑战 |
| `passkey-remove` | `{ credentialId, reauthToken }` | 至少保留一枚密钥 |
| `reset-passkeys` | `{ reauthToken }` | 清空全部密钥并吊销所有管理端会话 |
| `issue-secure-link` | `{ purpose: 'setup' \| 'add-passkey', reauthToken }` | 给新设备签发一次性链接 |
| `ilink-qrcode` | — | 获取微信扫码登录二维码 |
| `ilink-qrstatus` | `{ qrcode, verifyCode? }` | 轮询扫码结果；成功后自动写入 `ILINK_BOT_TOKEN` 等覆盖值 |

**step-up 三步骤**：

```text
1) op=reauth-options        → { options, challengeId, reauthToken }
2) navigator.credentials.get({ publicKey: options })
3) op=auth-verify  purpose=reauth
     body: { challengeId, purpose: 'reauth', credential }
     → { ok: true, reauthToken }        // 服务端把 link 标记为 verified
4) 携带该 reauthToken 调用目标敏感 op（一次性，用后即焚）
```

### 需管理端会话 —— 运维

| op | 请求字段 | 说明 |
| --- | --- | --- |
| `users-list` | `{ limit? }` | 从全局登记表汇总活跃用户 |
| `session-list` | `{ userId }` | 该用户最近 20 个会话摘要 |
| `session-end` | `{ userId, sessionId? }` | 管理员强制结束 |
| `memory-list` | `{ userId, query?, limit? }` | 记忆列表 + 统计 |
| `memory-delete` | `{ userId, memoryId }` | 删除单条 |
| `memory-purge` | `{ userId }` | 清空该用户全部记忆 |
| `sweep` | `{ limit? }` | 立即执行超时回收 |
| `audit-list` | `{ limit? }` | 最近审计日志（倒序） |

---

## 3. `GET|POST /api/cron` —— 定时任务

鉴权：`X-Admin-Master-Key` 头，或 `X-Cron-Token` / `?token=` 与环境变量 `CRON_TOKEN` 比对。

| op | 说明 | 响应 |
| --- | --- | --- |
| `sweep` | 扫描全局登记表，回收已超时会话：提炼记忆 → 标记 expired → 从登记表移除 | `{ scanned, expired, memories, details[] }` |
| `poll` | 单次驱动 iLink `getupdates`（需 `ILINK_SELF_POLL=true`） | `{ processed[] }` |
| `summary` | 刷新指定用户的记忆摘要缓存 | `{ ok, userId }` |

建议：**每 1~5 分钟调用一次 `sweep`**（EdgeOne 定时触发器），用于兜底那些「用户不再发消息」场景下没有机会进入 `resolve()` 的会话。

---

## 4. `GET /api/health` —— 健康检查

```jsonc
{
  "ret": 0, "ok": true, "timestamp": "…", "store": "edgeone-kv",
  "missingRequired": [],
  "configSource": { "overrides": ["DEEPSEEK_API_KEY", "SYSTEM_PROMPT"] },
  "checks": {
    "store": "ok",
    "deepseekKey": "present",
    "ilinkToken": "present",
    "deepseek": "ok"          // 仅 ?deep=1 时存在（会真实调用一次 LLM）
  },
  "latencyMs": 42
}
```

---

## iLink Bot API 对照表

本工程已实现的客户端方法（`src/server/ilink.js`）：

| iLink 端点 | 客户端方法 | 用途 |
| --- | --- | --- |
| `POST /ilink/bot/get_bot_qrcode?bot_type=3` | `requestQrCode()` | 获取登录二维码 |
| `GET /ilink/bot/get_qrcode_status?qrcode=` | `pollQrStatus()` | 轮询扫码状态，返回 `bot_token` / `baseurl` / `ilink_bot_id` |
| `POST /ilink/bot/getupdates` | `getUpdates(cursor)` | 长轮询拉消息（服务端挂起约 35s） |
| `POST /ilink/bot/sendmessage` | `sendMessage(msg)` / `sendText()` | 发送文本 / 媒体 |
| `POST /ilink/bot/getconfig` | `getConfig()` | 获取 `typing_ticket` |
| `POST /ilink/bot/sendtyping` | `sendTyping(userId, ticket, 1\|2)` | 正在输入状态 |
| `POST /ilink/bot/msg/notifystart` / `notifystop` | `notifyStart()` / `notifyStop()` | 生命周期通知 |
| `POST /ilink/bot/getuploadurl` | `getUploadUrl(params)` | 获取 CDN 上传参数 |

所有请求体均带 `base_info`：`{ channel_version, bot_agent }`；鉴权头 `Authorization: Bearer <ILINK_BOT_TOKEN>`。

**会话过期语义**：iLink 返回 `ret === -14` 时，客户端自动清理本地 `context_token` 缓存并提示重新建立上下文（见 `isSessionExpired()`）。
