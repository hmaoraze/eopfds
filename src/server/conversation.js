/**
 * 单轮对话编排：净化输入 → 装配上下文 → 调用 DeepSeek → 执行工具/存忆指令 → 持久化 → 投递。
 */

import { composeMessages, sanitizeUserInput, detectInjectionAttempt, IMMUTABLE_TAIL } from './prompt.js';
import { buildToolSchemas, createToolExecutor, parseTextMemoryCommands } from './llm/tools.js';
import { buildTextMessage, chunkText, DEFAULT_MAX_REPLY_CHARS } from './ilink.js';
import { SessionState } from './session.js';
import { now, truncate } from './lib/util.js';

export class ConversationService {
  constructor({ cfg, llm, ilink, memoryEngine, sessionService, summarizer, log } = {}) {
    this.cfg = cfg;
    this.llm = llm;
    this.ilink = ilink;
    this.memoryEngine = memoryEngine;
    this.sessions = sessionService;
    this.summarizer = summarizer;
    this.log = log || (() => {});
  }

  /**
   * @param {object} input
   *   userId      必填，对端用户标识（iLink from_user_id）
   *   text        用户文本
   *   sessionId   可选；省略时续接活跃会话或自动新建
   *   contextToken 可选；iLink 回传凭证
   *   wire        可选；原始 WireMessage（用于透传 context_token / message_id）
   *   forceNew    是否强制开新会话
   *   deliver     是否立即调用 iLink 发送（默认取 ILINK_DELIVER）
   */
  async handleTurn(input) {
    const t0 = now();
    // 请求体中出现的受保护字段（messages / system / prompt / role …）一律被忽略，只记录告警
    const injections = [
      ...detectInjectionAttempt(input),
      ...(Array.isArray(input.injectionHits) ? input.injectionHits : []),
    ].filter((v, i, arr) => arr.indexOf(v) === i);
    if (injections.length) {
      this.log('warn', 'conv:injection_blocked', { keys: injections, userId: input.userId });
    }

    const userId = String(input.userId || '').trim();
    if (!userId) throw new Error('缺少 userId');

    const rawText = String(input.text ?? '');
    const { text: safeText, warnings } = sanitizeUserInput(rawText, this.cfg);
    if (injections.length) warnings.push(`已忽略请求中的受保护字段：${injections.join(', ')}`);
    if (!safeText) {
      return { skipped: true, reason: 'empty_message', warnings, replyText: '' };
    }

    const contextToken = String(input.contextToken || input.wire?.context_token || '');
    const messageId = String(input.messageId || input.wire?.message_id || input.wire?.client_id || '');

    // ── 1) 显式结束指令 ────────────────────────────────────────────────
    const bareText = rawText.trim();
    const endCommands = this.cfg.SESSION_END_COMMAND_LIST || [];
    if (endCommands.some((c) => bareText.toLowerCase() === c.toLowerCase())) {
      return this.#handleExplicitEnd(userId, { ...input, contextToken }, bareText);
    }

    // ── 2) 解析 / 创建会话 ─────────────────────────────────────────────
    const resolved = await this.sessions.resolve({
      userId,
      sessionId: input.sessionId,
      contextToken,
      sessionRef: input.wire?.session_id,
      forceNew: Boolean(input.forceNew),
      query: bareText,
    });
    const { session, created, previousEnded } = resolved;
    if (!session) return { skipped: true, reason: 'no_active_session_and_auto_create_disabled', replyText: '' };

    // ── 3) 装配上下文（system 区完全由服务端拼装） ──────────────────────
    const messages = composeMessages({
      cfg: this.cfg,
      memoryDigest: session.memoryDigest,
      rollingSummary: session.rollingSummary,
      history: session.messages,
      userText: safeText,
    });

    const useTools = this.cfg.MEMORY_TOOL_ENABLED !== false;
    const tools = useTools ? buildToolSchemas() : undefined;

    let modelMessages = messages.slice();
    let finalContent = '';
    let assistantToolCalls = [];
    const memoriesSaved = [];
    const toolTrace = [];
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let sessionEndedByModel = false;

    const executor = createToolExecutor({
      cfg: this.cfg,
      memoryEngine: this.memoryEngine,
      sessionService: this.sessions,
      userId,
      sessionId: session.sessionId,
      log: this.log,
      recordMemory: (item) => memoriesSaved.push(pickSummary(item)),
      markSessionEnded: () => { sessionEndedByModel = true; },
    });

    const maxRounds = Math.max(0, Number(this.cfg.DEEPSEEK_MAX_TOOL_ROUNDS) || 0);
    for (let round = 0; round <= maxRounds; round++) {
      const res = await this.llm.chat(modelMessages, {
        tools,
        toolChoice: tools ? 'auto' : undefined,
        maxTokens: this.cfg.DEEPSEEK_MAX_TOKENS,
      });
      usage.prompt_tokens += res.usage?.prompt_tokens || 0;
      usage.completion_tokens += res.usage?.completion_tokens || 0;
      usage.total_tokens += res.usage?.total_tokens || 0;

      // 文本约定指令兜底
      let content = res.content || '';
      if (this.cfg.MEMORY_TEXT_COMMAND_ENABLED !== false) {
        const parsed = parseTextMemoryCommands(content);
        content = parsed.cleanText || content;
        for (const cmd of parsed.commands) {
          const item = await this.memoryEngine.write({
            userId,
            content: String(cmd.content).trim(),
            category: cmd.category || 'fact',
            importance: cmd.importance ?? 3,
            tags: Array.isArray(cmd.tags) ? cmd.tags : [],
            source: 'text',
            sessionId: session.sessionId,
          }).catch(() => null);
          if (item) memoriesSaved.push(pickSummary(item));
        }
      }

      if (res.toolCalls.length) {
        assistantToolCalls = res.toolCalls;
        const assistantMsg = { role: 'assistant', content: content || '', tool_calls: res.toolCalls };
        const toolResults = [];
        for (const call of res.toolCalls) {
          toolTrace.push({ name: call.function?.name, arguments: call.function?.arguments });
          const result = await executor.run(call);
          toolResults.push(result);
        }
        modelMessages = [...modelMessages, assistantMsg, ...toolResults];

        if (sessionEndedByModel) break;
        if (content.trim() && round >= maxRounds) { finalContent = content; break; }
        continue;
      }

      finalContent = content;
      break;
    }

    if (!finalContent.trim()) {
      finalContent = sessionEndedByModel
        ? '好的，本次会话已结束，重要信息我已经记下啦。'
        : '抱歉，刚才没有生成有效回复，请再试一次。';
    }

    // ── 4) 持久化 ─────────────────────────────────────────────────────
    await this.sessions.append(session,
      { role: 'user', content: safeText, ts: t0 },
      ...(assistantToolCalls.length ? [{ role: 'assistant', content: finalContent, tool_calls: assistantToolCalls }] : []),
      { role: 'assistant', content: finalContent },
    );
    session.turn += 1;
    session.lastMessageId = messageId || session.lastMessageId;
    await this.sessions.touch(session);

    // ── 5) 达到轮数上限自动结束 ────────────────────────────────────────
    let autoEnded = false;
    const maxTurns = Number(this.cfg.SESSION_MAX_TURNS) || 40;
    if (!sessionEndedByModel && session.turn >= maxTurns) {
      await this.sessions.endSession({ userId, sessionId: session.sessionId, reason: 'max-turns', by: 'system' });
      autoEnded = true;
    } else if (sessionEndedByModel) {
      await this.sessions.endSession({ userId, sessionId: session.sessionId, reason: 'model-requested', by: 'model' });
      autoEnded = true;
    }

    return this.#pack({
      input,
      session,
      created,
      previousEnded,
      replyText: finalContent,
      memoriesSaved,
      toolTrace,
      usage,
      warnings,
      t0,
      stateOverride: autoEnded ? SessionState.ENDED : session.state,
    });
  }

  async #handleExplicitEnd(userId, input, command) {
    let targetId = input.sessionId;
    if (!targetId) {
      const index = await this.sessions.status(userId);
      targetId = index.activeSessionId;
    }
    let memories = [];
    let turn = 0;
    if (targetId) {
      const out = await this.sessions.endSession({ userId, sessionId: targetId, reason: 'user-command', by: 'user' });
      memories = out.memories || [];
      turn = out.session?.turn || 0;
    }
    return this.#pack({
      input,
      session: { userId, sessionId: targetId || '', contextToken: input.contextToken || '', turn, expiresAt: 0, hardDeadline: 0, state: SessionState.ENDED },
      created: false,
      previousEnded: true,
      replyText: '本次会话已结束，重要信息我已记下。下次聊～',
      memoriesSaved: memories.map(pickSummary),
      toolTrace: [{ name: '__end_command__', arguments: command }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      warnings: [],
      t0: now(),
      stateOverride: SessionState.ENDED,
    });
  }

  #pack(args) {
    const { input, session, created, previousEnded, replyText, memoriesSaved, toolTrace, usage, warnings, t0, stateOverride } = args;
    const deliver = input.deliver === undefined ? this.cfg.hasILinkDelivery : Boolean(input.deliver);
    const maxChars = Number(input.maxChars) || DEFAULT_MAX_REPLY_CHARS;
    const chunks = chunkText(replyText, maxChars);
    const contextToken = String(input.contextToken || input.wire?.context_token || session?.contextToken || '');
    const userId = String(input.userId || session?.userId || '');

    const sendMessages = contextToken && userId
      ? chunks.map((c) => buildTextMessage(userId, contextToken, c))
      : chunks.map((c) => ({ text: c }));

    return {
      sessionId: session.sessionId,
      userId,
      state: stateOverride || session.state,
      turn: session.turn,
      created,
      previousEnded,
      expiresAt: session.expiresAt,
      hardDeadline: session.hardDeadline,
      replyText,
      chunks,
      sendMessages,
      contextToken,
      memoriesSaved,
      toolTrace,
      usage,
      warnings,
      deliver: Boolean(deliver),
      latencyMs: now() - t0,
      systemPromptFingerprint: `${this.cfg.SYSTEM_PROMPT?.length || 0}:${IMMUTABLE_TAIL.length}`,
    };
  }
}

function pickSummary(item) {
  return {
    id: item.id,
    content: truncate(item.content, 120),
    importance: item.importance,
    category: item.category,
    merged: Boolean(item.mergedWith || item.deduped),
  };
}
