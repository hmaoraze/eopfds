# 记忆方案详解

## 总览

```text
         ┌──────────── 写入侧 ────────────┐
模型主动：save_memory 工具 / #MEMORY#{...}# 文本指令
会话终态：显式结束 或 超时回收 → LLM 提炼候选
                    │
                    ▼
        MemoryEngine.write()  ← 指纹去重 → 相似度合并 → 新增
                    │
                    ▼
        多维打分 → 容量裁剪 → 过期淘汰 → 落库 mem:v1:{uid}
                    │
         ┌──────────┴────────── 读取侧 ─────────┐
         ▼                                      ▼
  ① 新会话：压缩为摘要 → 注入 system 最前部   ② 运行时：search_memory 按相关度检索
```

---

## 1. 写入通道

### 通道 A：模型主动保存（function calling）

开放三个工具：

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `save_memory` | `{ content, importance?:1-5, category?, tags?, ttlDays? }` | 写入一条长期记忆 |
| `end_session` | `{ reason? }` | 主动结束本次会话（会触发通道 B 的提炼） |
| `search_memory` | `{ query, limit? }` | 检索当前用户的长期记忆 |

模型的出资额争论依赖前置提示词中的约定（默认第 7 条）：「涉及用户的稳定事实（称呼、偏好、长期目标、禁忌）请调用 `save_memory` 工具保存」。工具执行结果回灌上下文，模型据此向用户确认。

### 通道 B：文本约定指令（工具调用的兜底）

部分模型在长上下文下可能忘记调工具，约定协议：

```text
#MEMORY#{"content":"用户住在杭州","importance":4,"category":"fact","tags":["地点"]}#
```

服务端在**把回复发给用户之前**抽取并移除这些块，因此用户看不到任何机械感的输出。可多行、可多块；解析失败的原样返回，不会造成回复丢失。用户如果想伪造，输入里的 `#MEMORY#` 会在 `sanitizeUserInput` 阶段被直接抹除并记录 warning。

### 通道 C：会话终态自动提炼

无论 `ended`（显式）还是 `expired`（超时），都会执行：

1. 取会话最后若干条消息 + 滚动摘要；
2. 调用 LLM（`MEMORY_EXTRACT_MAX` 限制条数，默认 8）输出候选记忆列表；
3. `writeBatch(source='extract')` 批量入库。

幂等性由 `session.extractedAt` 保证 —— 同一个会话永远只提炼一次。

---

## 2. 去重与合并

写入一条新记忆时按顺序判定：

**① 指纹去重（精确）**
`fingerprint = shortHash(normalizeContent(content), 20)`。
命中 → 只更新 `hits++` / `updatedAt` / `expiresAt` / `tags` 并提升 `importance`，返回 `{ deduped: true }`。

**② 相似度合并（模糊）**
与全部现存条目计算**字符二元组 Jaccard 相似度**（中英文通用）：

```
sim(A,B) = |bigrams(A) ∩ bigrams(B)| / |bigrams(A) ∪ bigrams(B)|
```

`sim ≥ MEMORY_SIMILARITY_MERGE`（默认 0.82）时命中最高者并合并：
- `hits++`、`mergedCount++`、`tags` 取并集、`importance` 取较大；
- **表述选择**：当新内容 `importance` 不低于旧的、且文本更长时，替换 `content` 并把旧值存到 `previousContent`（保留更具体的表述，避免退化）；
- 返回 `{ mergedWith: true, similarity }`。

**③ 新增**
创建带 `id / createdAt / expiresAt / source` 的完整条目。

> `normalizeContent` 做了小写化、全角转半角、剔除全部标点与空白，因此「我叫小明」与「我叫 小明！」会命中同一指纹。

---

## 3. 打分与排序

```
score = Σ wᵢ · xᵢ   （权重在 MEMORY_WEIGHTS 中配置，内部归一化）

x_importance = clamp(importance, 1, 5) / 5
x_recency    = 0.5 ^ (ageHours / MEMORY_HALF_LIFE_HOURS)      // 默认半衰期 72h
x_frequency  = log(1 + hits) / log(1 + maxHits + 1)           // 对数压缩，防头部垄断
x_relevance  = Jaccard(记忆内容, 当前查询词)                    // 无查询时该项权重按比例并入其余三项
```

默认权重：`importance 0.4 / recency 0.3 / frequency 0.15 / relevance 0.15`。

- **重要度高不代表长期靠前**：一条 importance=5 但从未被想起的记忆，75 小时后 recency 衰减到 0.5；
- **常想起的记忆会浮上来**：`hits` 每次被注入摘要或检索命中都会累加；
- **相关度只在有查询时参与**：`search_memory` 工具调用或 `memory-list?query=` 时生效。

---

## 4. 容量裁剪与过期淘汰

每次写入后执行 `evict()`：

1. **清理过期**：删除 `expiresAt != 0 && expiresAt <= now` 的条目；
2. **容量裁剪**：若 `items.length > MEMORY_MAX_ITEMS`（默认 200），按 `score` 升序逐条淘汰，直到回到上限；
3. **豁免规则**：`importance ≥ MEMORY_PIN_IMPORTANCE`（默认 5）**且仍在有效期内**的条目暂不参与容量淘汰 —— 让用户的关键禁忌、过敏源等永不被挤掉；到期后自动恢复普通规则。

过期时间：`MEMORY_TTL_DAYS`（默认 180 天，`0` 表示永不过期）。每次被去重命中 / 合并命中都会**顺延**过期时间，等价于「仍在被想起的事实不会过期」。

---

## 5. 注入到上下文（新会话）

```text
Summarizer.buildMemoryDigest({ userId, query })
   ① 查缓存 msum:v1:{uid}             命中且指纹未变 → 直接复用
   ② 否则：MemoryEngine 排序取 TopK（MEMORY_INJECT_MAX，默认 12）
   ③ 调 LLM 压缩成要点列表（限制 MEMORY_INJECT_MAX_CHARS 字符，默认 1800）
   ④ 写回缓存 + markHit(ids)
```

注入位置：`system` 消息的最前部（前置提示词之前），即：

```
## 关于这位用户的长期记忆
· 用户叫小明，住在杭州
· 偏好简洁的要点式回答
· 对芒果过敏

## 人设、规则与输出约束（最高优先级）
……
【不可变更条款】
……
```

关键设计：**摘要在会话创建那一刻固化**（`session.memoryDigest`），整个会话生命周期内不再变化。这带来两个好处：

1. 同一会话内上下文始终稳定，不会因为记忆库变动而让模型「前后矛盾」；
2. 会话中途写入的新记忆不会在本轮污染上下文，而是在**下一轮新会话**才生效。

---

## 6. 相关度检索（运行时）

`search_memory` 工具调用时：

```
query 与每条记忆计算 x_relevance = Jaccard(bigrams(normalize(query)), bigrams(normalize(content)))
score 由 4 项加权得出 → 降序取 TopK → markHit
```

这让「用户刚提到的话题」能够即时唤回相关历史，而不依赖是否被静态注入。

---

## 7. 调参建议

| 场景 | 建议 |
| --- | --- |
| 客服 / 知识问答 | `MEMORY_INJECT_MAX` 20~30，`MEMORY_MAX_ITEMS` 500，`MEMORY_HALF_LIFE_HOURS` 336（两周） |
| 私人助理 / 陪伴 | `MEMORY_INJECT_MAX` 12，`MEMORY_TTL_DAYS` 0，`MEMORY_WEIGHTS.recency` 降到 0.15、`importance` 提到 0.55 |
| 成本敏感 | `MEMORY_INJECT_MAX_CHARS` 800，`MEMORY_MAX_ITEMS` 60，`DEEPSEEK_MEMORY_MODEL` 指向便宜模型 |
| 高重复表述 | 把 `MEMORY_SIMILARITY_MERGE` 降到 0.7 让合并更激进 |

---

## 8. 运维接口

- `op=memory-list?userId=&query=` — 查看某用户的记忆与统计（条数、平均重要度、最早/最晚更新时间、是否触顶）；
- `op=memory-delete` — 删除单条；
- `op=memory-purge` — 清空该用户全部记忆（审计会记录一条 `memory-purge`）。

数据出口遵循最小化原则：记忆仅在管理端 Passkey 认证后可见，不进任何对外 JSON 接口的默认返回。
