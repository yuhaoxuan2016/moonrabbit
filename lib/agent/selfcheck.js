// lib/agent/selfcheck.js —— 生成后一致性自检 + 偏差分型（新增）
// 🔴 纪律：**只报不写**——不自动改正文、不自动落盘、不阻断；前端出「⚠️ 自查提示」由用户决定。
// ⚠️ 纯函数模块，不 require server.js；aux 调用与超时由 server.js 注入。
'use strict';

const CHECK_MAX_TOKENS = 900; // 关思考的小额预算（附录 C 红线：开思考须 ≥2048）
const CHECK_TIMEOUT_MS = 20000;
const CATEGORIES = ['称谓', '已定案口径', '在场', '物品', '时间线连续性'];

// 四型偏差（设计）＋ 各自修法；类型③ 铁律＝必须同时修上游，但**绝不自动改**
const DEVIATION_TYPES = {
 1: { key: '表述偏差', fix: '改写本轮表述即可（不动设定、不落盘）', auto: false },
 2: { key: '设定偏差', fix: '以设定来源为准修正本轮表述；若来源本身有歧义，上报不擅改', auto: false },
 3: { key: '上游数据错', fix: '🔴 必须同时修上游（世界书/角色档案/状态记录），否则修的是症状；**本工具只上报，生效权在用户**', auto: false },
 4: { key: '风格偏差', fix: '调整文风/篇幅（既有文风与输出格式不动）', auto: false },
};

/** 自检提示词：输入＝正文 + 记账候选 + 状态快照 + 已定案口径清单（本批来源见 server.js 注释） */
function buildCheckPrompt(ctx) {
 const cats = CATEGORIES.join('/');
 return [
 '你是 RP 演绎质量核对员。**只找问题，不改写、不续写、不评价文笔好坏。**',
 '核对维度（只这五类）：' + cats + '。',
 '判定依据只能来自下面给出的「状态快照」与「已定案口径」；依据不足的一律不要报（宁缺勿造）。',
 '每条可疑点给：维度、正文原文片段（≤40 字）、问题一句话、偏差类型编号（1 表述偏差／2 设定偏差／3 上游数据错／4 风格偏差）。',
 '⚠️ 类型 3 的判定标准：正文没错，但它依据的**上游资料本身**与设定来源自相矛盾——这时要说清是哪份上游资料。',
 '输出格式（严格）：每行一条 `维度|类型号|原文片段|问题`；没有问题就只输出一行 `OK`。不要输出别的内容。',
 ].join('\n');
}

function buildCheckUser(ctx) {
 return [
 '【本轮正文】\n' + String(ctx.content || '').slice(0, 4000),
 '【本轮记账候选】\n' + String(ctx.recBrief || '（无）').slice(0, 800),
 '【状态快照（节选）】\n' + String(ctx.stateText || '（无）').slice(0, 2500),
 '【已定案口径（节选）】\n' + String(ctx.canonText || '（无）').slice(0, 1500),
 ].join('\n\n');
}

/** 解析自检输出；任何不合规行直接丢弃（宁缺勿造），返回 {ok, issues[]} */
function parseCheckResult(text) {
 const t = String(text == null ? '' : text).trim();
 if (!t) return { ok: false, issues: [], error: '自检无输出' };
 if (/^OK[。.\s]*$/i.test(t)) return { ok: true, issues: [] };
 const issues = [];
 for (const raw of t.split('\n')) {
 const line = raw.replace(/^[-*\d.、\s]+/, '').trim();
 if (!line || line.toUpperCase() === 'OK') continue;
 const p = line.split('|');
 if (p.length < 4) continue; // 不合格式的行直接丢
 const cat = String(p[0]).trim().slice(0, 12);
 const typeNo = Number(String(p[1]).trim().replace(/^类型/, ''));
 const dt = DEVIATION_TYPES[typeNo];
 if (!dt) continue; // 类型号不认识也丢
 issues.push({
 cat,
 type: typeNo,
 typeName: dt.key,
 quote: String(p[2]).trim().slice(0, 60),
 problem: String(p[3]).trim().slice(0, 160),
 fix: dt.fix,
 autoFixable: false, // 🔴 一律 false：只报不写
 });
 if (issues.length >= 8) break; // 上限，防刷屏
 }
 return { ok: true, issues };
}

/** 序列化成给前端/日志看的短文本 */
function renderIssues(issues) {
 if (!issues || !issues.length) return '';
 return issues.map((i) => `· [${i.cat}｜类型${i.type} ${i.typeName}] “${i.quote}” — ${i.problem}`).join('\n');
}

module.exports = {
 CATEGORIES, DEVIATION_TYPES, CHECK_MAX_TOKENS, CHECK_TIMEOUT_MS,
 buildCheckPrompt, buildCheckUser, parseCheckResult, renderIssues,
};
