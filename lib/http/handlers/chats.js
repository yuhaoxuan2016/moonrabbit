// lib/http/handlers/chats.js —— M-08·chats-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const agentBudgetLib = require('../../agent/budget');
const agentValidate = require('../../agent/validate');
const agentPlanLib = require('../../agent/plan');
const { agentModeOn } = require('../../agent/mode');
const { agentTools, runAgentPlan, agentRetryCall, agentSelfCheckFor, agentAugmentSystem, opInject, executeBridgeTool, bridgeDirectTool, runBridgeToolLoop, groupRuntime } = require('../../chats/agentbridge');
const { buildSystemPrompt, turnTagPrompt, recordPrompt, appendTurnRecord, buildStoryMemory, callLLM, summarizeOldMessages } = require('../../chats/core');
const { writeFileAtomicSync } = require('../../core/io');
const { DATA_DIR } = require('../../core/paths');
const { State } = require('../../core/state');
const { agentTokenBucket } = require('./agent');
const { readBody } = require('../respond');
const { toolsEnabled } = require('../../prompt/vars');
const { chatFilePath } = require('../../store/chats');
const { readLastChat } = require('../../store/config');
const { emotionInject } = require('../../store/emotions');
const { emptyBucket, stats, saveStats, bucket } = require('../../store/stats');
const { sanitizeId, turnsFile } = require('../../tools/misc');
const { appendOpRecord } = require('../../turns/record');
const { readTurns } = require('../../turns/store');
const { vecSearch } = require('../../vec/index');

async function h_api_chat_74(req, res, url, p) {
  if (p === '/api/chat' && req.method === 'POST') {
      const OPENING_PIN_MIN_CHARS = 300;   // 首条消息保底注入 system 的最小长度（开局注入/长提示词；短问候不 pin）
      let body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch (e) {
        res.writeHead(400); { res.end('bad json'); return true; };
      }
      if (!State.endpoint.apiKey) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        { res.end('未找到 API Key（请在 header「API」设置里配置）'); return true; };
      }
      // ── 群聊模式分流 ─────────────────────────────────────────────────
      // 仅当该会话显式开启 groupMode 才走群聊；缺省 false → 下方单脑逻辑一字不改。
      {
        let gcfg = null;
        try {
          const chatMeta = JSON.parse(fs.readFileSync(chatFilePath(payload.chatId || ''), 'utf8'));
          if (chatMeta && chatMeta.groupMode) gcfg = chatMeta;
        } catch { gcfg = null; }
        if (gcfg) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          });
          let gFinished = false;
          const gSend = (obj) => { if (!gFinished) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
          const gHistory = (payload.messages || [])
            .filter((m) => m.role === 'user' || m.role === 'assistant')
            .map((m) => ({ role: m.role, content: String(m.content || '') }));
          const gLastUser = [...gHistory].reverse().find((m) => m.role === 'user');
          const gInput = gLastUser ? gLastUser.content : String(payload.input || '');
          try {
            const gOut = await groupRuntime.groupTurn(
              { ...gcfg, sessionModel: gcfg.model || null },
              payload.chatId || '', gInput, gHistory.slice(0, -1), gSend,
            );
            gSend({ type: 'done', content: gOut.content });
          } catch (e) {
            console.error('[group] 本轮失败:', e.message);
            gSend({ type: 'error', error: '群聊生成失败: ' + e.message });
          }
          gFinished = true;
          res.end();
          return true;
        }
      }

      // 规范化历史：Anthropic 要求 user/assistant 交替、首条为 user
      // 开局提示词保底（2026-08-20）：首条 user 消息若为长文本（≥300 字，如开局注入/长提示词），
      // 移入 system 常驻、不参与历史截断——长对话后设定仍在；历史上限 300 条（v4 1M 窗口，预算由 maxContext 兜底）
      const rawHistory = (payload.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
      const firstMsg = rawHistory[0] || null;
      const pinFirst = !!(firstMsg && firstMsg.role === 'user' && String(firstMsg.content || '').trim().length >= OPENING_PIN_MIN_CHARS);
      const history = rawHistory.slice(pinFirst ? 1 : 0).slice(-300);
      let merged = [];
      for (const m of history) {
        const last = merged[merged.length - 1];
        if (last && last.role === m.role) last.content += '\n' + m.content;
        else merged.push({ role: m.role, content: m.content });
      }
      if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '（开场）' });

      // system：世界设定（用户自填：世界/角色卡/规则 三段）+ 界面操作覆盖 + 当前情绪
      let system = buildSystemPrompt({
        world: payload.worldSetting || '',
        chars: payload.charsSetting || '',
        rules: payload.rulesSetting || '',
        extra: payload.extra || '',
      }, payload.chatId || '');
      const op = opInject(payload.chatId || '');
      if (op) system += '\n\n---\n\n' + op;
      const emo = emotionInject(payload.chatId || '');
      if (emo) system += '\n\n---\n\n' + emo;
      // 剧情记忆注入（场景、角色、关系）
      const storyMemory = buildStoryMemory(payload.chatId || '');
      if (storyMemory) system += '\n\n---\n\n' + storyMemory;
      // 向量语义召回（默认关闭）：用本轮用户输入做 query，从索引里召回语义相关的旧剧情。
      // 补足「关键词检索搜不到近义表达」的缺口（如问「那次告白」能召回「表白/心意」相关段落）。
      // 失败/未建索引/未开开关 → 静默跳过，不影响正常对话。
      if (State.vecConfig.autoInject) {
        try {
          const lastUser = [...(payload.messages || [])].reverse().find(m => m.role === 'user');
          const q = lastUser ? String(lastUser.content || '').slice(0, 500) : '';
          if (q.trim()) {
            const vr = await vecSearch(payload.chatId || '', q, State.vecConfig.injectTopK || 4, null);
            if (vr.ok && vr.hits && vr.hits.length) {
              const minScore = Number.isFinite(State.vecConfig.minScore) ? State.vecConfig.minScore : 0.35;
              const kept = vr.hits.filter(h => h.score >= minScore);
              if (kept.length) {
                const kindLabel = { event: '事件', msg: '对话', summary: '早期摘要' };
                const lines = kept.map(h => `· [${kindLabel[h.kind] || h.kind}｜相关度 ${h.score.toFixed(2)}] ${String(h.text).replace(/\s+/g, ' ').slice(0, 300)}`);
                system += `\n\n---\n\n## 🔍 语义召回的相关旧剧情（按与当前话题的相关度，仅供回忆参考）\n${lines.join('\n')}`;
              }
            }
          }
        } catch (e) { /* 向量召回失败不影响对话 */ }
      }
      // 开局提示词保底：首条长消息原文注入 system（每轮都在，不参与 maxContext 裁剪/自动压缩）
      if (pinFirst) {
        system += '\n\n---\n\n## 会话开局提示词（首条消息原文，每轮保底注入；与「会话常驻设定」冲突时以常驻设定为准）\n' + String(firstMsg.content).trim();
      }
      // agent 助手（默认关闭）：注入禁忌（全局+角色级）、认知包可知段与本轮计划。
      // 开关关 → agentAugmentSystem 原样返回、runAgentPlan 返回空 ⇒ 本轮 system 与未移植前逐字节一致。
      const agentCid = payload.chatId || '';
      const agentOn = agentModeOn(agentCid);
      let agentPlanText = '';
      if (agentOn) {
        try {
          const lastUserMsg = [...(payload.messages || [])].reverse().find((m) => m.role === 'user');
          agentPlanText = await runAgentPlan(agentCid, String((lastUserMsg && lastUserMsg.content) || '').slice(0, 2000));
        } catch (e) { console.log('[agent] 计划轮异常（已回落）: ' + e.message); }
      }
      system = agentAugmentSystem(system, agentCid);
      if (agentPlanText) {
        const revNote = agentTools.revAnnotation(agentTools.revOnly(agentCid).rev, false);
        system += '\n\n---\n\n' + agentPlanLib.renderPlanBlock(agentPlanText, { revNote });
      }
      // 上一轮记账不合格 → 本轮 system 底部回传（T-009 的「下一轮提醒」；开关关时不读不写）
      if (agentOn) {
        try {
          const turns = readTurns(agentCid);
          const lastTurn = turns.length ? turns[turns.length - 1] : null;
          const fb = lastTurn && lastTurn._tagfail ? agentValidate.tagFailFeedback(lastTurn._tagfail) : '';
          if (fb) system += '\n\n---\n\n' + fb;
        } catch (e) { /* 回传失败不影响对话 */ }
      }
      // 标签生成最后重申：pinFirst 之后再次落底（近因效应），防止开局提示词挤掉记账指令（2026-08-30 修复）
      system += '\n\n---\n\n' + turnTagPrompt;
      // 调试：记录本轮 system prompt（落盘 data/prompts/）
      await recordPrompt(payload.chatId || '', system, merged.length);

      // 上下文预算裁剪：system + 历史 ≤ maxContext（0 = 不裁剪）；从最旧消息开始丢弃，至少保留 1 条
      if (State.endpoint.maxContext && State.endpoint.maxContext > 0) {
        const est = (s) => Math.ceil((s || '').length * 0.67);   // 中文为主近似 token
        const sysTok = est(system);
        let kept = merged.slice();
        while (kept.length > 1 && (sysTok + kept.reduce((a, m) => a + est(m.content), 0)) > State.endpoint.maxContext) {
          kept.shift();
        }
        if (!kept.length || kept[0].role !== 'user') kept.unshift({ role: 'user', content: '（开场）' });
        merged = kept;
      }

      // 自动压缩总结：历史过长 → 最旧部分压缩为摘要（缓存，不重复调用）
      let summaryNote = null;
      if (State.endpoint.autoSummary !== false && merged.length > 6) {
        const histChars = merged.reduce((a, m) => a + (m.content || '').length, 0);
        const threshold = State.endpoint.autoSummaryThreshold || 12000;
        if (histChars > threshold) {
          const compressCount = Math.max(2, Math.floor(merged.length / 2));   // 压缩最旧一半
          const oldPart = merged.slice(0, compressCount);
          const sumDir = path.join(DATA_DIR, 'summaries');
          const sumFile = path.join(sumDir, `${sanitizeId(payload.chatId)}.json`);
          let cached = null;
          try { cached = JSON.parse(fs.readFileSync(sumFile, 'utf8')); } catch (e) { /* 无缓存 */ }
          if (cached && cached.summary && cached.count >= compressCount) {
            merged = [{ role: 'user', content: `【历史摘要（${cached.count} 条旧消息）】\n${cached.summary}` }, ...merged.slice(compressCount)];
            summaryNote = `已自动压缩 ${compressCount} 条旧消息（缓存摘要）`;
          } else {
            try {
              const summary = await summarizeOldMessages(oldPart);
                            /* ⭐ S6（2026-09-06 批D1）：分层摘要——旧摘要+新摘要超阈值时再压成更高层（防摘要越写越长） */
              let finalSummary = summary;
              const oldSum = (cached && cached.summary) || '';
              const concat = oldSum ? oldSum + '\n\n' + summary : summary;
              if (oldSum && concat.length > 4000) {
                try {
                  const rr = await summarizeOldMessages([{ role: 'user', content: concat }]);
                  if (rr && typeof rr === 'string' && rr.length >= 50 && rr.length < concat.length * 0.8) finalSummary = rr;
                } catch (e) { /* 分层失败用拼接版 */ }
              }
merged = [{ role: 'user', content: `【历史摘要（${compressCount} 条旧消息）】\n${summary}` }, ...merged.slice(compressCount)];
              fs.mkdirSync(sumDir, { recursive: true });
              writeFileAtomicSync(sumFile, JSON.stringify({ summary: finalSummary, count: compressCount, at: new Date().toISOString() }), 'utf8');
              summaryNote = `已自动压缩 ${compressCount} 条旧消息`;
            } catch (e) { /* 摘要失败则跳过，保持原样 */ }
          }
          // 摘要后保证 user/assistant 交替
          const merged2 = [];
          for (const m of merged) {
            const last = merged2[merged2.length - 1];
            if (last && last.role === m.role) last.content += '\n' + m.content;
            else merged2.push({ ...m });
          }
          merged = merged2;
          if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '（开场）' });
        }
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let finished = false;
      let abortedByClient = false;
      const llmAbort = new AbortController();
      // 客户端断连（关页面/刷新/切会话）→ 立即中止 LLM 请求，不再烧 token
      res.on('close', () => { finished = true; abortedByClient = true; llmAbort.abort(); });
      // SSE 心跳（Task8）：15s 无事件时发 ping 保活连接，防代理/防火墙/浏览器超时掐断流
      const pingInterval = setInterval(() => {
        if (!finished) res.write('data: {"type":"ping"}\n\n');
      }, 15000);
      let acc = '';
      let firstTokenAt = 0;
      const t0 = Date.now();
      const meta = {};
      const send = (obj) => { if (!finished) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
      if (summaryNote) send({ type: 'summarized', note: summaryNote });
      // 工具桥：联网搜索（独立开关，会话内持久）
      let toolTrace = null;
      const enabledNames = toolsEnabled(payload.chatId);
      // 开关：联网工具按用户勾选；agent 助手开着时，另把 4 具只读工具一并下发（否则它们到不了模型）
      if (enabledNames.length || (agentOn && agentTools.DEFS.length)) {
        try {
          const lastU = merged[merged.length - 1];
          const direct = (lastU && lastU.role === 'user' ? await bridgeDirectTool(lastU.content) : []).filter((d) => enabledNames.includes(d.name));
          if (direct.length) {
            const parts2 = [];
            for (const d of direct) {
              const out = await executeBridgeTool(d.name, d.input, payload.chatId || '');
              parts2.push('[工具 ' + d.name + ']\n' + out);
              toolTrace = [...(toolTrace || []), { name: d.name, input: d.input, resultHead: out.slice(0, 120) }];
            }
            merged = merged.slice(0, -1).concat([{ role: 'user', content: lastU.content + '\n\n【工具结果】\n' + parts2.join('\n\n') }]);
            send({ type: 'tools', trace: toolTrace.map((t) => t.name + '(' + JSON.stringify(t.input).slice(0, 60) + ')') });
          } else {
            const tr = await runBridgeToolLoop(merged, system, enabledNames, payload.chatId || '');
            merged = tr.messages;
            toolTrace = tr.trace;
            if (toolTrace && toolTrace.length) send({ type: 'tools', trace: toolTrace.map((t) => t.name + '(' + JSON.stringify(t.input).slice(0, 60) + ')') });
          }
        } catch (e) { console.error('[bridge] 工具回合失败:', e.message); }
      }
      // 图片处理（M7 升级：视觉模型 → 图片以多模态格式进 LLM；非视觉模型 → 降级占位符）
      // 视觉模型判定：模型名含 vision（如 deepseek-v4-flash-vision-exp）
      const isVision = /vision/i.test(State.endpoint.model || '');
      const IMG_RE = /!\[[^\]]*\]\((data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+))\)/g;
      merged = merged.map((m) => {
        const text = String(m.content || '');
        if (!isVision) return { ...m, content: text.replace(IMG_RE, '[图片]') };
        // 视觉模型：单条消息内图文混合 → content 数组（openai 格式）；anthropic 走 messages 转换
        if (!IMG_RE.test(text)) return m;
        IMG_RE.lastIndex = 0;
        const parts = [];
        let last = 0, mm;
        while ((mm = IMG_RE.exec(text)) !== null) {
          if (mm.index > last) parts.push({ type: 'text', text: text.slice(last, mm.index) });
          parts.push({ type: 'image_url', image_url: { url: mm[1] } });
          last = mm.index + mm[0].length;
        }
        if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
        // 仅当整条消息恰为单段文本时才折叠为字符串；含图一律保留数组（单图无文字时 parts=[image_url]，不能取 .text）
        return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
      });
      try {
        await callLLM(merged, system, (text) => {
          if (!firstTokenAt) firstTokenAt = Date.now();
          acc += text;
          send({ type: 'delta', text });
        }, (m) => Object.assign(meta, m), (t) => send({ type: 'thinking', text: t }), llmAbort.signal);
        // 会话统计（按当前模型分桶）
        const b = bucket(State.endpoint.model);
        b.turns += 1;
        b.calls += 1;
        b.llmMs += Date.now() - t0;
        if (firstTokenAt) { b.firstTokenSum += firstTokenAt - t0; b.firstTokenN += 1; }
        const uIn = meta.usageIn || {};
        const uOut = meta.usageOut || {};
        const inTok = uIn.input_tokens || uIn.prompt_tokens || 0;
        const cacheRead = uIn.cache_read_input_tokens || uIn.prompt_cache_hit_tokens || 0;
        // 注意：input_tokens/prompt_tokens 已包含缓存读写与缓存创建部分（DeepSeek/Anthropic 同），
        // 不再叠加 cacheRead/cacheCreate，否则费用与命中率被系统性高估/压低
        b.tokensIn += inTok;
        b.tokensOut += uOut.output_tokens || uOut.completion_tokens || 0;
        b.cacheRead += cacheRead;
        b.cacheMiss += Math.max(0, inTok - cacheRead);
        // 每日费用记账（Task6）：按调用完成日期分桶（含分模型明细），供 /api/stats 每日费用仪表盘
        const nowD = new Date();
        const dk = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;   // 本地日期（避免 UTC 跨日错记）
        if (!stats.daily) stats.daily = {};
        const dd = stats.daily[dk] = stats.daily[dk] || { calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheMiss: 0, models: {} };
        dd.calls += 1;
        dd.tokensIn += inTok;
        dd.tokensOut += uOut.output_tokens || uOut.completion_tokens || 0;
        dd.cacheRead += cacheRead;
        dd.cacheMiss += Math.max(0, inTok - cacheRead);
        const dm = dd.models[State.endpoint.model] = dd.models[State.endpoint.model] || { calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheMiss: 0 };
        dm.calls += 1;
        dm.tokensIn += inTok;
        dm.tokensOut += uOut.output_tokens || uOut.completion_tokens || 0;
        dm.cacheRead += cacheRead;
        dm.cacheMiss += Math.max(0, inTok - cacheRead);
        // 本对话统计另计（完整桶；累计口径在 /api/stats 的 current/total 汇总）
        const cid = payload.chatId ? sanitizeId(payload.chatId) : '';
        if (cid) {
          let cb = stats.byChat[cid];
          if (!cb || cb.turns == null) cb = stats.byChat[cid] = Object.assign(emptyBucket(), cb || {});
          cb.turns += 1;
          cb.calls += 1;
          cb.llmMs += Date.now() - t0;
          if (firstTokenAt) { cb.firstTokenSum += firstTokenAt - t0; cb.firstTokenN += 1; }
          cb.tokensIn += inTok;
          cb.tokensOut += uOut.output_tokens || uOut.completion_tokens || 0;
          cb.cacheRead += cacheRead;
          cb.cacheMiss += Math.max(0, inTok - cacheRead);
        }
        await saveStats();
        // agent 打回重试（T-010，默认关闭）：本轮回复的记账标签不合格 → 就地补一次，把终稿 replace 给前端。
        // 只打回一次；失败/超时 → 静默沿用原稿（正文已经流式发出，不能因此报错）。
        if (agentOn && acc && !abortedByClient) {
          try {
            const v1 = agentValidate.validateTurnTags(acc);
            if (!v1.ok) {
              const t1 = Date.now();
              const rr = await agentRetryCall(merged.concat([{ role: 'assistant', content: acc }, { role: 'user', content: agentValidate.retryInstruction(v1) }]), State.endpoint.maxTokens || 1200);
              const acc2 = String((rr && rr.text) || '').trim();
              const v2 = acc2 ? agentValidate.validateTurnTags(acc2) : { ok: false, missing: ['重试无输出'] };
              agentBudgetLib.addAgentCall(agentTokenBucket(), 'retry', 0, acc2.length, Date.now() - t1);
              if (acc2 && v2.ok) { acc = acc2; send({ type: 'replace', content: acc2 }); console.log('[agent] 打回重试成功（' + (Date.now() - t1) + 'ms）'); }
              else console.log('[agent] 打回重试未通过：' + (v2.reason || v2.missing.join('、')));
            }
          } catch (e) { console.log('[agent] 打回重试失败（沿用原稿）: ' + e.message); }
        }
        // seq 校验：仅接受正整数，防客户端伪造污染回合记录
        const seqNum = Number(payload.seq);
        await appendTurnRecord(acc, payload.chatId, Number.isFinite(seqNum) && seqNum > 0 ? seqNum : undefined);  // 剧情记忆：按会话自动记账（带消息序号）
        if (toolTrace && toolTrace.length) appendOpRecord(payload.chatId, '工具调用', toolTrace.map((t) => t.name + ':' + String(t.input.query || '').slice(0, 40)).join('；'));
        send({ type: 'done' });
        // agent 生成后自检（T-011，默认关闭）：只报不写；结果随 SSE 旁路回传，由前端提示
        if (agentOn && acc && !abortedByClient) {
          try {
            const note = await agentSelfCheckFor(payload.chatId || '', acc, { stateText: '' });
            if (note) send({ type: 'selfcheck', note });
          } catch (e) { /* 只报不写，失败静默 */ }
        }
      } catch (e) {
        if (abortedByClient || llmAbort.signal.aborted) {
          // 客户端断连中止：静默收尾（不追加回合记录、不发 error）
        } else {
          // 详细错误只打日志；回传精简文案，防端点错误体回显敏感信息（L4）
          console.error('[chat] LLM 调用失败:', e && e.message || e);
          const brief = String((e && e.message) || e).slice(0, 120);
          send({ type: 'error', error: brief.includes('401') || brief.includes('403') || brief.includes('429') || brief.includes('超时') || brief.includes('timeout') ? brief : 'LLM 调用失败，详见服务器日志' });
        }
      } finally {
        clearInterval(pingInterval);   // 心跳随会话结束停止（Task8）
        finished = true;
        res.end();
      }
      return true
    }
  return false;
}
async function h_api_fork_turns(req, res, url, p) {
  const sendJson = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    const bodyRaw = await readBody(req);
    let body = {};
    try { body = JSON.parse(bodyRaw || '{}'); } catch (e) { body = {}; }
    // ⚠️ 必须校验「原始入参」而不是 sanitizeId 的返回值：sanitizeId('') 会回退成 'default'，
    //   只校验返回值会让空 chatId 通过，进而读写到名为 default 的会话（落盘到 default.jsonl）。
    const rawFrom = String(body.fromChatId || '').trim();
    const rawTo = String(body.toChatId || '').trim();
    if (!rawFrom || !rawTo) { sendJson({ ok: false, error: '缺少 fromChatId/toChatId' }, 400); return true; }
    const from = sanitizeId(rawFrom);
    const to = sanitizeId(rawTo);
    // 非法字符被全部剥掉后 sanitizeId 会给出 'default'——那不是用户指定的会话，一律拒
    if (from !== rawFrom || to !== rawTo) { sendJson({ ok: false, error: '会话 id 含非法字符（仅允许字母/数字/_/-，最长 60）' }, 400); return true; }
    const upToSeq = Number(body.upToSeq || 0);
    if (from === to) { sendJson({ ok: false, error: '源会话与目标会话相同，已拒绝（防自我覆盖）' }, 400); return true; }
    const recs = readTurns(from).filter((r) => (r.seq == null || Number(r.seq) <= upToSeq));
    if (!recs.length) { sendJson({ ok: true, copied: 0, note: '无回合记录可复制' }); return true; }
    const lines = recs.map((r) => JSON.stringify(r));
    writeFileAtomicSync(turnsFile(to), lines.join('\n') + '\n');
    sendJson({ ok: true, copied: recs.length, note: `已复制 ${recs.length} 条回合记录` });
  } catch (e) {
    sendJson({ ok: false, error: e.message }, 500);
  }
  return true;
}
async function h_api_last_chat(req, res, url, p) {
  if (p === '/api/last-chat' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ chatId: readLastChat() }));
    return true;
  }
  return false;
}

module.exports = { h_api_chat_74, h_api_fork_turns, h_api_last_chat };
