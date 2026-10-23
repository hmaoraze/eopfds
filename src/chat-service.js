/**
 * 对话编排。把会话、记忆、上游、批量维护串成一条链。
 *
 * 三个必须理解的实现取舍：
 *
 * 1) system 段不落库。会话文档的 messages 只存 user / assistant / tool 三种角色，
 *    system 段在每次请求时由配置现场装配（composeRequestMessages）。
 *    理由：落库会产生「可被历史改写的 system 副本」，一旦某轮写入被污染，
 *    后续所有轮次都会带着污染的 system 段；现场装配保证每轮 system 段只来自配置。
 *    审计需求由 session.systemSnapshot（提示词哈希 + 注入模式）满足。
 *
 * 2) 一轮对话分两段短临界区（beginTurn / completeTurn），中间不持锁。
 *    见 session-service 的注释：不能把 10~40 秒的上游耗时包进锁里。
 *
 * 3) 通道 B（会话提炼）只通过 waitUntil 异步跑，并且用 distilledAt 做一次性闸门。
 *    任何异常都只记录到会话文档的 distillationError，绝不冒泡到用户请求链路。
 */

import { AppError, ErrorCodes } from './errors.js';
import { createDeepSeekClient } from './deepseek.js';
import { createMemoryService, MEMORY_TOOL_SPEC } from './memory.js';
import { createSessionService, SESSION_STATUS } from './session-service.js';
import {
  buildDistillMessages,
  buildSystemSnapshot,
  composeRequestMessages,
  extractJsonArray,
  sanitizeMemoryLine,
} from './prompt.js';

const MAX_USER_TEXT_CHARS = 4000;
const DISTILL_MAX_MESSAGES = 40;
const DISTILL_MAX_CHARS = 6000;

function assertUserText(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new AppError(ErrorCodes.BAD_REQUEST, 'text 不能为空', 400, { field: 'text' });
  }
  const trimmed = text.trim();
  if (trimmed.length > MAX_USER_TEXT_CHARS) {
    throw new AppError(ErrorCodes.BAD_REQUEST, `text 超过 ${MAX_USER_TEXT_CHARS} 字符上限`, 413, {
      field: 'text',
      length: trimmed.length,
    });
  }
  return trimmed;
}

/** 持久化时只保留协议字段，避免把上游响应里的杂质（logprobs 等）写进 Blob。 */
function toStoredAssistant(message) {
  const out = { role: 'assistant', content: typeof message.content === 'string' ? message.content : '' };
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) out.tool_calls = message.tool_calls;
  return out;
}

function accumulateUsage(total, usage) {
  if (!usage) return total;
  return {
    promptTokens: total.promptTokens + Number(usage.prompt_tokens ?? 0),
    completionTokens: total.completionTokens + Number(usage.completion_tokens ?? 0),
    totalTokens: total.totalTokens + Number(usage.total_tokens ?? 0),
  };
}

export function createChatService({ cfg, repo, clock = { now: () => Date.now() }, fetchImpl, waitUntil }) {
  const sessions = createSessionService({ repo, cfg, clock });
  const memories = createMemoryService({ repo, cfg, clock });
  const llm = createDeepSeekClient(cfg, { fetchImpl });

  const background = new Set();
  /**
   * Node Functions 的 context 不含 waitUntil（Edge Functions 才有），
   * 所以不能假设「挂到 waitUntil 就一定跑完」：没有它时，函数返回后进程可能被回收。
   * 策略：非关键任务（记忆访问计数）尽力而为；关键任务（通道 B 提炼）在无 waitUntil 时同步等待。
   */
  const hasWaitUntil = typeof waitUntil === 'function';

  function runInBackground(task, label) {
    const promise = Promise.resolve()
      .then(task)
      .catch((err) => {
        console.error(`[background:${label}] ${err?.code ?? 'ERROR'} ${err?.message ?? err}`);
        return null;
      })
      .finally(() => background.delete(promise));
    background.add(promise);
    if (hasWaitUntil) {
      try {
        waitUntil(promise);
      } catch {
        // waitUntil 抛错不改变语义：任务已经在跑
      }
    }
    return promise;
  }

  /** 关键后台任务：没有 waitUntil 时同步等待，宁可多花 1~3 秒，也不能丢记忆。 */
  async function scheduleCritical(task, label) {
    const promise = runInBackground(task, label);
    if (!hasWaitUntil) await promise;
    return promise;
  }

  async function settleBackground() {
    await Promise.allSettled([...background]);
  }

  async function createSession({ userId, source = 'api', metadata = {} }) {
    const recall = await memories.recall(userId, { k: cfg.memoryTopK });
    const snapshot = await buildSystemSnapshot(cfg.systemPrompt, cfg.promptInjectionMode);
    const doc = await sessions.create({
      userId,
      source,
      metadata,
      memorySummary: recall.summary,
      recallMemoryIds: recall.items.map((m) => m.memoryId),
      systemSnapshot: { ...snapshot, capturedAt: clock.now() },
    });
    if (recall.items.length > 0) {
      // 召回即访问：刷新权重，但不阻塞创建响应
      runInBackground(() => memories.touch(userId, recall.items.map((m) => m.memoryId)), 'memory-touch');
    }
    return {
      sessionId: doc.sessionId,
      status: doc.status,
      createdAt: doc.createdAt,
      expiresAt: sessions.expiresAtOf(doc),
      sessionTimeoutMs: cfg.sessionTimeoutMs,
      memorySummaryApplied: recall.summary !== '',
      memorySummaryItemCount: recall.items.length,
      promptInjectionMode: cfg.promptInjectionMode,
    };
  }

  /** 续接：优先复用可恢复会话，否则新建。微信侧每次收到消息都用这个入口。 */
  async function resumeOrCreate({ userId, source = 'wechat' }) {
    const existing = await sessions.resolveResumable(userId);
    if (existing) {
      return {
        created: false,
        session: {
          sessionId: existing.sessionId,
          status: existing.status,
          createdAt: existing.createdAt,
          expiresAt: sessions.expiresAtOf(existing),
          sessionTimeoutMs: cfg.sessionTimeoutMs,
          turnCount: existing.turnCount,
          memorySummaryApplied: Boolean(existing.memorySummary),
          memorySummaryItemCount: existing.memorySummaryItemCount ?? 0,
        },
      };
    }
    return { created: true, session: await createSession({ userId, source }) };
  }

  async function executeToolCall(call, { userId, sessionId }) {
    const name = call?.function?.name;
    if (name !== 'save_memory') {
      // 未知工具不抛错：把失败当结果回给模型，让它改用可用能力继续作答
      return { ok: false, error: 'unknown_tool', tool: String(name ?? '').slice(0, 40) };
    }
    let args;
    try {
      args = JSON.parse(call?.function?.arguments || '{}');
    } catch {
      return { ok: false, error: 'invalid_arguments_json' };
    }

    const result = await memories.writeBatch(userId, [args], { source: 'tool_call', sessionId });
    const hit = result.written[0] ?? result.merged[0] ?? result.absorbed[0] ?? result.skipped[0];
    if (!hit) {
      return { ok: false, error: result.invalid[0]?.reason ?? 'not_stored' };
    }
    return {
      ok: true,
      memoryId: hit.memoryId,
      // 明确告诉模型是否命中去重，避免它反复重试同一条
      deduped: result.written.length === 0,
      action: result.written.length > 0 ? 'created' : (result.merged.length > 0 ? 'merged' : 'absorbed'),
    };
  }

  async function runUpstream({ doc, userId }) {
    const baseMessages = composeRequestMessages({
      history: doc.messages,
      systemPrompt: cfg.systemPrompt,
      memorySummary: doc.memorySummary ?? '',
      mode: cfg.promptInjectionMode,
      maxHistoryMessages: cfg.historyMaxMessages,
    });

    const tools = cfg.memoryToolEnabled ? [MEMORY_TOOL_SPEC] : undefined;
    const turnMessages = [];
    const memoryResults = [];
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let messages = baseMessages;
    let toolRounds = 0;

    for (let round = 0; round < cfg.toolMaxRounds; round += 1) {
      const res = await llm.chat({ messages, tools, maxTokens: 1200 });
      usage = accumulateUsage(usage, res.usage);
      const toolCalls = Array.isArray(res.message.tool_calls) ? res.message.tool_calls : [];

      if (toolCalls.length === 0) {
        const final = toStoredAssistant(res.message);
        turnMessages.push(final);
        return {
          reply: final.content,
          turnMessages,
          memoryResults,
          usage,
          toolRounds,
          finishReason: res.finishReason,
        };
      }

      toolRounds += 1;
      const assistantMessage = toStoredAssistant(res.message);
      messages = [...messages, assistantMessage];
      turnMessages.push(assistantMessage);

      for (const call of toolCalls) {
        const output = await executeToolCall(call, { userId, sessionId: doc.sessionId });
        memoryResults.push(output);
        const toolMessage = {
          role: 'tool',
          tool_call_id: call.id ?? `call_${memoryResults.length}`,
          content: JSON.stringify(output),
        };
        messages = [...messages, toolMessage];
        turnMessages.push(toolMessage);
      }
    }

    // 工具轮次用尽：去掉 tools 再要一次自然语言答复，避免把 tool_calls 直接抛给用户
    const final = await llm.chat({ messages, tools: undefined, maxTokens: 1200 });
    usage = accumulateUsage(usage, final.usage);
    const stored = toStoredAssistant(final.message);
    turnMessages.push(stored);
    return {
      reply: stored.content,
      turnMessages,
      memoryResults,
      usage,
      toolRounds,
      finishReason: final.finishReason,
      toolsExhausted: true,
    };
  }

  async function sendMessage({ userId, sessionId, text }) {
    const cleanText = assertUserText(text);
    const begun = await sessions.beginTurn({ userId, sessionId, text: cleanText });

    if (begun.expired) {
      // 超时即终结：补跑一次提炼，让这段对话的产出不丢。
      // 用 scheduleCritical：没有 waitUntil 时同步等它落盘，避免 410 返回后任务被回收。
      await scheduleCritical(() => distillSession({ userId, sessionId }), 'distill-on-expire');
      throw new AppError(ErrorCodes.SESSION_EXPIRED, '会话已超时，请创建新会话', 410, {
        sessionId,
        expiredAt: begun.doc?.endedAt ?? clock.now(),
        canResume: false,
      });
    }

    const doc = begun.doc;
    let outcome;
    try {
      outcome = await runUpstream({ doc, userId });
    } catch (err) {
      // 上游失败时释放 in-flight 标记，否则该会话会被 SESSION_BUSY 挡 2 分钟
      await sessions.abortTurn({ userId, sessionId, token: begun.token }).catch(() => {});
      throw err;
    }

    const { doc: saved, stale } = await sessions.completeTurn({
      userId,
      sessionId,
      token: begun.token,
      assistantMessages: outcome.turnMessages,
    });

    return {
      sessionId,
      reply: outcome.reply,
      turnCount: saved.turnCount,
      lastActiveAt: saved.lastActiveAt,
      expiresAt: sessions.expiresAtOf(saved),
      toolRounds: outcome.toolRounds,
      memoryWrites: outcome.memoryResults,
      usage: outcome.usage,
      finishReason: outcome.finishReason ?? null,
      toolsExhausted: outcome.toolsExhausted === true,
      stale,
    };
  }

  async function endSession({ userId, sessionId }) {
    const { doc, alreadyInactive, shouldDistill } = await sessions.end({ userId, sessionId });
    if (shouldDistill) {
      await scheduleCritical(() => distillSession({ userId, sessionId }), 'distill-on-end');
    }
    return {
      sessionId,
      status: doc.status,
      endedAt: doc.endedAt,
      alreadyInactive,
      distillationScheduled: shouldDistill,
    };
  }

  async function getStatus({ userId, sessionId }) {
    const raw = await sessions.get(userId, sessionId);
    if (!raw) throw new AppError(ErrorCodes.SESSION_NOT_FOUND, '会话不存在', 404, { sessionId });
    const { doc } = await sessions.settleExpiry(userId, raw);
    return {
      sessionId: doc.sessionId,
      status: doc.status,
      createdAt: doc.createdAt,
      lastActiveAt: doc.lastActiveAt,
      expiresAt: sessions.expiresAtOf(doc),
      sessionTimeoutMs: cfg.sessionTimeoutMs,
      remainingMs: Math.max(0, sessions.expiresAtOf(doc) - clock.now()),
      turnCount: doc.turnCount,
      messageCount: Array.isArray(doc.messages) ? doc.messages.length : 0,
      memorySummaryApplied: Boolean(doc.memorySummary),
      memorySummaryItemCount: doc.memorySummaryItemCount ?? 0,
      systemSnapshot: doc.systemSnapshot ?? null,
      distilledAt: doc.distilledAt ?? null,
      pending: Boolean(doc.pendingTurn),
      endReason: doc.endReason ?? null,
    };
  }

  /**
   * 对外历史：过滤内部的工具交换协议产物。
   * 带 tool_calls 的 assistant 消息和 role: "tool" 消息都只是协议载体（content 通常为空），
   * 暴露给前端只会出现「空消息」，所以只保留有正文的对话轮次。
   */
  async function getHistory({ userId, sessionId, limit = 50 }) {
    const doc = await sessions.get(userId, sessionId);
    if (!doc) throw new AppError(ErrorCodes.SESSION_NOT_FOUND, '会话不存在', 404, { sessionId });
    const visible = (doc.messages ?? [])
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && !Array.isArray(m.tool_calls) && m.content))
      .slice(-Math.max(1, Math.min(limit, 200)))
      .map((m) => ({ role: m.role, content: m.content, at: m.at ?? null }));
    return { sessionId, count: visible.length, messages: visible };
  }

  /**
   * 通道 B：会话终结提炼。
   * 幂等由 claimDistillation 保证：只有把 distilledAt 从 null 写成功的那次调用会真正执行。
   */
  async function distillSession({ userId, sessionId }) {
    const claim = await sessions.claimDistillation({ userId, sessionId });
    if (!claim.claimed) return { skipped: true, reason: claim.reason ?? 'not_claimed' };

    const doc = claim.doc;
    try {
      const transcript = buildTranscript(doc.messages);
      const res = await llm.chat({
        messages: buildDistillMessages(transcript),
        tools: undefined,
        temperature: 0.2,
        maxTokens: 1200,
        // 提炼用独立超时：它常在有 waitUntil 缺失时被同步等待，不能吃掉整个函数时长
        timeoutMs: cfg.distillTimeoutMs,
      });

      const parsed = extractJsonArray(res.message?.content ?? '');
      if (!parsed) {
        await sessions.releaseDistillation({ userId, sessionId, error: 'json_parse_failed' });
        return { skipped: true, reason: 'json_parse_failed' };
      }

      const items = parsed
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          content: sanitizeMemoryLine(item.content, 200),
          importance: item.importance,
          tags: item.tags,
        }))
        .filter((item) => item.content && item.content !== '[已过滤]')
        .slice(0, 12);

      if (items.length === 0) {
        await sessions.releaseDistillation({ userId, sessionId, count: 0 });
        return { skipped: false, written: 0, merged: 0 };
      }

      const result = await memories.writeBatch(userId, items, {
        source: 'session_summary',
        sessionId,
      });
      const count = result.written.length;
      await sessions.releaseDistillation({ userId, sessionId, count });
      return {
        skipped: false,
        written: count,
        merged: result.merged.length,
        absorbed: result.absorbed.length,
        invalid: result.invalid.length,
      };
    } catch (err) {
      await sessions.releaseDistillation({
        userId,
        sessionId,
        error: `${err?.code ?? 'ERROR'}:${err?.message ?? err}`,
      }).catch(() => {});
      throw err;
    }
  }

  function buildTranscript(messages) {
    const recent = (messages ?? []).slice(-DISTILL_MAX_MESSAGES);
    const lines = [];
    let used = 0;
    for (const message of recent) {
      if (message.role === 'tool') continue;
      const label = message.role === 'user' ? '用户' : '助手';
      const line = `${label}: ${String(message.content ?? '').replace(/\s+/g, ' ').trim()}`;
      if (used + line.length > DISTILL_MAX_CHARS) break;
      lines.push(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  /**
   * 单个用户的维护：结算超时会话 + 提炼（含失败重试）+ 记忆淘汰。
   *
   * 重试语义：上一轮提炼可能因为「进程被回收 / 上游抖动 / 输出不是 JSON」失败，
   * 失败时 distilledAt 仍是 null，这里按租约 + 次数上限补跑。
   * 上限 3 次是为了避免一个持续输出非法 JSON 的会话把每小时的维护预算吃光。
   */
  async function sweepUser(userId) {
    const docs = await sessions.listByUser(userId, { limit: 200 });
    const expired = [];
    const retried = [];

    for (const doc of docs) {
      if (doc.status === SESSION_STATUS.ACTIVE) {
        if (!sessions.isExpired(doc)) continue; // 活跃且未超时：不动
        await sessions.settleExpiry(userId, doc);
        expired.push(doc.sessionId);
        runInBackground(() => distillSession({ userId, sessionId: doc.sessionId }), 'distill-on-sweep');
        continue;
      }

      // 已结束 / 已超时但从未成功提炼过的会话：补跑
      const attempts = Number(doc.distillationAttempts ?? 0);
      const hasDialog = Array.isArray(doc.messages) && doc.messages.length > 0;
      if (!doc.distilledAt && hasDialog && attempts < 3) {
        retried.push(doc.sessionId);
        runInBackground(() => distillSession({ userId, sessionId: doc.sessionId }), 'distill-retry');
      }
    }

    const ttl = await memories.deactivateExpired(userId);
    const capacity = await memories.enforceCapacity(userId);
    // 单用户巡检没有 sweepAll 的外层收尾，无 waitUntil 时必须自己等任务落盘
    if (!hasWaitUntil) await settleBackground();
    return { userId, expiredSessions: expired, retriedSessions: retried, ttl, capacity };
  }

  /** 全量维护：从会话与记忆两处 key 空间反推 userId，避免依赖额外的用户索引表。 */
  async function sweepAll({ maxUsers = 50 } = {}) {
    const sessionKeys = await sessions.listAllKeys({ limit: 2000 });
    const userSet = new Set();
    for (const key of sessionKeys) {
      const match = /^sessions\/([^/]+)\//.exec(key);
      if (match) userSet.add(match[1]);
    }
    const memoryKeys = await repo.listKeys('memories/', { limit: 2000 });
    for (const key of memoryKeys) {
      const match = /^memories\/([^/]+)\//.exec(key);
      if (match) userSet.add(match[1]);
    }

    const users = [...userSet].slice(0, maxUsers);
    const results = [];
    for (const userId of users) {
      try {
        results.push(await sweepUser(userId));
      } catch (err) {
        results.push({ userId, error: `${err?.code ?? 'ERROR'}:${err?.message ?? err}` });
      }
    }

    const hardDeleted = [];
    for (const userId of users) {
      try {
        const res = await memories.hardDeleteInactive(userId);
        if (res.deleted.length > 0) hardDeleted.push({ userId, deleted: res.deleted.length });
      } catch {
        // 物理清理失败不影响下一轮
      }
    }

    return {
      scannedUsers: users.length,
      sessionKeys: sessionKeys.length,
      memoryKeys: memoryKeys.length,
      results,
      hardDeleted,
      settledBackground: await settleBackground().then(() => true),
    };
  }

  async function memoryStats(userId) {
    const stats = await memories.stats(userId);
    const recall = await memories.recall(userId, { k: cfg.memoryTopK });
    return {
      ...stats,
      topK: cfg.memoryTopK,
      recallPreview: recall.items.map((item) => ({
        memoryId: item.memoryId,
        importance: item.importance,
        weight: Number(item.weight.toFixed(4)),
        tags: item.tags,
        isActive: item.isActive,
      })),
    };
  }

  return {
    createSession,
    resumeOrCreate,
    sendMessage,
    endSession,
    getStatus,
    getHistory,
    distillSession,
    sweepUser,
    sweepAll,
    memoryStats,
    settleBackground,
    runInBackground,
    // 供测试与运维直接使用的下层服务
    sessions,
    memories,
    llm,
  };
}
