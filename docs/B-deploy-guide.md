# 部署教程（EdgeOne Makers · Node Functions）

> 面向第一次在这个项目上部署的人。按顺序执行，每步都有「怎么判断成功」。
> 平台控制台改版频繁，凡是菜单文案可能变化的步骤，我都写了「找什么」而不是「点第几个」。

---

## 0. 先看清三个平台事实

这三条决定了后面所有步骤，先记住：

| 事实 | 后果 |
|---|---|
| 函数目录必须是 `node-functions/`（不是 `functions/`） | 放错目录 → 所有接口 404 |
| Blob 目前**只有 Node.js SDK** | 只能部署到 Node Functions，不能放 `edge-functions/`，否则 import 直接失败 |
| Node Functions 单次运行默认 **30 秒**，`context` 里**没有 `waitUntil`** | 必须把 `maxDuration` 调大；异步任务不能依赖 `waitUntil`，本项目已改为「无 waitUntil 时同步等待 + 租约重试」 |

另外两个额度：请求体 ≤ 6 MB，代码包 ≤ 128 MB。本项目的记忆全部写在 Blob 里，函数包只有几百 KB。

---

## 1. 部署前后的目录对照

仓库里已经是部署形态，不需要你搬文件：

```
项目根
├── node-functions/                     ← 平台扫描这个目录生成路由
│   ├── api/[[default]].js              → /api/*（所有业务接口）
│   └── cron/maintenance.js             → /cron/maintenance（维护任务）
├── src/                                ← 被 node-functions 通过相对路径引用
├── public/
│   └── admin.html                      → /admin.html（静态配置页）
├── edgeone.json                        ← 构建与定时任务配置
├── package.json
└── docs/ test/ scripts/
```

路由映射（平台按文件路径生成，大小写敏感）：

| 文件 | 路由 |
|---|---|
| `node-functions/api/[[default]].js` | `/api/session/create`、`/api/admin/config/status`、`/api/wechat/webhook` … |
| `node-functions/cron/maintenance.js` | `/cron/maintenance` |
| `public/admin.html` | `/admin.html` |

> `[[default]].js` 是「该目录下任意层级」的通配，所以不需要为每个端点建文件。

---

## 2. 本地先跑通（5 分钟）

部署前必须本地全绿，否则线上排障会同时面对「代码问题」和「平台问题」。

```bash
npm test
```

成功标志：

```
# tests 61
# pass 61
# fail 0
```

再起一个假上游的本地服务，肉眼确认链路（这一步不联网、不需要任何密钥）：

```bash
node scripts/dev-server.mjs 8787
```

浏览器打开 `http://127.0.0.1:8787/admin.html`，用终端打印的 token / secret 登录，应看到「配置完整 / 已就绪」四项。这一步验证的是前端页面与签名算法，与线上无关，但能提前排掉 80% 的「管理页打不开」。

---

## 3. 关于 Blob：不需要提前创建

与我之前文档里的说法不同（已修正）：**Blob 不需要在控制台预先创建 Store**。`getStore({ name, consistency: 'strong' })` 首次调用即按名字创建命名空间，属于「即用即得」。

你需要确认的只有两件事：

1. 项目已开通 Blob 能力（默认开通，控制台存储页能看到用量）。
2. 免费版账户总容量 1 GB —— 本项目一条记忆约 300~600 字节，1 GB 约等于 200 万条，正常使用不会触顶。

`BLOB_STORE_NAME` 只是一个命名空间名字，建议 `chat-memory`（小写、无空格）。**一致性不在这里配**，它写在代码里（`src/blob.js` 的 `getStore` 调用处），这是刻意的：配置项可以被改错，代码常量不会。

---

## 4. 生成三组密钥

在本地终端执行，把输出记到密码管理器：

```bash
# 管理员 Token（浏览器登录用）
openssl rand -hex 24

# 管理员 HMAC 密钥（签名用，必须与上面不同）
openssl rand -hex 32

# 定时任务密钥
openssl rand -hex 24
```

三个值不要复用。`ADMIN_TOKEN` 泄漏 = 别人能看配置状态；`ADMIN_HMAC_SECRET` 泄漏 = 别人能伪造签名；`CRON_SECRET` 泄漏 = 别人能触发维护任务。

---

## 5. 配置环境变量

控制台 → 你的项目 → 项目设置 → 环境变量（找「Environment Variables」）。**生产环境**单独配一份，不要与预览环境共用。

### 5.1 必填四项（缺一项整个对话服务 503）

| 变量 | 填什么 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | `sk-...` | DeepSeek 控制台创建。**不要**填 `MAKERS_MODELS_KEY`，代码不做回退 |
| `BLOB_STORE_NAME` | `chat-memory` | 见第 3 节 |
| `SYSTEM_PROMPT` | 多行人设 | 去空白后不得为空。建议先写 3~10 行：身份、语气、禁止事项、输出格式 |
| `SESSION_TIMEOUT_MS` | `1800000` | 30 分钟。会话超时即触发记忆提炼 |

### 5.2 强烈建议一起配的四项（不配会用默认值，但默认值不适合生产）

| 变量 | 建议值 | 原因 |
|---|---|---|
| `DEEPSEEK_TIMEOUT_MS` | `20000` | 单次上游超时。默认 45s 会撑爆 30s 的函数时长 |
| `DISTILL_TIMEOUT_MS` | `12000` | 提炼超时独立设置，避免它吃掉整轮预算 |
| `ADMIN_TOKEN` | 第 4 节生成 | 不配则 `/admin/*` 全部 503（对话不受影响） |
| `ADMIN_HMAC_SECRET` | 第 4 节生成 | 同上 |

### 5.3 定时任务与微信

| 变量 | 填什么 |
|---|---|
| `CRON_SECRET` | 第 4 节生成 |
| `WECHATBOT_TOKEN` | wechatbot.dev 后台的网关凭据 |
| `WECHATBOT_WEBHOOK_SECRET` | 自定义随机串，回调时放在 `x-wechatbot-secret` 头里 |
| `WECHATBOT_BASE_URL` | 默认 `https://ilinkai.weixin.qq.com`，按你的租户改 |

其余可选项（记忆容量、衰减系数、注入模式等）见 `docs/B-config.md`，**首次部署不要改**，先用默认值跑通再调。

### 5.4 怎么判断配对了

打开 `/admin.html`，用 token + secret 登录：

- 四项全部显示「已就绪」→ 通过
- 某一项红灯「必须配置」→ 回控制台补
- 有黄色 warning 提到 `MAKERS_MODELS_KEY` → 说明你只配了网关 Key，DeepSeek 直连仍不可用

---

## 6. 部署代码

### 方式 A：Git 导入（推荐，后续自动部署）

1. 仓库推到 GitHub / Gitee / 腾讯工蜂等。
2. 控制台 → 新建项目 → 导入 Git 仓库 → 选中仓库。
3. 构建配置：
   - 框架预设：**无 / Other**
   - 构建命令：**留空**
   - 输出目录：`public`（会被 `edgeone.json` 覆盖，填不填都行）
   - 根目录：`/`
4. 点部署。

`edgeone.json` 已经声明了 `outputDirectory: "./public"`，所以平台只会把 `public/` 当静态资源发布，`src/`、`test/`、`docs/` 不会暴露成可下载的文件。

### 方式 B：CLI

```bash
npm i -g edgeone

# 首次：登录并关联项目
edgeone login
edgeone makers link          # 若你的 CLI 版本没有 makers 子命令，用 edgeone pages link

# 本地预览（含函数，端口默认 8088）
edgeone makers dev           # 或 edgeone pages dev

# 发布
edgeone makers deploy        # 或 edgeone pages deploy
```

> 不同 CLI 版本把命令归在 `makers` 或 `pages` 下，两者行为一致；`edgeone --help` 看一眼即可。

### 方式 C：控制台直传

适合快速验证。把仓库打成 zip（**必须包含 `node-functions/`、`src/`、`public/`、`edgeone.json`、`package.json`**），控制台选「上传项目」。不要只传 `public/`，否则函数不会部署。

### 6.1 `edgeone.json` 里每一项的作用

| 字段 | 值 | 为什么 |
|---|---|---|
| `outputDirectory` | `./public` | 只发布静态页，避免把源码当静态资源暴露 |
| `nodeVersion` | `20.18.0` | 平台预装版本，避免指定不存在的版本导致构建失败 |
| `cloudFunctions.nodejs.maxDuration` | `60` | 默认 30s 不够：一轮可能两次上游调用（工具轮 + 终结） |
| `cloudFunctions.mainlandRegions` | `ap-guangzhou` | 国内用户就近；海外默认 `ap-singapore`，可改 |
| `headers` | `/admin.html` 禁缓存 | 配置页每次都要最新状态，缓存会导致「改了配置看不到」 |
| `schedules` | 每小时维护任务 | 见第 7 节 |

### 6.2 部署成功的判断

```bash
curl -sS https://<你的域名>/api/health
```

期望：

```json
{"ok":true,"service":"edgeone-makers-chat","configured":true,"requiredMissing":[],"promptInjectionMode":"dual_system","memoryToolEnabled":true}
```

`configured: false` 说明环境变量没生效（常见原因：配到了预览环境、或改完没重新部署）。环境变量变更**必须重新部署**才会注入到函数。

访问 `https://<域名>/admin.html` 应能打开配置页；404 说明 `outputDirectory` 没生效或静态资源没上传。

---

## 7. 配置定时任务

### 7.1 两条任务，两种触发方式

| 任务 | 建议频率 | 作用 |
|---|---|---|
| `/cron/maintenance` | 每小时 | 结算超时会话、补跑记忆提炼、记忆过期淘汰、物理清理 |
| `/api/wechat/poll` | 30 秒（仅在使用长轮询时） | 拉取微信消息并回复 |

### 7.2 平台内置 schedules

`edgeone.json` 里已配好维护任务：

```json
"schedules": [{
  "name": "chat-maintenance",
  "cron": "0 * * * *",
  "path": "/cron/maintenance",
  "method": "POST",
  "payload": { "token": "REPLACE_WITH_CRON_SECRET", "maxUsers": 25 },
  "timezone": "Asia/Shanghai"
}]
```

三个必须知道的点：

1. **`payload.token` 必须替换成真实的 `CRON_SECRET`**，否则任务会返回 401（这是故意的「失败即关闭」）。替换后请勿把真实密钥提交回仓库——更稳妥的做法是删掉 `schedules` 这一段，改在控制台的「定时任务」里配同样的 path 与 payload。
2. 平台 schedules **不能自定义请求头**，所以本项目把凭据读取顺序设为 `header → query → payload`（见 `src/auth.js#verifyCronRequest`）。用 query 传密钥会进访问日志，能不用就不用。
3. 官方文档同时写了「cron 最小精度为一分钟」和「最小间隔为一天」。若你的项目配每小时任务时被拒，两种处理：改成 `0 3 * * *`（每天一次，把 `maxUsers` 调到 100），或改用外部调度器。

### 7.3 外部调度器（更可控，推荐用于 30 秒轮询）

任何能发 HTTP 的工具都行（云函数定时触发器、服务器 crontab、Uptime 类服务）：

```bash
# 维护任务：每小时
curl -sS -X POST https://<域名>/cron/maintenance \
  -H "x-cron-secret: $CRON_SECRET" \
  -H 'content-type: application/json' \
  -d '{"maxUsers":25}'

# 微信轮询：每 30 秒
curl -sS -X POST https://<域名>/api/wechat/poll \
  -H "x-cron-secret: $CRON_SECRET" \
  -H 'content-type: application/json' \
  -d '{"maxMessages":10,"timeBudgetMs":20000}'
```

成功返回里 `results` 不应出现 `error` 字段；`replied` 是本次回复条数。

### 7.4 关于 30 秒轮询的现实约束

平台 schedules 做不到 30 秒级。所以：

- 如果 wechatbot.dev 支持 **webhook 推送**，优先用推送（第 8.1 节），把 `/api/wechat/poll` 停掉。
- 如果只能用长轮询，就用外部调度器每 30 秒打一次 `/api/wechat/poll`。

---

## 8. 接微信（iLink）

### 8.1 方式一：Webhook 推送（低延迟，推荐）

在 wechatbot.dev 后台把回调地址设为：

```
https://<域名>/api/wechat/webhook
```

并把 `WECHATBOT_WEBHOOK_SECRET` 配到对方的自定义请求头 `x-wechatbot-secret`（如果对方后台只支持固定头，就在网关侧加一层转发）。

验证：

```bash
curl -sS -X POST https://<域名>/api/wechat/webhook \
  -H "x-wechatbot-secret: $WECHATBOT_WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d '{"msg":{"from_user_name":"oTest001","context_token":"ct-test","msg_id":"m1","text":"在吗"}}'
```

期望 `{"ok":true,"replied":true,"sessionId":"s_..."}`，且微信里能收到回复。

### 8.2 方式二：长轮询

见 7.3 的 `/api/wechat/poll`。首次接入建议先手动跑一次，检查返回的 `fetched / replied / skipped`。

### 8.3 字段对不上怎么办

不同租户的 iLink 网关对「文本」的字段命名可能是 `text`、`content` 或 `item_list[0].text_item.text`。本项目在 `src/wechat.js#normalizeInbound` 做了多形态归一。若你的报文还有别的形状，**只改这一个函数**，不要动业务代码。

排查技巧：把入站报文原样发到 webhook，看返回里 `replied` 是否为 true；若 `skipped: true` 且 `reason: unsupported_message`，说明归一化没认出来，把报文贴进 `normalizeInbound` 的候选字段即可。

### 8.4 两个致命细节

- **`context_token` 必须原样回传**。缺失时本服务直接拒发（400），而不是「发出去赌一把」——发错窗口比不回更糟。
- 回复只能发回**同一个 context_token 对应的窗口**，不能按 userId 主动推送。想主动推送是另一个协议能力，本项目未使用。

---

## 9. 上线验收（照着打，10 分钟）

| # | 命令 / 操作 | 通过标准 |
|---|---|---|
| 1 | `curl /api/health` | `configured: true` |
| 2 | 打开 `/admin.html` 登录 | 四项「已就绪」，无红色「必须配置」 |
| 3 | 创建会话 | `POST /api/session/create` → 201，`sessionTimeoutMs` 等于你配的值 |
| 4 | 说一句需要记住的话 | 200，`memoryWrites[0].ok: true` |
| 5 | 查记忆 | `GET /api/admin/memory/{userId}`（签名）→ `activeCount ≥ 1` |
| 6 | 新建第二个会话 | `memorySummaryApplied: true`（能召回上一条） |
| 7 | 结束会话 | `POST /api/session/{id}/end` → `distillationScheduled: true` |
| 8 | 等 30 秒再跑维护任务 | `POST /cron/maintenance` → 200，`results[*]` 无 `error` |
| 9 | 微信发一句话 | 微信内收到回复 |
| 10 | 把 `SESSION_TIMEOUT_MS` 临时改成 `60000` 再部署，等 1 分钟发消息 | 返回 410 `SESSION_EXPIRED`（验完记得改回去） |

签名命令见 `docs/B-deploy-verify.md` 第 2.1 节，可直接复制。

---

## 10. 回滚与灰度

- **回滚**：控制台部署历史里选上一个成功版本「重新部署」。Blob 数据不需要迁移——会话与记忆都带 `schemaVersion`，字段只增不改。
- **灰度**：平台支持预览部署。建议先让预览环境的函数指向**同一个 Blob Store 的独立命名空间**（例如 `chat-memory-staging`），避免测试数据污染线上记忆。
- **改提示词**：只改 `SYSTEM_PROMPT` 并重新部署。新会话立即生效；老会话的 `systemSnapshot.promptHash` 会显示它创建时用的是哪一版。
- **紧急止血**：把 `MEMORY_TOOL_ENABLED` 设为 `false` 重新部署，模型不再主动写记忆（通道 B 仍会在会话结束时提炼）；或直接把 `DEEPSEEK_API_KEY` 清空让业务接口 503（宁可不可用，不可乱答）。

---

## 11. 故障排查

| 症状 | 最可能原因 | 处理 |
|---|---|---|
| 所有 `/api/*` 返回 404 | 目录不是 `node-functions/`，或文件名不是 `[[default]].js` | 对照第 1 节 |
| 部署日志报 `Cannot find module '@edgeone/pages-blob'` | 依赖未安装 | 确认 `package.json` 有该依赖，且构建执行了 `npm install` |
| 部署日志报 `getStore is not a function` | 装到了 Edge Functions 运行时 | 确认函数在 `node-functions/`，不在 `edge-functions/` |
| `/api/health` 里 `configured: false` | 环境变量没配到生产环境，或改完没重新部署 | 配好后重新部署 |
| 业务接口 503 `CONFIG_MISSING` | 必填项缺失 | 看 `error.details.requiredMissing` |
| 503 `STORAGE_UNAVAILABLE` | Blob 不可用 / 内容损坏 / 未安装 SDK | 看 `details.operation` 与 `details.key` |
| 502 `UPSTREAM_ERROR` | DeepSeek Key 错、余额不足、超时 | 看 `details.upstreamStatus`：401=Key 错，402=余额，429=限流 |
| 409 `SESSION_BUSY` | 上一轮还没跑完 | 客户端按 `retryAfterMs` 退避；持续出现说明上游太慢，调小 `DEEPSEEK_TIMEOUT_MS` |
| 409 `LOCK_TIMEOUT` | 同一会话/记忆并发写 | 重试；持续出现说明锁租约太短或有长事务 |
| 记忆写了但下个会话没带上 | 摘要只在**创建会话时**生成，老会话不刷新 | 新建会话验证；或确认 `memorySummaryItemCount > 0` |
| 管理页登录一直 401 | 时间戳偏差 > 5 分钟（本机时间不准），或 token/secret 配错 | 校准系统时间；重新复制密钥 |
| 管理页 503 | `ADMIN_TOKEN` / `ADMIN_HMAC_SECRET` 未配 | 补配并重新部署 |
| 函数执行超时 | 一轮里上游调用 > `maxDuration` | `maxDuration` 提到 60，`DEEPSEEK_TIMEOUT_MS` 降到 20000，`TOOL_MAX_ROUNDS` 降到 2 |
| 微信不回复 | 缺 `context_token` / 网关凭据错 / 轮询没在跑 | 先手动打 `/api/wechat/poll` 看 `fetched` 与 `errors` |
| 微信回复串到别的会话 | 没有按入站 `context_token` 回传 | 本项目已强制校验；若仍出现，检查网关是否复用了 token |
| `/admin.html` 404 | `outputDirectory` 未生效 | 确认 `edgeone.json` 已提交，或改回根目录发布 |

---

## 12. 成本与配额

| 项目 | 免费额度 | 本项目的消耗特征 |
|---|---|---|
| Blob 存储 | 1 GB / 账户 | 一条记忆约 300~600 B；1 万条约 5 MB |
| Node Functions 调用 | 按平台套餐 | 每轮对话 1~2 次调用；轮询每 30 秒 1 次（一天 2880 次） |
| DeepSeek | 按 token 计费 | 每轮带历史 + 工具定义，约 1~3k prompt tokens |
| 记忆提炼 | 每次会话结束 1 次 | 输入是最近 40 条消息、上限 6000 字符 |

省钱的三个旋钮：`HISTORY_MAX_MESSAGES`（历史窗口）、`MEMORY_TOP_K`（召回条数）、`TOOL_MAX_ROUNDS`（工具轮次）。

---

## 13. 上线检查清单（可打印）

```
[ ] npm test 全绿（61/61）
[ ] node-functions/ 目录存在，api/[[default]].js 与 cron/maintenance.js 就位
[ ] edgeone.json 的 outputDirectory = ./public
[ ] cloudFunctions.nodejs.maxDuration = 60
[ ] 四个必填环境变量已配且已重新部署
[ ] ADMIN_TOKEN / ADMIN_HMAC_SECRET 已配，admin.html 能登录
[ ] CRON_SECRET 已配，维护任务返回 200
[ ] schedules 的 payload.token 已替换（或改用控制台配置）
[ ] /api/health 返回 configured: true
[ ] 建会话 → 发消息 → 记忆落盘 → 新会话能召回（四步全通）
[ ] 微信侧收发一条真实消息成功
[ ] 确认 src/ test/ docs/ 无法通过 URL 直接访问
```
