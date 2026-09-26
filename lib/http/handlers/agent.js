// lib/http/handlers/agent.js —— M-08·agent-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const agentModeLib = require('../../agent/mode');
const agentTabooLib = require('../../agent/taboo');
const agentMetaLib = require('../../agent/meta');
const agentCogPackLib = require('../../agent/cogpack');
const agentInjectedLib = require('../../agent/injected');
const agentBudgetLib = require('../../agent/budget');
const { agentModeOn } = require('../../agent/mode');
const { writeFileAtomicSync } = require('../../core/io');
const { DATA_DIR } = require('../../core/paths');
const { State } = require('../../core/state');
const { readBody } = require('../respond');
const { auxCall } = require('../../llm/main');
const { saveOpState } = require('../../store/opstate');
const { sanitizeId } = require('../../tools/misc');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const META_DIR = path.join(DATA_DIR, 'meta');
const TABOO_FILE = path.join(DATA_DIR, 'taboos.json');

async function h_api_agent(req, res, url, p) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); return true; };
  const readJsonBody = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch (e) { return null; } };

  if (p === '/api/agent-mode' && req.method === 'GET') return send(200, { ok: true, ...agentModeLib.agentModeView(State.settings, State.opState) });
  if (p === '/api/agent-mode' && req.method === 'POST') {
    const o = await readJsonBody();
    if (o === null) return send(400, { ok: false, error: 'body 不是 JSON' });
    try {
      const r = agentModeLib.applyAgentModeChange(o, {
        getSettings: () => State.settings,
        getOpState: () => State.opState,
        saveSettings: (s) => { State.settings = s; saveSettings(s); },
        saveOpState: () => saveOpState(),
        sanitizeId: (x) => sanitizeId(x),
      });
      return send(200, { ok: true, changed: r.changed, ...r.view });
    } catch (e) { return send(400, { ok: false, error: String(e && e.message || e) }); }
  }

  if (p === '/api/meta' && req.method === 'GET') {
    const rawCid = String(url.searchParams.get('chatId') || '').trim();
    if (!rawCid) return send(400, { ok: false, error: '缺少 chatId' });
    const chatId = sanitizeId(rawCid);
    if (chatId !== rawCid) return send(400, { ok: false, error: '会话 id 含非法字符' });
    const entries = agentMeta.list(chatId, 50);
    let cp = { knowledge: 0, direction: 0 }, cands = [];
    try {
      const pack = agentCogPackLib.buildCogPack(agentMeta.list(chatId, 0));
      cp = { knowledge: pack.knowledge.length, direction: pack.direction.length };
      cands = pack.candidates;
    } catch (e) { /* 预览失败不影响历史读取 */ }
    return send(200, { ok: true, entries, cogpack: cp, candidates: cands, count: agentMeta.count(chatId) });
  }
  if (p === '/api/meta' && req.method === 'POST') {
    const o = await readJsonBody();
    if (o === null) return send(400, { ok: false, error: 'body 不是 JSON' });
    const rawCid = String(o.chatId || '').trim();
    const text = String(o.text || '').trim();
    if (!rawCid || !text) return send(400, { ok: false, error: '缺少 chatId/text' });
    const chatId = sanitizeId(rawCid);
    if (chatId !== rawCid) return send(400, { ok: false, error: '会话 id 含非法字符' });
    if (!agentModeOn(chatId)) return send(200, { ok: false, error: 'agent 未开启' });
    agentMeta.append(chatId, { role: 'user', raw: text.slice(0, 2000) });
    let cls = '', tag = '', summary = '', note = '';
    try {
      const raw = await auxCall(agentMetaLib.buildClassifyPrompt(), agentMetaLib.buildClassifyUser(text), agentMetaLib.CLASSIFY_MAX_TOKENS, { thinking: { type: 'disabled' } }, (u) => agentMetaLib.addMetaUsage(agentTokenBucket(), u));
      const pr = agentMetaLib.parseClassify(raw);
      if (pr.ok) { cls = pr.data.cls; tag = pr.data.tag; summary = pr.data.summary; note = pr.note || ''; }
      else note = pr.error || '分类失败';
    } catch (e) { note = '分类调用失败：' + e.message; }
    const entry = { role: 'agent', cls: cls || 'query', tag, summary: summary || text.slice(0, 200), srcRaw: text.slice(0, 600) };
    if (cls === 'query' && /查了|查什么|查过|工具|trace|注入/.test(text)) entry.trace = agentInjected.render(chatId);
    agentMeta.append(chatId, entry);
    // 修正流入口：纠错话（或前端显式 fix:true）→ 跑纠错助手；**只回显三动作，不自动入库**
    let fix = null;
    if (o.fix === true || (cls !== 'query' && /不对|错了|应该|别|不该|不要|偏差|纠正|重来|改一下|不是这样|写错/.test(text))) {
      try {
        const rawF = await auxCall(agentTabooLib.buildFixPrompt(), agentTabooLib.buildFixUser(text, {}), agentMetaLib.CLASSIFY_MAX_TOKENS, { thinking: { type: 'disabled' } }, (u) => agentMetaLib.addMetaUsage(agentTokenBucket(), u));
        const pf = agentTabooLib.parseFix(rawF);
        if (pf.ok) {
          fix = { plan: pf.plan, type: pf.type, typeName: pf.typeName, needUpstream: pf.needUpstream, reason: pf.reason, draft: pf.draft };
          if (pf.needUpstream) fix.upstreamNote = '⚠️ 定性为「上游数据错」：只上报「需修上游」，本系统不自动改设定来源';
          agentMeta.append(chatId, { role: 'agent', cls: 'fix', kind: 'fix', plan: pf.plan, typeName: pf.typeName, needUpstream: pf.needUpstream, draft: pf.draft });
        } else fix = { error: pf.error };
      } catch (e) { fix = { error: e.message }; }
    }
    let summarized = null;
    try { summarized = await agentMeta.summarizeIfNeeded(chatId, {}); } catch (e) { summarized = { ok: false, reason: e.message }; }
    return send(200, { ok: true, cls, tag, summary, note, fix, trace: entry.trace || '', summarized: summarized && summarized.summarized ? summarized : null });
  }

  if (p === '/api/taboos' && req.method === 'GET') {
    const st = String(url.searchParams.get('status') || '').trim();
    const all = agentTaboo.list('');
    const entries = st ? agentTaboo.list(st) : all;
    const cnt = (s) => all.filter((e) => e.status === s).length;
    return send(200, { ok: true, status: st || 'all', entries, counts: { pending: cnt('pending'), active: cnt('active'), resolved: cnt('resolved'), total: all.length } });
  }
  if (p === '/api/taboos' && req.method === 'POST') {
    const o = await readJsonBody();
    if (o === null) return send(400, { ok: false, error: 'body 不是 JSON' });
    const act = String(o.action || '');
    try {
      if (act === 'create') {
        if (!String(o.rule || '').trim()) return send(200, { ok: false, error: '缺少 rule（一句话规则）' });
        const row = agentTaboo.add({ scope: o.scope, role: o.role, pattern: o.pattern, rule: o.rule, rootCause: o.rootCause, source: o.source });
        return send(200, { ok: true, entry: row, note: '已入待确认队列（pending）——确认后才生效' });
      }
      // 🔴 唯一入库路径：只此一处调用 confirm（前端「✅ 确认生效」按钮触发）
      if (act === 'confirm') {
        const r = agentTaboo.confirm(o.id, 'user');
        return send(200, r.ok ? { ok: true, entry: r.entry } : { ok: false, error: r.error });
      }
      if (act === 'resolve') {
        const r = agentTaboo.resolve(o.id);
        return send(200, r.ok ? { ok: true, entry: r.entry } : { ok: false, error: r.error });
      }
      return send(200, { ok: false, error: '未知 action：' + act });
    } catch (e) { return send(500, { ok: false, error: e.message }); }
  }
  return false;
}
function saveSettings(s) { try { writeFileAtomicSync(SETTINGS_FILE, agentModeLib.serializeSettings(s), 'utf8'); } catch (e) { console.error('[settings.json] 写盘失败：' + e.message); } }
const agentTaboo = agentTabooLib.newTabooStore({
  readJSON: () => JSON.parse(fs.readFileSync(TABOO_FILE, 'utf8').replace(/^\uFEFF/, '')),
  writeJSON: (o) => writeFileAtomicSync(TABOO_FILE, JSON.stringify(o, null, 2), 'utf8'),
});
const agentMeta = agentMetaLib.createMetaStore({ fs, path, dir: META_DIR, sanitizeId: (x) => sanitizeId(x) });
const agentInjected = agentInjectedLib.createInjectedRecorder();
function agentTokenBucket() {
  if (!State.stats) State.stats = {};
  if (!State.stats.agentTokens) State.stats.agentTokens = agentBudgetLib.newAgentBucket();
  return State.stats.agentTokens;
}

module.exports = { h_api_agent, saveSettings, agentTaboo, agentMeta, agentInjected, agentTokenBucket, SETTINGS_FILE, META_DIR, TABOO_FILE };
