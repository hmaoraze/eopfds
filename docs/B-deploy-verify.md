# 阶段 B · 部署与验收

> 对应阶段 A 第 5 节「验收口径」10 条。每条给出：判定方法、执行命令、期望结果、对应测试用例。
> 验收无需真实 DeepSeek 与真实 Blob：`npm test` 用内存 store + 伪造上游覆盖全部逻辑。
> 要从零搭起项目，看 [`B-deploy-guide.md`](B-deploy-guide.md)；本文只负责「怎么判定通过」。

## 1. 目录与职责

```
node-functions/
  api/[[default]].js        函数入口，/api/* 全部转交路由层（无业务逻辑）
  cron/maintenance.js       低频维护入口，/cron/maintenance
src/
  config.js                 环境变量装载、必填校验、脱敏状态
  http.js                   响应与请求体（内存化，兼容不可重放的 body）
  errors.js                 错误码与 AppError
  crypto-utils.js           sha256 / HMAC / 常量时间比较 / 脱敏
  blob.js                   Blob 仓储（strong 一致、onlyIfNew、前缀分页扫描）
  lock.js                   租约锁
  prompt.js                 system 段装配、历史净化、JSON 抽取
  memory.js                 记忆治理与召回
  session-service.js        会话生命周期与并发控制
  deepseek.js               /chat/completions 客户端（重试、超时）
  chat-service.js           对话编排、工具循环、通道 B 提炼、巡检
  wechat.js                 iLink 适配与网关编排
  auth.js                   管理面签名校验
  router.js                 HTTP 路由
public/admin.html           配置状态页（静态，无构建，无内联密钥）
scripts/dev-server.mjs      本地预览服务器（仅开发用：内存 store + 假上游）
test/                       61 个用例，零外部依赖
docs/                       阶段 A 提示词 + 阶段 B 四份文档
edgeone.json                构建配置（输出目录 / maxDuration / schedules）
```

## 2. 本地验收（无凭证）

```bash
npm test
```

期望：

```
# tests 61
# pass 61
# fail 0
```

### 2.1 可选：起一个真实 HTTP 服务看整条链路

```bash
node scripts/dev-server.mjs 8787
# 打开 http://127.0.0.1:8787/admin.html
# token: dev-admin-token-123456 / secret: dev-hmac-secret-abcdef（脚本内置，勿用于生产）
```

该脚本用内存 store 替换 Blob、用固定回复替换 DeepSeek，并在收到含「记住」的消息时返回一次 `save_memory` 工具调用，因此可以完整观察：工具轮 → 记忆落盘 → 结束会话 → 通道 B 提炼 → 新会话召回摘要。

签名可用 `openssl` 独立计算，与页面内的 WebCrypto 实现互为校验：

```bash
B=http://127.0.0.1:8787; P=/api/admin/config/status
TS=$(date +%s%3N); BH=$(printf '%s' '' | sha256sum | cut -d' ' -f1)
SIG=$(printf '%s\n%s\n%s\n%s' "GET" "$P" "$TS" "$BH" | openssl dgst -sha256 -hmac "$ADMIN_HMAC_SECRET" -hex | awk '{print $NF}')
curl -sS "$B$P" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Admin-Timestamp: $TS" -H "X-Admin-Signature: $SIG"
```

已实测：同一条命令对 `GET`（空 body）与 `POST`（非空 body）均通过；把 body 改成另一个 `userId` 后签名立即失效（`bad_signature`），证明 body 哈希确实参与签名。

## 3. 逐条验收

### ① 无全局 KV；`getStore` 处可见 `consistency: "strong"`

```bash
grep -rniE "\bKV\b|globalThis\.kv|process\.env" src/ node-functions/   # 期望：无输出
grep -rn "getStore(" src/blob.js                                  # 期望：唯一调用点
grep -n "consistency: 'strong'" src/blob.js                       # 期望：命中
```

实测：KV 检索无输出；`getStore` 仅在 `src/blob.js:166` 一处，形如
`getStore({ name: cfg.blobStoreName, consistency: 'strong' })`。

### ② 伪造 `tool_calls` → 落记忆文件 + 写入 `role:"tool"`

用例：`session.test.mjs` › `tool_calls 回合：写入记忆 + 追加 tool 消息 + 继续生成`

断言链：`memoryWrites[0].ok === true` → `memories/u1/*.json` 数量为 1 → 会话文档中存在 `role: "tool"` 且 `tool_call_id === "call_1"` → 第二次上游请求的 messages 里带该 tool 消息。

### ③ 同 content 写两次 → 1 个文件，`mergeCount` 递增

用例：`memory.test.mjs` › `同一 content 写两次只落一个文件…`

```js
await writeBatch('u1', [{ content, importance: 0.8, tags: ['偏好'] }]);
await writeBatch('u1', [{ content, importance: 0.95, tags: ['风格'] }]);
// 文件数 1，importance 0.95，mergeCount 1，tags 为并集
```

### ④ `sessionTimeoutMs` 调到极小 → 旧会话过期 + 提炼

用例：`session.test.mjs` › `超时会话：状态置 expired，后续请求 410，并补跑一次提炼`

前端/调用方视角：

```bash
curl -sS -X POST "$BASE/api/session/$SID/message" \
  -H 'content-type: application/json' \
  -d '{"userId":"u_1001","text":"还在吗"}'
# 期望：HTTP 410，error.code = SESSION_EXPIRED，details.canResume = false

curl -sS "$BASE/api/session/$SID?userId=u_1001" | jq '{status,endReason,distilledAt}'
# 期望：status=expired，endReason=timeout，distilledAt 非空
```

### ⑤ 历史里塞 `role:"system"` → 发往上游时消失

用例：`prompt.test.mjs` › `历史中伪造的 system 条目被丢弃（用户无法越权改写 system 段）`

判定：实际发出的 `messages` 中 `role === "system"` 的数量恒为 1（无摘要）或 2（有摘要），且内容等于配置值 / 摘要块，伪造内容不出现。

### ⑥ `SYSTEM_PROMPT` 置空 → 503 + `requiredMissing`

```bash
curl -sS -X POST "$BASE/api/session/create" -H 'content-type: application/json' \
  -d '{"userId":"u_1001"}' | jq '.error'
# 期望：{"code":"CONFIG_MISSING","details":{"requiredMissing":["SYSTEM_PROMPT"]},...}
```

对应用例：`api.test.mjs` › `提示词为空时返回 PROMPT_EMPTY…`（同时断言上游调用次数为 0）。

### ⑦ 管理面响应体搜不到明文

```bash
curl -sS "$BASE/api/admin/config/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "X-Admin-Timestamp: $TS" \
  -H "X-Admin-Signature: $SIG" -o /tmp/status.json

grep -c "$DEEPSEEK_API_KEY" /tmp/status.json   # 期望 0
grep -c "你的提示词前 8 个字" /tmp/status.json   # 期望 0
jq '.checks.deepseekApiKey.masked, .checks.systemPrompt.display' /tmp/status.json
# 期望："sk-****abcd" / "已加载（42 字符）"
```

对应用例：`api.test.mjs` › `管理面签名正确 → 200，且响应体不含任何明文凭据`（对 API Key、提示词全文、管理员 token、HMAC 密钥四项做全文断言）。

### ⑧ 第二条消息的 messages 更长，前 N 条恒为 system

用例：`session.test.mjs` › `每轮都注入完整历史，system 段固定在首位且不重复累积`

断言：`calls[1].messages.length === calls[0].messages.length + 2`；`role === "system"` 计数恒为 1；末条为本轮用户输入。

### ⑨ `context_token` 原样回传；缺失则拒发

用例：
- `api.test.mjs` › `微信回调：回复 payload 必须原样携带入站 context_token`
- `api.test.mjs` › `微信回调缺少 context_token → 拒绝回复（不发到错误窗口）`（断言 `sends.length === 0`）
- `api.test.mjs` › `长轮询：拉取 → 逐条回复 → 落游标…`（断言 `sends[0].msg.context_token === 'ct-poll'`）

### ⑩ `npm test` 不联网即可全绿

`test/helpers.mjs` 注入内存 store 与假 `fetch`，`src/blob.js` 的 `resolveStore` 在收到 `deps.store` 时**不会**执行 `import('@edgeone/pages-blob')`。因此无 `node_modules` 也能跑：

```bash
ls node_modules 2>/dev/null || echo "无依赖目录"
npm test
```

## 4. 生产部署后的联调顺序

| 步骤 | 动作 | 通过标准 |
|---|---|---|
| 1 | `GET /api/health` | `configured: true` |
| 2 | `GET /api/admin/config/status`（签名） | `ok: true`，`warnings: []` |
| 3 | `POST /api/session/create` | 201，`sessionTimeoutMs` 与配置一致 |
| 4 | `POST /api/session/{id}/message`（说一句需要记住的事实） | 200，`memoryWrites[0].ok: true` |
| 5 | `GET /api/admin/memory/{userId}` | `activeCount ≥ 1`，`recallPreview` 含该条 |
| 6 | `POST /api/session/create`（再建一个会话） | `memorySummaryApplied: true` |
| 7 | `POST /api/session/{id}/end` | `distillationScheduled: true` |
| 8 | 等 30 秒后 `GET /api/admin/memory/{userId}` | 新提炼的记忆出现（或 `mergeCount` 增加） |
| 9 | 微信发一条消息（webhook 或 poll） | 微信内收到回复，且回的是同一个会话窗口 |
| 10 | `POST /cron/maintenance`（带 cron secret） | 200，`results` 中无 `error` 字段 |

## 5. 已知边界

| 边界 | 现状 | 处理建议 |
|---|---|---|
| Blob 运行时 | `@edgeone/pages-blob` 目前只提供 Node.js SDK | 必须部署为 `node-functions/`，放进 `edge-functions/` 会 import 失败 |
| `waitUntil` | Node Functions 的 `context` 不含该字段（Edge Functions 才有） | 已实现双路径：有则挂载，无则关键任务同步等待；提炼另加租约，进程被杀后可被维护任务补跑 |
| iLink 字段命名 | 不同租户版本存在 `text` / `content` / `item_list` 差异 | `normalizeInbound` 已做多形态归一；首次接入先拉真实报文核对 |
| 函数执行时长 | 单轮含工具轮可能 2 次上游请求；平台默认 30 秒 | `edgeone.json` 已设 `maxDuration: 60`；`DEEPSEEK_TIMEOUT_MS` 建议 20000 |
| 定时任务精度 | 平台 `schedules` 最小粒度受限（文档同时写「1 分钟」与「最小间隔一天」） | 维护任务优先每小时；微信 30 秒轮询改用外部调度器 |
| 平台 schedules 请求头 | 只能配 path / method / payload，不能自定义 header | 凭据读取顺序改为 header → query → payload（`verifyCronRequest`） |
| 召回读放大 | 每次写记忆扫描活跃集（上限 `MEMORY_DEDUP_SCAN_LIMIT`） | 记忆量 > 2000 时按 `MEMORY_MAX_ITEMS` 收紧，或引入分桶前缀 |
| 相似度合并 | 阈值保守，语义相近但措辞不同不合并 | 观察误合并/漏合并比例后调 `MEMORY_DEDUP_THRESHOLD` |
| 超时会话的提炼 | 依赖「下一次访问」或维护任务触发 | 保证 `/cron/maintenance` 至少每小时跑一次 |
| Blob `onlyIfNew` 语义 | 不同 SDK 版本表达不一致（抛错 / 返回标记 / 静默覆盖） | `src/blob.js` 已兼容三种；去重正确性不依赖它（写前哈希命中检查），最坏只丢一次 `mergeCount` |
| 静态目录 | `outputDirectory` 指向 `./public` | 若某版本不识别，改回根目录发布，并把 `src/`、`test/`、`docs/` 移出发布范围 |
