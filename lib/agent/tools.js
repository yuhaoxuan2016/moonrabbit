// lib/agent/tools.js —— 只读工具集 4 具 + 分轨；返回三态
// ⚠️ 依赖倒置：本模块**不 require server.js**。所有外部能力由 server.js 经 createTools(deps) 注入。
// 🔴 只读边界：只读「本会话回合记录」「用户自建的设定条目（设定触发器 / 世界书）」「本会话语义检索索引」；
//    不写任何文件、不联网、不提供未建索引或未配置的内容。
// 🔴 三态约定：handler 一律返回 { ok, data, note?, error?, text }
// · {ok:true, data:<非空>} → 正常
// · {ok:true, data:'', note:'无匹配'} → 明确「查过但没有」
// · {ok:false, error:'…'} → 失败（拒绝也算失败态，但文案区分「拒绝」与「查不到」）
// text ＝ 给模型看的字符串；executeBridgeTool() 出口只取 text。
'use strict';

const TIMELINE_MAX = 30;      // get_timeline 条数硬上限（防爆）
const READ_MAX_CHARS = 6000;  // read_setting 单次返回上限
const SETTING_MAX_ENTRIES = 12;
const SETTING_SOURCES = new Set(['lorebook', 'worldbook']);
const DISCIPLINE = '查不到就说查不到，不得据此编造设定。'; // 写死进每个 description

// ---------- 三态构造器 ----------
const okData = (text, data) => ({ ok: true, data: data === undefined ? text : data, text });
const noMatch = (text) => ({ ok: true, data: '', note: '无匹配', text });
const failed = (text, kind) => ({ ok: false, data: '', error: text, kind: kind || 'error', text });

/**
 * 把**旧链工具**（实现留在 server.js，返回字符串）的出口文本归类成三态，
 * 供过程可视化与「失败留痕」使用；**不改变它们返回给模型的原文**（零差异）。
 * 分类依据逐条来自 server.js 旧链里写死的字符串（见本文件测试的样本断言）。
 */
function classifyLegacyResult(name, text) {
  const t = String(text == null ? '' : text);
  const failHeads = { web_search: ['联网搜索失败'] };
  // ⚠️ 「（搜索未返回结果）／（搜索多次未返回结果）」＝**查过但没有**（空结果态），不是失败——
  // 模型据此才不会再重试；这条口径是三态可区分的关键。
  const emptyHeads = { web_search: ['（搜索未返回结果）', '（搜索多次未返回结果）'] };
  for (const h of (failHeads[name] || [])) if (t.startsWith(h)) return { ok: false, kind: 'error', text: t };
  for (const h of (emptyHeads[name] || [])) if (t.startsWith(h)) return { ok: true, data: '', note: '无匹配', text: t };
  if (!t.trim()) return { ok: true, data: '', note: '无匹配', text: t };
  return { ok: true, data: t, text: t };
}

/**
 * @param {Object} deps { readTurns, searchMemory, readSetting, injected }
 *   readTurns(chatId) → 回合记录数组
 *   searchMemory(query, topK) → { text } | null（本版向量检索；未建索引时由 server.js 抛错或回空）
 *   readSetting(source, query) → { entries: [{title, content}], total }（用户自建设定条目）
 *   injected → 注入清单记录器（injected.js 的 createInjectedRecorder() 产物）
 */
function createTools(deps) {
  const { readTurns, searchMemory, readSetting, injected } = deps;
  const cidOf = (input, chatId) => String((input && input.chatId) || chatId || '');

  const handlers = {
    /** 最近 N 条回合记录；N 上限写死 TIMELINE_MAX */
    async get_timeline(input, chatId) {
      const cid = cidOf(input, chatId);
      const want = Math.min(TIMELINE_MAX, Math.max(1, Number(input && input.limit) || 10));
      let turns = [];
      try { turns = (typeof readTurns === 'function' ? readTurns(cid) : []) || []; } catch (e) { return failed(`查不到（get_timeline）：读取回合记录失败 ${e.message}。${DISCIPLINE}`, 'error'); }
      if (!turns.length) return noMatch(`无匹配（get_timeline）：会话 ${cid || '(空)'} 没有回合记录。${DISCIPLINE}`);
      const tail = turns.slice(-want);
      const lines = tail.map((t) => {
        const ev = t.event ? `｜事件：${String(t.event).slice(0, 120)}` : '';
        const ch = Array.isArray(t.characters) && t.characters.length ? `｜在场：${t.characters.join('、')}` : '';
        return `- seq=${t.seq == null ? '?' : t.seq} ${t.story_time || ''}｜${t.location || ''}${ch}${ev}`;
      });
      return okData(`最近 ${tail.length} 条回合记录（上限 ${TIMELINE_MAX}，按时间正序）：\n${lines.join('\n')}`, tail.length);
    },

    /** 语义检索本会话旧剧情（走本版向量索引；未建索引时可读降级） */
    async search_memory(input, chatId) {
      const q = String((input && input.query) || '').trim();
      if (!q) return failed(`查不到（search_memory）：缺少 query。${DISCIPLINE}`, 'badinput');
      if (typeof searchMemory !== 'function') return failed('检索不可用（search_memory）：未接入检索函数。', 'error');
      try {
        const res = await searchMemory(q, 8, cidOf(input, chatId));
        if (!res || !res.text) return noMatch(`无匹配（search_memory）：本会话旧剧情里没检索到与「${q}」相关的内容（若尚未建索引，先在「剧情记忆 → 🔍 语义」里建立索引）。${DISCIPLINE}`);
        return okData(`【语义检索·本会话旧剧情】（按意思召回，非原话匹配）\n${String(res.text).slice(0, 4000)}`);
      } catch (e) {
        return failed(`查询失败（search_memory）：${e.message}（索引未建或 embedding 未配置时即为此态；不得据此编造设定）。`, 'unavailable');
      }
    },

    /** 只读用户自建的设定条目（设定触发器 / 世界书），按关键词过滤；不提供任何文件路径读写 */
    async read_setting(input) {
      const src = String((input && input.source) || '').trim().toLowerCase();
      const q = String((input && input.query) || '').trim();
      if (!SETTING_SOURCES.has(src)) return failed(`拒绝（read_setting）：source 只能是 lorebook 或 worldbook。${DISCIPLINE}`, 'denied');
      if (typeof readSetting !== 'function') return failed('设定读取不可用（read_setting）：未接入读取函数。', 'error');
      try {
        const r = readSetting(src, q) || {};
        const entries = Array.isArray(r.entries) ? r.entries.slice(0, SETTING_MAX_ENTRIES) : [];
        if (!entries.length) return noMatch(`无匹配（read_setting）：${src} 里没有${q ? `与「${q}」相关的` : ''}条目。${DISCIPLINE}`);
        const total = Number.isFinite(Number(r.total)) ? Number(r.total) : entries.length;
        const lines = entries.map((e) => `- ${String(e.title || '(未命名)').slice(0, 60)}：${String(e.content || '').replace(/\s+/g, ' ').slice(0, 300)}`);
        const head = `【设定条目·${src === 'lorebook' ? '设定触发器' : '世界书'}】共 ${total} 条${entries.length < total ? `，返回前 ${entries.length} 条` : ''}：`;
        let text = `${head}\n${lines.join('\n')}`;
        if (text.length > READ_MAX_CHARS) text = text.slice(0, READ_MAX_CHARS) + `\n…（已截断）`;
        return okData(text, entries.length);
      } catch (e) {
        return failed(`查不到（read_setting）：${e.message}。${DISCIPLINE}`, 'error');
      }
    },

    /** 本轮真实注入清单（只类别+条数）——「已预注入的不重复查」的执行前提 */
    async list_injected(input, chatId) {
      if (!injected) return failed('注入清单不可用（记录器未注入）。', 'error');
      const cid = cidOf(input, chatId);
      const store = injected.store || {};
      let key = cid;
      if (!store[cid]) {
        const alt = Object.keys(store);
        if (alt.length === 1) key = alt[0]; // 单会话调用（如探针）时回落，避免误报「无记录」
      }
      const items = injected.list(key);
      if (!items.length) return noMatch(`无匹配（list_injected）：会话 ${key || '(空)'} 本轮没有注入记录（可能尚未跑过一轮）。${DISCIPLINE}`);
      return okData(injected.render(key), items.length);
    },
  };

  /** 廉价取 rev（只数回合数）—— 计划注入前的漂移比对点用它 */
  function revOnly(chatId) {
    let turnCount = 0;
    try { turnCount = (typeof readTurns === 'function' ? readTurns(cidOf({}, chatId)) : [])?.length || 0; } catch (e) { turnCount = -1; }
    return { rev: String(turnCount), turnCount };
  }

  /** 模型可见字符串（三态里唯一被 API 消费的字段） */
  const stringify = (res) => String(res && typeof res === 'object' && 'text' in res ? res.text : (res == null ? '' : String(res)));

  const NAMES = ['get_timeline', 'search_memory', 'read_setting', 'list_injected'];
  const LABELS = { get_timeline: '读回合记录', search_memory: '检索旧剧情', read_setting: '读设定条目', list_injected: '看本轮已注入' };
  const DEFS = [
    { name: 'get_timeline', track: 'read', description: `读取本会话最近 N 条回合记录（剧情时间/地点/在场/事件），N 上限 ${TIMELINE_MAX}。用于连续性核对，不用于查设定。${DISCIPLINE}`, input_schema: { type: 'object', properties: { limit: { type: 'number', description: `返回条数（默认 10，上限 ${TIMELINE_MAX}）` }, chatId: { type: 'string' } }, required: [] } },
    { name: 'search_memory', track: 'read', description: `语义检索本会话的旧剧情（按**意思**召回，不是关键词匹配）。需要先在「剧情记忆 → 🔍 语义」里建立索引并配置 embedding 端点；未建索引时返回可读的失败态。${DISCIPLINE}`, input_schema: { type: 'object', properties: { query: { type: 'string', description: '检索关键词或近义表述' } }, required: ['query'] } },
    { name: 'read_setting', track: 'read', description: `按关键词读取**用户自建的设定条目**——source=lorebook（设定触发器）或 worldbook（世界书）。用于核对设定细节；只读、只返回条目内容，不涉及任何文件路径。${DISCIPLINE}`, input_schema: { type: 'object', properties: { source: { type: 'string', description: 'lorebook 或 worldbook' }, query: { type: 'string', description: '关键词（可省略＝按优先级取前若干条）' } }, required: ['source'] } },
    { name: 'list_injected', track: 'read', description: '查看本轮 system 已经注入了哪些**类别**及条数（不列条目名）。**先调本工具再决定是否深挖**——已注入的类别不要重复查询。', input_schema: { type: 'object', properties: {}, required: [] } },
  ];

  return { handlers, NAMES, LABELS, DEFS, stringify, revOnly, parseRev, isRevStale, revAnnotation, TIMELINE_MAX, SETTING_SOURCES, classifyLegacyResult };
}

/** 从快照文本/对象里取 rev（两种来源都认）；本版 rev ＝ 回合数 */
function parseRev(src) {
  if (src && typeof src === 'object') {
    if (typeof src.rev === 'string' || typeof src.rev === 'number') return String(src.rev);
    if (src.data && typeof src.data === 'object' && src.data.rev) return String(src.data.rev);
    if (typeof src.text === 'string') return parseRev(src.text);
  }
  const s = String(src == null ? '' : src);
  if (/^[0-9]+$/.test(s)) return s; // 裸 rev（revOnly / 存下来的快照）
  const m = s.match(/rev=([0-9]+)/);
  return m ? m[1] : null;
}

/** 漂移判定：rev 不等即视为快照可能过期（agent 轮与正文之间用户可能连发） */
function isRevStale(snapshotRev, liveRev) {
  const a = parseRev(snapshotRev), b = parseRev(liveRev);
  if (!a || !b) return true; // 任一侧取不到 rev → 保守判"过期"，让调用方重取
  return a !== b;
}

/** 计划文本里的过期标注（注入底部时用；不含时间戳，防前缀抖动） */
function revAnnotation(rev, stale) {
  const r = parseRev(rev);
  if (!r) return '';
  return `（回合快照 rev=${r}${stale ? '，可能已过期——正文前请以 get_timeline 复核' : '，本轮内有效'}）`;
}

module.exports = { createTools, classifyLegacyResult, parseRev, isRevStale, revAnnotation, TIMELINE_MAX, SETTING_SOURCES };
