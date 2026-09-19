// lib/agent/taboo.js —— 禁忌库 + 修正流
// ⚠️ 依赖倒置：本模块**不 require server.js**；读写由 server.js 经 newTabooStore(io) 注入。
// 🔴 四条纪律（3.10.5，写死在本文件里）：
// ① 用户是唯一裁判：`add()` 一律落 `pending`；**只有 `confirm(id)` 能把条目置 `active`**（唯一入库路径）。
// ② scope 隔离：角色级只进该角色的强制段，**不得污染全局段/其它角色**。
// ③ 可撤销/过期：`active` | `resolved` 两态；**只有 `active` 注入**（`pending`/`resolved` 都不注入）。
// ④ 类型③不自动改上游：修正流只产出 `[定性]`+`[禁忌草案]`（治标）+「需修上游」提示（治本上报），**不写设定库**。
// 🔴 本模块**零设定库写入**（没有 fs 直写、没有设定库路径）。
// 🔴 字段契约：结构见 `灵感/记忆条目结构_20260918.md`（MG-01）——本文件字段是它的**子集**，
// 共同字段一个不少、语义不变；本批用 pending/active/resolved 三态，`dangling` 留给 MG-04。
'use strict';

const RULE_MAX = 120; // rule 一句话上限（MG-01 闸门「可执行性」判据）
const PATTERN_MAX = 200;
const STATUSES = ['pending', 'active', 'resolved'];
const ROOT_CAUSES = ['表述偏差', '设定偏差', '上游数据错', '风格偏差'];

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const uuid4 = () => Math.random().toString(36).slice(2, 6);
const newId = (d) => {
 const dt = d || new Date();
 const ymd = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
 return `mem_${ymd}_${uuid4()}`;
};

/**
 * 禁忌库存取。io = { readJSON(), writeJSON(obj), sanitizeId? }
 * · readJSON() → 返回 `{entries:[...]}`（文件不存在/损坏 → 空结构，且**不静默覆盖**：调用方 decide）
 * · writeJSON(o) → 无 BOM、LF 写回
 */
function newTabooStore(io) {
 const read = () => {
 let o = null;
 try { o = io.readJSON(); } catch (e) { o = null; }
 if (!o || typeof o !== 'object' || !Array.isArray(o.entries)) return { entries: [] };
 return { entries: o.entries.filter((e) => e && typeof e === 'object' && e.id) };
 };
 const write = (o) => io.writeJSON({ entries: o.entries });

 function list(status) {
 const all = read().entries;
 if (!status) return all;
 const want = String(status).split(',').map((s) => s.trim()).filter(Boolean);
 return want.length ? all.filter((e) => want.includes(e.status)) : all;
 }
 /** 只读：active 条目中，全局的 + 该角色的（用；不含 pending/resolved —— 纪律③） */
 function forRole(role) {
 const r = String(role == null ? '' : role);
 return read().entries.filter((e) => e.status === 'active'
 && (e.scope === 'global' || (e.scope === 'character' && String(e.role || '') === r)));
 }
 /** 只读：按作用域分组（全局一组、各角色各一组）——注入端用；**全局项不进角色组**（防重复注入） */
 function groupActive() {
 const act = read().entries.filter((e) => e.status === 'active');
 const g = { global: [], byRole: {} };
 for (const e of act) {
 if (e.scope === 'global') { g.global.push(e); continue; }
 const r = String(e.role || '').trim();
 if (!r) continue; // 角色级但缺 role → 不入库注入（可执行性不足）
 if (!g.byRole[r]) g.byRole[r] = [];
 g.byRole[r].push(e);
 }
 return g;
 }
 /** 🔴 纪律①：新增一律 pending（本函数是**唯一**的创建路径，绝不置 active） */
 function add(entry) {
 const e = entry && typeof entry === 'object' ? entry : {};
 const scope = e.scope === 'global' ? 'global' : 'character';
 const row = {
 id: e.id && String(e.id).trim() ? String(e.id) : newId(new Date()),
 kind: 'taboo',
 scope,
 role: scope === 'character' ? clip(e.role, 40) : '',
 pattern: clip(e.pattern, PATTERN_MAX),
 rule: clip(e.rule, RULE_MAX),
 rootCause: ROOT_CAUSES.includes(e.rootCause) ? e.rootCause : '表述偏差',
 source: {
 type: ['meta', 'selfcheck', 'manual'].includes(e.source && e.source.type) ? e.source.type : 'manual',
 chatId: clip(e.source && e.source.chatId, 60),
 seq: Number.isFinite(Number(e.source && e.source.seq)) ? Number(e.source.seq) : null,
 at: String((e.source && e.source.at) || new Date().toISOString()),
 },
 status: 'pending', // 🔴 纪律①（不可由调用方更改）
 life: { hits: 0, createdAt: new Date().toISOString(), confirmedAt: null, confirmedBy: null },
 };
 const o = read();
 o.entries.push(row);
 write(o);
 return row;
 }
 /** 🔴 纪律①：`pending → active` 的**唯一**路径（前端「确认生效」按钮触发；带用户显式操作） */
 function confirm(id, by) {
 const o = read();
 const e = o.entries.find((x) => x.id === String(id));
 if (!e) return { ok: false, error: '找不到条目 ' + id };
 if (e.status !== 'pending') return { ok: false, error: `只有 pending 可确认（当前 ${e.status}）` };
 e.status = 'active';
 e.life = Object.assign({ hits: 0 }, e.life || {}, { confirmedAt: new Date().toISOString(), confirmedBy: by || 'user' });
 write(o);
 return { ok: true, entry: e };
 }
 /** 纪律③：可撤销/拒绝（pending（＝拒绝草案）|active → resolved；resolved 不再注入） */
 function resolve(id) {
 const o = read();
 const e = o.entries.find((x) => x.id === String(id));
 if (!e) return { ok: false, error: '找不到条目 ' + id };
 if (e.status === 'resolved') return { ok: false, error: '已是 resolved' };
 e.status = 'resolved';
 e.life = Object.assign({}, e.life || {}, { resolvedAt: new Date().toISOString() });
 write(o);
 return { ok: true, entry: e };
 }
 return { list, forRole, groupActive, add, confirm, resolve, read };
}

/** ：角色级 → **该角色的强制段**（作用域写在标题里，明确只对该角色生效） */
function renderRoleTaboos(entries, role) {
 const es = Array.isArray(entries) ? entries.filter(Boolean) : [];
 if (!es.length) return '';
 return [
 `【强制·禁忌】（角色：${role} · 仅对该角色生效，不得套用到其它角色）`,
 ...es.map((e) => `- ${e.rule}`),
 ].join('\n');
}

/** ：全局 → **所有 system 顶部** */
function renderGlobalTaboos(entries) {
 const es = Array.isArray(entries) ? entries.filter(Boolean) : [];
 if (!es.length) return '';
 return [
 '【强制·禁忌】（全局 · 对所有角色生效）',
 ...es.map((e) => `- ${e.rule}`),
 ].join('\n');
}

/** 注入清单用：所有需注入条目的**类别+条数**（不列条目名） */
function countInjectable(group) {
 const g = group || { global: [], byRole: {} };
 const roles = Object.keys(g.byRole || {});
 return { global: (g.global || []).length, roles: roles.length, byRole: roles.reduce((a, r) => a + g.byRole[r].length, 0) };
}

/** 修正流 system：agent 必须回三动作，且类型③必须标注「需修上游」且不得自动改 */
function buildFixPrompt() {
 return [
 '你是 Moonrabbit 的**纠错助手**。用户指出了刚才那段演绎的偏差。',
 '你要输出**三段**：修正方案 / 定性 / 禁忌草案。**不要扮演角色、不要重写整段正文。**',
 '',
 '【一、修正方案】一句话说清"下次该怎么演"（≤80 字）。',
 '【二、定性】必须给出四型之一：表述偏差 | 设定偏差 | 上游数据错 | 风格偏差（按下面的口径判断）。',
 ' · 表述偏差：把词/语气演进方向搞错了（如把中性旧称演成贬称）。',
 ' · 设定偏差：角色知道了不该知道的、或违反已定案设定。',
 ' · 上游数据错：**设定/世界书里的原文本身写错了**——只改正文永远会复发，必须修上游。',
 ' · 风格偏差：过于热情/话太多/语气不对，属轻量风格问题（不必记成硬禁忌）。',
 '【三、禁忌草案】给 pattern / rule / scope / role：',
 ' · rule＝一句话规则（≤120 字，要能照着执行）；pattern＝触发形态；',
 ' · scope＝character（默认，只约束某个角色）或 global（全局，慎用）；scope=character 时 role 必填。',
 '',
 '【硬纪律】',
 '- 🔴 **判定为「上游数据错」时必须写明「需修上游」**，并且**不得自行修改任何设定来源**——只上报。',
 '- 查不到/不确定就写不确定，**不得编造**。',
 '- 只输出下面三行格式，不要多余内容：',
 '[修正方案] …',
 '[定性] 类型X 名称（理由一句话）',
 '[禁忌草案] pattern=… | rule=… | scope=character|global | role=…',
 ].join('\n');
}

/** 修正流 user：偏差现象（用户的话 + 可选上下文） */
function buildFixUser(deviation, ctx) {
 const c = ctx && typeof ctx === 'object' ? ctx : {};
 const lines = [`【主人指出的偏差】\n${String(deviation == null ? '' : deviation).slice(0, 800)}`];
 if (c.role) lines.push(`【涉及角色】${c.role}`);
 if (c.excerpt) lines.push(`【相关正文片段】\n${String(c.excerpt).slice(0, 800)}`);
 lines.push('请按三段格式输出。');
 return lines.join('\n');
}

/** 解析三动作 → {plan, 定性:{type,typeName,reason}, draft:{pattern,rule,scope,role,rootCause}} */
function parseFix(raw) {
 const t = String(raw == null ? '' : raw).trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
 if (!t) return { ok: false, error: '纠错助手无输出' };
 const planM = t.match(/\[修正方案\]\s*([\s\S]*?)(?=\n\s*\[|$)/);
 const typeM = t.match(/\[定性\]\s*([\s\S]*?)(?=\n\s*\[|$)/);
 const draftM = t.match(/\[禁忌草案\]\s*([\s\S]*?)(?=\n\s*\[|$)/);
 if (!typeM && !draftM) return { ok: false, error: '输出不含 [定性]/[禁忌草案]' };
 const typeRaw = clip(typeM ? typeM[1] : '', 120);
 // ⚠️ 实测坑：模型常写「类型三」/「类型3」而不是「类型③」→ 只认圈号会解析成 0，
 // 导致 `needUpstream` 恒为 false（纪律④形同虚设）。故：圈号/阿拉伯数字/中文数字三收，
 // 再回落到按名称反查 ROOT_CAUSES。
 const typeNo = (typeRaw.match(/类型\s*([①②③④1-4一二三四])/) || [])[1] || '';
 const TYPE_NO = { '①': 1, '1': 1, '一': 1, '②': 2, '2': 2, '二': 2, '③': 3, '3': 3, '三': 3, '④': 4, '4': 4, '四': 4 };
 const NAME_BY_TYPE = { 1: '表述偏差', 2: '设定偏差', 3: '上游数据错', 4: '风格偏差' };
 const named = ROOT_CAUSES.find((n) => typeRaw.includes(n));
 let type = TYPE_NO[typeNo] || 0;
 if (!type && named) { const i = ROOT_CAUSES.indexOf(named); if (i >= 0) type = i + 1; }
 const typeName = named || NAME_BY_TYPE[type] || '表述偏差';
 const dRaw = draftM ? draftM[1] : '';
 const pick = (k) => { const m = dRaw.match(new RegExp(k + '\\s*[=＝:]\\s*([^|｜\\n]+)')); return m ? clip(m[1], 200) : ''; };
 const scope = /global/i.test(pick('scope')) ? 'global' : 'character';
 return {
 ok: true,
 plan: clip(planM ? planM[1] : '', 200),
 type, typeName,
 needUpstream: type === 3 || typeName === '上游数据错', // 🔴 纪律④：只上报，不改
 reason: typeRaw,
 draft: {
 pattern: pick('pattern'),
 rule: clip(pick('rule'), RULE_MAX),
 scope,
 role: scope === 'character' ? clip(pick('role'), 40) : '',
 rootCause: typeName,
 },
 };
}

module.exports = {
 RULE_MAX, PATTERN_MAX, STATUSES, ROOT_CAUSES,
 newTabooStore, renderRoleTaboos, renderGlobalTaboos, countInjectable,
 buildFixPrompt, buildFixUser, parseFix, newId,
};