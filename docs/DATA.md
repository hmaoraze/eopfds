# 数据结构与存储方案

## 1. 会话 `Session`

```jsonc
{
  "sessionId": "s_l8x9zk2p1aK3fE9sQ2",   // s_<base36 毫秒时间戳><10 位随机>
  "userId": "wxid_abc@im.wechat",
  "state": "active",                      // active | ended | expired
  "createdAt": 1761199000000,
  "updatedAt": 1761199263000,
  "lastActiveAt": 1761199263000,
  "hardDeadline": 1761227800000,          // 绝对存活上限（SESSION_MAX_SECONDS）
  "expiresAt": 1761200800000,             // 空闲超时时刻（SESSION_TTL_SECONDS），每轮 touch 刷新
  "turn": 3,                              // 已完成轮数
  "messages": [                           // 上下文消息（含 system 之外的全部）
    { "role": "user",      "content": "我叫小明", "ts": 1761199260000 },
    { "role": "assistant", "content": "你好，小明", "ts": 1761199263000 }
  ],
  "rollingSummary": "",                   // 更早历史被裁掉后的增量摘要
  "messageCount": 2,
  "contextToken": "CITXn…",               // iLink 上下文票据
  "sessionRef": "",                       // iLink session_id
  "memoryInjectIds": ["a1b2…"],           // 开会话时注入了哪些记忆（整个生命周期稳定）
  "memoryDigest": "· 用户叫小明",          // 记忆压缩摘要，开会话时固化
  "extractedAt": 0,                       // 幂等：记忆提炼只做一次
  "endReason": null,                      // explicit | user-command | idle-timeout | hard-deadline | max-turns | admin | api-delete
  "endedAt": 0,
  "endedBy": "",                          // user | model | system | admin
  "lastMessageId": "",
  "meta": {}
}
```

### 状态机

```text
              create
  none ─────────────▶┐
                     ▼
                  active ──── 用户输入轮数 ≥ SESSION_MAX_TURNS ──▶ expired
                     │
     ① 显式结束(API DELETE / 会话结束指令 / end_session 工具)
                     ├─────────────────────────────────────────▶ ended
     ② 空闲超时 now > expiresAt
     ③ 绝对上限 now > hardDeadline
     ④ 轮数上限 turn ≥ SESSION_MAX_TURNS
                     └─────────────────────────────────────────▶ expired

  ended / expired 都会：提炼记忆 → 写回长期记忆 → 从登记表摘除 → 保留 24h 供审计
```

`hardDeadline` 与 `expiresAt` 分离的意义：即便用户一直活跃，会话也不会无限期存在（默认 8 小时强制开新会话并重新压缩记忆）。

---

## 2. 记忆文档 `MemoryDocument`

```jsonc
{
  "userId": "wxid_abc@im.wechat",
  "updatedAt": 1761199263000,
  "items": [ /* MemoryItem，见下 */ ]
}
```

### 记忆条目 `MemoryItem`

```jsonc
{
  "id": "a1b2c3d4e5f60718",
  "content": "用户住在杭州，周末常去西湖跑步",
  "category": "fact",                  // fact | preference | goal | constraint | relation | other
  "importance": 4,                     // 1..5
  "tags": ["地点", "习惯"],
  "createdAt": 1761199000000,
  "updatedAt": 1761199263000,
  "expiresAt": 1776745000000,          // 0 = 永不过期
  "hits": 3,                           // 被注入 / 被检索命中的次数
  "mergedCount": 1,                    // 被相似度合并的次数
  "source": "tool",                    // tool | text | extract | manual
  "lastSessionId": "s_l8x9…",
  "fingerprint": "9f3c1a…",            // normalizeContent(content) 的短哈希，去重主键
  "previousContent": "用户住在杭州",    // 合并时被替换掉的旧表述（审计用）
  "score": 0.72                        // 运行时计算，不落库（仅查询时挂上）
}
```

---

## 3. 记忆摘要缓存 `MemoryDigest`

```jsonc
{
  "text": "· 用户叫小明，住在杭州\n· 偏好简洁的要点式回答\n· 对芒果过敏",
  "ids": ["a1b2…", "c3d4…", "e5f6…"],   // 参与本次摘要的记忆 id
  "createdAt": 1761199000000,
  "model": "deepseek-chat"
}
```

- 缓存在 `msum:v1:{uid}`，TTL 1 小时；
- 任意写入 / 删除记忆都会 `dropDigest` 使其失效；
- 新会话创建时按缓存复用，避免每次开场都调 LLM。

---

## 4. Passkey 凭据 `PasskeyCredential`

```jsonc
{
  "id": "VJ5xQ2fR8k...",               // credentialId（base64url）
  "publicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "publicKeySpki": "MIIBSzCCAQ…",      // DER SPKI（base64），用于 importKey
  "algorithm": -7,                     // COSE alg
  "algorithmName": "ECDSAwithSHA256",
  "signCount": 12,                     // 单调递增，防止克隆
  "transports": ["internal", "hybrid"],
  "aaguid": "00000000-0000-0000-0000-000000000000",
  "attestationFormat": "none",
  "displayName": "MacBook Touch ID",
  "createdAt": 1761199000000,
  "lastUsedAt": 1761199263000,
  "createdVia": "setup",               // setup | add-passkey
  "revoked": false
}
```

### WebAuthn 挑战 `Challenge`

```jsonc
{
  "id": "k3f8Rz2Qa1Bm",
  "challengeB64": "8Jd…",              // 32 字节随机挑战（base64url）
  "type": "register",                  // register | auth | reauth
  "purpose": "setup",                  // setup | add-passkey
  "linkJti": "9xE…",                   // 关联的一次性安全链接
  "rpId": "mybot.edgeone.app",
  "origin": "https://mybot.edgeone.app",
  "createdAt": 1761199000000
}
```

挑战为**一次性**：`takeChallenge` 读出后立即删除。

---

## 5. 安全链接 `SecureLink`

```jsonc
{
  "jti": "9xEqL2mZk8pQa4Rd",
  "purpose": "setup",                  // setup | add-passkey | reauth
  "used": false,
  "verified": false,                   // reauth 专用：是否已完成断言
  "verifiedAt": 0,
  "createdAt": 1761199000000,
  "expiresAt": 1761199900000,
  "createdBy": "master-key",           // master-key | admin-session
  "ip": "1.2.3.4",
  "credentialId": ""
}
```

一次性由 **KV 中的状态**（而非令牌本身）保证：`register-verify` 成功后立刻 `dropLink`；`requireReauth` 通过后同样立即销毁。

---

## 6. 管理端会话 `AdminSession`

```jsonc
{
  "jti": "Tb7oP1...",
  "issuedAt": 1761199000000,
  "expiresAt": 1761200800000,
  "user": "admin",
  "credentialId": "VJ5xQ2…",
  "userVerified": true,
  "passkeyCount": 2,
  "initialized": true
}
```

令牌为自签 JWT 形态：`<payload base64url>.<HMAC-SHA256 base64url>`，密钥 `ADMIN_SIGNING_SECRET`，`purpose` 区分 `setup` / `reauth` / `admin`。

---

## 7. 键空间

统一带版本号 `v1`，便于将来平滑迁移。

| 键 | 值 | TTL |
| --- | --- | --- |
| `cfg:v1:overrides` | 管理端写入的配置覆盖值 `{ KEY: value }` | 永久 |
| `cfg:v1:setup` | `{ initialized, initializedAt, passkeyCount }` | 永久 |
| `sess:v1:{uid}:{sid}` | 会话记录 | 活跃：`expiresAt - now + 86400`；终态：24h |
| `sidx:v1:{uid}` | `{ active: sid\|null, recent: sid[] }`（最多 20） | 永久 |
| `sw:v1:active` | 全局登记表 `{ "uid\|sid": expiresAt }`（上限 5000，超出按最早到期淘汰） | 永久 |
| `mem:v1:{uid}` | 记忆文档 | 永久 |
| `msum:v1:{uid}` | 记忆摘要缓存 | 1h |
| `pk:v1:index` | Passkey 凭据 ID 列表 | 永久 |
| `pk:v1:{credentialId}` | 凭据明细 | 永久 |
| `wa:v1:ch:{id}` | WebAuthn 挑战 | `ADMIN_TIMEOUT_MS/1000 + 60` |
| `adm:v1:s:{tokenId}` | 管理端会话 | `ADMIN_SESSION_TTL_SECONDS` |
| `sl:v1:{jti}` | 安全链接状态 | `SECURE_LINK_TTL_SECONDS` |
| `ilk:v1:cursor` | iLink getupdates 游标 | 永久 |
| `ilk:v1:ctx:{uid}` | 用户最新 `context_token` | 30d |
| `ilk:v1:ticket:{uid}` | `typing_ticket` 缓存 | 23h |
| `dd:v1:{messageId}` | 消息幂等去重 | 10min |
| `aud:v1:{ts}:{rand}` | 审计条目 | 90d |
| `aud:v1:index` | 审计键索引（环形保留 200 条） | 永久 |
| `rl:v1:{scope}:{bucket}:{k}` | 限流计数 | 60s |

---

## 8. 存储驱动

统一接口（`withTtl` 包装后）：

```js
store.get(key)             // → value | undefined（过期自动视为不存在）
store.put(key, value, ttl) // ttl 秒；<=0 表示不过期
store.delete(key)
store.list(prefix, limit)  // 可选能力
```

**逻辑 TTL**：所有值统一包一层 `{ __v:1, v, e: expireAtMs }` 再 JSON 序列化。这样即便底层驱动不支持过期，也能在本层做惰性过期兜底；同时能识别「非本系统写入的数据」并安全忽略。

| 驱动 | `STORE_DRIVER` | 必需配置 | 特点 |
| --- | --- | --- | --- |
| EdgeOne KV | `edgeone-kv`（默认） | `KV_BINDING_NAME`（默认 `WECHATBOT_KV`） | 控制台绑定后从全局或 `context.env` 取，自动附 `expirationTtl`；失败自动尝试 `expiration` 兼容写法 |
| Redis REST | `redis-rest` | `REDIS_REST_URL`、`REDIS_REST_TOKEN` | Upstash 风格，走 `/pipeline` POST，避免超长 URL |
| 自建 HTTP | `http` | `HTTP_STORE_URL`（可选 `HTTP_STORE_TOKEN`） | 只需实现 `GET|PUT|DELETE /?key=` 与 `{ key, value, ttlSeconds }` |
| 内存 | `memory` | — | 仅本地调试；**边缘节点之间不共享**，禁止生产使用 |

> 生产环境必须选前三者之一：会话与记忆必须在所有边缘节点间共享，否则用户会被调度到不同节点而丢失上下文。

自建 HTTP 键值服务的协议约定：

```http
GET    /?key=<urlencoded>            → 200 { "value": <原始字符串> } | 404
PUT    /                             ← { "key": "...", "value": "<字符串>", "ttlSeconds": 3600 }
DELETE /?key=<urlencoded>            → 200 | 404
```
