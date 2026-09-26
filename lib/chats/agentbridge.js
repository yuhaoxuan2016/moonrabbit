// lib/chats/agentbridge.js —— M-08·chats-agentbridge 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const agentTabooLib = require('../agent/taboo');
const agentCogPackLib = require('../agent/cogpack');
const agentInjectedLib = require('../agent/injected');
const agentToolsLib = require('../agent/tools');
const agentBudgetLib = require('../agent/budget');
const agentSelfCheck = require('../agent/selfcheck');
const agentPlanLib = require('../agent/plan');
const { BRIDGE_TOOL_LABELS } = require('../agent/bridge');
const { agentModeOn } = require('../agent/mode');
const { safeParse } = require('../core/io');
const { State } = require('../core/state');
const { createGroup } = require('../group');
const { agentTaboo, agentMeta, agentInjected, agentTokenBucket } = require('../http/handlers/agent');
const { auxCall, auxEnqueue, auxEffective, completeText } = require('../llm/main');
const { loadNpcProfile, listNpcProfiles } = require('../store/avatars');
const { noteInjectText } = require('../store/opstate');
const { scanWorldbooks } = require('../store/worldbooks');
const { sanitizeId } = require('../tools/misc');
const { readTurns } = require('../turns/store');
const { vecSearch } = require('../vec/index');

const agentTools = agentToolsLib.createTools({
  readTurns: (cid) => readTurns(cid),
  searchMemory: async (q, topK, cid) => {
    const id = sanitizeId(String(cid || ''));
    if (!id) return null;
    const r = await vecSearch(id, q, topK || 8, null);
    if (!r || !r.ok || !Array.isArray(r.hits) || !r.hits.length) return null;
    return { text: r.hits.map((h, i) => `${i + 1}. ${String(h.text || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') };
  },
  readSetting: readSettingEntries,
  injected: agentInjected,
});
const runAgentPlan = agentPlanLib.createPlanRunner({
  agentModeOn: (cid) => agentModeOn(cid),
  revOnly: (cid) => agentTools.revOnly(cid),
  toolNames: () => agentTools.NAMES,
  injected: agentInjected,
  revAnnotation: agentToolsLib.revAnnotation,
  auxCall: (sys, user, maxTokens, extra, onUsage) => auxCall(sys, user, maxTokens, extra, onUsage),
  onUsage: (u) => agentBudgetLib.addAgentUsage(agentTokenBucket(), u),
  onCall: (kind, inChars, outChars, ms) => agentBudgetLib.addAgentCall(agentTokenBucket(), kind, inChars, outChars, ms),
  endpointLabel: () => ((State.aux && State.aux.baseURL) ? 'aux' : 'main'),
  log: (m) => console.log(m),
});
async function agentRetryCall(messages, maxTokens) {
  const ep = State.endpoint;
  const mt = Math.max(256, Number(maxTokens) || 1200);
  const t0 = Date.now();
  if (ep.protocol === 'anthropic') {
    const sysMsgs = messages.filter((m) => m.role === 'system');
    const rest = messages.filter((m) => m.role !== 'system');
    const r = await fetch(`${ep.baseURL}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: ep.model, system: sysMsgs.map((m) => m.content).join('\n\n'), messages: rest, max_tokens: mt }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const out = (j.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('');
    return { text: out, ms: Date.now() - t0 };
  }
  const r = await fetch(`${ep.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
    body: JSON.stringify({ model: ep.model, messages, max_tokens: mt }),
    signal: AbortSignal.timeout(120000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return { text: out, ms: Date.now() - t0 };
}
async function agentSelfCheckFor(chatId, content, ctx) {
  try {
    const sys = agentSelfCheck.buildCheckPrompt(ctx || {});
    const user = agentSelfCheck.buildCheckUser({ content, ...(ctx || {}) });
    const raw = await Promise.race([
      auxCall(sys, user, agentSelfCheck.CHECK_MAX_TOKENS, { thinking: { type: 'disabled' } }, (u) => agentBudgetLib.addAgentUsage(agentTokenBucket(), u)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('自检超时')), agentSelfCheck.CHECK_TIMEOUT_MS)),
    ]);
    const pr = agentSelfCheck.parseCheckResult(raw);
    agentBudgetLib.addAgentCall(agentTokenBucket(), 'check', 0, String(raw || '').length, 0);
    return pr && pr.issues && pr.issues.length ? agentSelfCheck.renderIssues(pr.issues) : '';
  } catch (e) { console.log('[agent] 自检跳过: ' + e.message); return ''; }
}
function agentAugmentSystem(system, chatId) {
  const cid = String(chatId || '');
  if (!agentModeOn(cid)) return system;
  const blocks = [];
  let tabooGroup = null;
  try { tabooGroup = agentTaboo.groupActive(); } catch (e) { tabooGroup = null; }
  if (tabooGroup) {
    const g = agentTabooLib.renderGlobalTaboos(tabooGroup.global);
    if (g) blocks.push(g);
    for (const role of Object.keys(tabooGroup.byRole || {})) {
      const b = agentTabooLib.renderRoleTaboos(tabooGroup.byRole[role], role);
      if (b) blocks.push(b);
    }
  }
  const pack = agentCogPackFor(cid);
  const know = pack && pack.knowledge && pack.knowledge.length ? agentCogPackLib.renderKnowledge(pack) : '';
  if (know) blocks.push(know);
  try { agentInjectedLib.recordFromPromptBlocks(agentInjected, cid, [system].concat(blocks), {}); } catch (e) { /* 只统计，失败不阻断 */ }
  if (!blocks.length) return system;
  return blocks.join('\n\n---\n\n') + '\n\n---\n\n' + system;
}
function opInject(chatId) {
  const cid = sanitizeId(chatId);
  const lines = [];
  const noteText_ = noteInjectText(cid);   // 多槽位合并注入（Task15：非空槽全部拼入）
  if (noteText_) lines.push(`- 📌 会话常驻设定（用户保存，每轮必读，优先级最高；与「世界设定」/检索内容冲突时以此为准）：\n${noteText_}`);
  if (State.opState.views[cid]) lines.push(`- 当前视角覆盖：${State.opState.views[cid]}（用户已在界面切换视角；你必须以该角色的主观视角叙述——与设定中记录的视角冲突时，以本覆盖为准。严格遵守信息屏障：主场景角色无法感知副场景事件）`);
  if (State.opState.wardrobes[cid]) lines.push(`- 当日着装覆盖：${State.opState.wardrobes[cid]}（用户已在界面换装；以此为准，覆盖设定中的当日着装描述）`);
  if (State.opState.expands[cid]) lines.push('- 【扩写指令（已开启）】当用户发来简短指令（如「角色去厨房」「角色站起来」）时，你的任务是将其【扩写】为详细、生动的动作/场景/台词描写：用第三人称叙述该角色的行为（动作细节、表情、环境、心理），符合人设；扩写要连贯、有画面感、贴合当前场景；不要替其他角色做决定；扩写后可自然衔接台词。');
  if (State.opState.tools && Array.isArray(State.opState.tools[cid]) && State.opState.tools[cid].length) {
    const labels = State.opState.tools[cid].map((n) => BRIDGE_TOOL_LABELS[n] || n).join('、');
    lines.push('- 【工具桥（已开启：' + labels + '）】当用户明确要求「联网/搜索/查一下」或需要核实现实世界信息时，你必须调用 web_search 工具，不得跳过或编造；工具结果需在回复中标注来源（联网核实：…）。');
  }
  return lines.length ? `## ⚠️ 界面操作覆盖（优先级最高，冲突时以此为准）\n${lines.join('\n')}` : '';
}
async function executeBridgeTool(name, input, chatId) {
  // agent 只读工具（默认关闭；只有开关开时才放行——关掉即与未移植前一致）
  if (name !== 'web_search' && agentTools.handlers[name]) {
    if (!agentModeOn(chatId || '')) return '未知工具: ' + name;
    try {
      const res = await agentTools.handlers[name](input || {}, chatId || '');
      return agentTools.stringify(res);
    } catch (e) { return '工具异常: ' + (e && e.message || e); }
  }
  if (name !== 'web_search') return '未知工具: ' + name;
  const q = String(input.query || '').slice(0, 200);
  const toolDef = { name: 'web_search', description: 'Search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const msgs = [{ role: 'user', content: 'Perform a web search for the query: ' + q }];
  const seenUrls = new Set();
  // 自动跟随：模型可能"换个搜索再试"，最多 3 轮；走辅助端点（串行队列防 429）
  const doRound = (ep, msgs2) => {
    const headers = ep.protocol === 'openai'
      ? { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` }
      : { 'content-type': 'application/json', 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01' };
    const body = ep.protocol === 'openai'
      ? { model: ep.model, max_tokens: 1024, tools: toolsFor(ep, [toolDef]), messages: msgs2 }
      : { model: ep.model, max_tokens: 1024, thinking: { type: 'disabled' }, tools: toolsFor(ep, [toolDef]), messages: msgs2 };
    return fetch(`${ep.baseURL}${ep.protocol === 'openai' ? '/chat/completions' : '/messages'}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
  };
  const parseResp = (d) => {
    if (d.choices) {
      return { text: (d.choices[0]?.message?.content || '').trim(), toolCalls: (d.choices[0]?.message?.tool_calls || []) };
    }
    const blocks = d.content || [];
    const out = [];
    for (const b of blocks) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.web_search_result)) {
        for (const item of b.web_search_result) {
          if (seenUrls.has(item.url)) continue;
          seenUrls.add(item.url);
          out.push('- ' + (item.title || '') + '（' + (item.url || '') + '）');
        }
      }
      if (b.type === 'text' && Array.isArray(b.citations)) {
        for (const c of b.citations) {
          if (c.cited_text && !seenUrls.has(c.url)) {
            if (c.url) seenUrls.add(c.url);
            out.push('  [摘要] ' + String(c.cited_text).replace(/\s+/g, ' ').slice(0, 200));
          }
        }
      }
    }
    return { text: blocks.map((b) => b.text || '').join('').trim(), toolCalls: blocks.filter((b) => b.type === 'tool_use'), out };
  };
  for (let i = 0; i < 3; i++) {
    const useAux = !!auxEffective();
    // 2026-09-03 修复 M-1：原为未定义标识符 AUX（声明数=0）→ useAux 为真时必抛 ReferenceError
    const run = () => doRound(useAux ? auxEffective() : State.endpoint, msgs);
    let d;
    try {
      const r = await (useAux ? auxEnqueue(run) : run());
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
      d = await r.json();
    } catch (e) {
      if (useAux && State.aux.fallback) {
        const r = await doRound(State.endpoint, msgs);
        if (!r.ok) return '联网搜索失败 HTTP ' + r.status;
        d = await r.json();
      } else if (useAux) {
        return '联网搜索失败（辅助 API：' + e.message + '）';
      } else {
        return '联网搜索失败 HTTP: ' + e.message;
      }
    }
    const { text, toolCalls, out } = parseResp(d);
    if (out && out.length) return out.join('\n');
    if (text && text.trim() && !toolCalls.length) return text.slice(0, 1500);
    if (!toolCalls || !toolCalls.length) return '（搜索未返回结果）';
    if (d.choices) {
      msgs.push({ role: 'assistant', content: text || null, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: tc.function?.arguments } })) });
      const results = [];
      for (const tc of toolCalls) {
        results.push({ role: 'tool', tool_call_id: tc.id, content: '（继续搜索）' });
      }
      msgs.push(...results);
      continue;
    }
    const tu = toolCalls[0];
    msgs.push({ role: 'assistant', content: d.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '' }] });
  }
  return '（搜索多次未返回结果）';
}
async function bridgeDirectTool(lastUserText) {
  const t = String(lastUserText || '');
  const res = [];
  if (/联网|搜索|查一下|查新闻|核实/.test(t)) {
    // 剥掉所有前置触发词（含"一下"）
    let q = t.replace(/^(?:联网|搜索|查一下|查新闻|帮我|请|核实|查|一下)+[：:、\s]*/i, '').replace(/[？?].*$/, '').replace(/[。！!\s]+$/, '').slice(0, 120);
    if (q) res.push({ name: 'web_search', input: { query: q } });
  }
  return res;
}
async function runBridgeToolLoop(messages, system, enabledNames, chatId) {
  const enabledSet = new Set(enabledNames || []);
  // agent 只读工具（默认关闭）：开关开时随联网工具一起下发给模型；关掉即与未移植前完全一致
  const tools = BRIDGE_TOOLS.filter((t) => enabledSet.has(t.name))
    .concat((chatId && agentModeOn(chatId)) ? agentTools.DEFS : []);
  if (!tools.length) return { messages: messages.slice(), trace: [], finalText: '' };
  let msgs = messages.slice();
  const trace = [];
  // 工具回合走辅助端点（串行队列防 429）；未启用辅助端点时用主端点
  const doRound = (ep, msgs2) => {
    const headers = ep.protocol === 'openai'
      ? { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` }
      : { 'content-type': 'application/json', 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01' };
    const body = ep.protocol === 'openai'
      ? { model: ep.model, messages: [{ role: 'system', content: system }, ...msgs2], max_tokens: 1024, tools: toolsFor(ep, tools) }
      : { model: ep.model, system, max_tokens: 1024, thinking: { type: 'disabled' }, tools: toolsFor(ep, tools), messages: msgs2 };
    return fetch(`${ep.baseURL}${ep.protocol === 'openai' ? '/chat/completions' : '/messages'}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
    });
  };
  const parseBlocks = (d) => {
    if (d.choices) {
      const msg = d.choices[0]?.message || {};
      return {
        text: String(msg.content || '').trim(),
        toolUses: (msg.tool_calls || []).filter((tc) => tc.type === 'function').map((tc) => ({ id: tc.id, name: tc.function?.name || '', input: safeParse(tc.function?.arguments) })),
      };
    }
    const blocks = d.content || [];
    return {
      text: blocks.map((b) => b.text || '').join('').trim(),
      toolUses: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
    };
  };
  for (let round = 0; round < 4; round++) {
    const useAux = !!auxEffective();
    // 2026-09-03 修复 M-1：原为未定义标识符 AUX（声明数=0）→ useAux 为真时必抛 ReferenceError
    const run = () => doRound(useAux ? auxEffective() : State.endpoint, msgs);
    let d;
    try {
      const r = await (useAux ? auxEnqueue(run) : run());
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 120));
      d = await r.json();
    } catch (e) {
      if (useAux && State.aux.fallback) {
        const r = await doRound(State.endpoint, msgs);
        if (!r.ok) throw new Error('工具回合失败（主端点）HTTP ' + r.status + ': ' + (await r.text()).slice(0, 120));
        d = await r.json();
      } else {
        throw new Error('工具回合失败' + (useAux ? '（辅助 API，未回退）' : '') + ': ' + e.message);
      }
    }
    const { text, toolUses } = parseBlocks(d);
    if (!toolUses.length) return { messages: msgs, trace, finalText: text };
    if (d.choices) {
      const assistantMsg = d.choices[0].message;
      msgs = msgs.concat([{ role: 'assistant', content: assistantMsg.content || '', tool_calls: (assistantMsg.tool_calls || []).map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' } })) }]);
      const results = [];
      for (const tu of toolUses) {
        let resultText;
        if (!enabledSet.has(tu.name)) resultText = '工具不可用：' + tu.name + '（未在本会话开启）';
        else try { resultText = await executeBridgeTool(tu.name, tu.input, chatId); }
        catch (e) { resultText = '工具执行失败: ' + e.message; }
        trace.push({ name: tu.name, input: tu.input, resultHead: resultText.slice(0, 120) });
        results.push({ role: 'tool', tool_call_id: tu.id, content: String(resultText).slice(0, 5000) });
      }
      msgs = msgs.concat(results);
      continue;
    }
    msgs = msgs.concat([{ role: 'assistant', content: d.content }]);
    const results = [];
    for (const tu of toolUses) {
      let resultText;
      if (!enabledSet.has(tu.name)) resultText = '工具不可用：' + tu.name + '（未在本会话开启）';
      else try { resultText = await executeBridgeTool(tu.name, tu.input, chatId); }
      catch (e) { resultText = '工具执行失败: ' + e.message; }
      trace.push({ name: tu.name, input: tu.input, resultHead: resultText.slice(0, 120) });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(resultText).slice(0, 5000) });
    }
    msgs = msgs.concat([{ role: 'user', content: results }]);
  }
  return { messages: msgs, trace, finalText: '' };
}
const groupRuntime = createGroup({
  get endpoint() { return State.endpoint; },
  readTurns,
  scanLorebook: (history, lastMsg, chatId) => {
    try { return scanWorldbooks(history || [], lastMsg || '', State.endpoint.maxContext, chatId || '', {}); }
    catch { return { entries: [] }; }
  },
  completeText: (ep, sys, userText, maxTokens, extraBody) =>
    completeText(ep || State.endpoint, sys, userText, maxTokens, extraBody),
  // 角色档案（data/npc-profiles/*.json）：命中既有档案 → 注入设定并禁止改写
  lookupNpcProfile: (name) => {
    try {
      const hit = loadNpcProfile(name);
      if (hit) return hit;
      // 别名回退：模型可能用别名/简称称呼已建档角色
      const low = String(name || '').trim();
      for (const p of listNpcProfiles()) {
        if (Array.isArray(p.aliases) && p.aliases.includes(low)) return p;
      }
      return null;
    } catch { return null; }
  },
  // 用户本人不由 AI 代言（玩家身份名 + 通用自称）
  isUserRole: (name) => {
    const n = String(name || '').trim();
    if (!n) return false;
    if (['你', '我', '用户', '玩家'].includes(n)) return true;
    const persona = State.personas && State.personas[State.activePersona];
    return !!(persona && persona.name && persona.name === n);
  },
  log: (s) => console.log(s),
});
function readSettingEntries(source, query) {
  const q = String(query || '').trim().toLowerCase();
  const rows = [];
  if (source === 'lorebook') {
    for (const [id, e] of Object.entries(State.lorebookEntries || {})) {
      if (!e || typeof e !== 'object') continue;
      const kw = Array.isArray(e.keywords) ? e.keywords.join('、') : '';
      rows.push({ title: e.title || id, content: [kw, e.content || ''].filter(Boolean).join('｜') });
    }
  } else {
    for (const [bid, book] of Object.entries(State.worldbooks || {})) {
      const entries = (book && book.entries) || {};
      for (const [eid, e] of Object.entries(entries)) {
        if (!e || typeof e !== 'object') continue;
        const kw = Array.isArray(e.keys) ? e.keys.join('、') : (Array.isArray(e.keywords) ? e.keywords.join('、') : '');
        rows.push({ title: `${(book && book.name) || bid}／${e.name || e.title || eid}`, content: [kw, e.content || ''].filter(Boolean).join('｜') });
      }
    }
  }
  const all = rows.filter((r) => r.title || r.content);
  const hit = q ? all.filter((r) => (r.title + r.content).toLowerCase().includes(q)) : all;
  return { entries: hit, total: hit.length };
}
function agentCogPackFor(chatId) {
  try { return agentCogPackLib.buildCogPack(agentMeta.list(chatId, 200)); } catch (e) { return agentCogPackLib.newCogPack(); }
}
const BRIDGE_TOOLS = [
  { name: 'web_search', description: '联网搜索（仅当用户明确要求「联网/查一下/搜索」，或需要核实现实世界信息如新闻/歌曲/游戏/品牌时使用）。返回来源标题+链接+摘要。', input_schema: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } },
];
function toolsFor(ep, tools) {
  if (ep.protocol === 'openai') return (tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
  return tools;
}

module.exports = { agentTools, runAgentPlan, agentRetryCall, agentSelfCheckFor, agentAugmentSystem, opInject, executeBridgeTool, bridgeDirectTool, runBridgeToolLoop, groupRuntime, readSettingEntries, agentCogPackFor, BRIDGE_TOOLS, toolsFor };
