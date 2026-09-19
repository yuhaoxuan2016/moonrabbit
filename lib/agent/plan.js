// lib/agent/plan.js —— aux 计划轮（提示词与产物清洗）
// ⚠️ 本模块不 require server.js；调用链（auxCall / 超时 / 回落）留在 server.js。
// 口径 （已拍板）：计划文本注入 system **底部**（变化段末尾、标签重申之前），不是设计正文说的顶部。
'use strict';

const PLAN_MAX_CHARS = 300; // 计划文本上限（任务卡写死）
const PLAN_TIMEOUT_MS = 15000; // 超时 15s → 静默回落单次调用
const PLAN_MAX_TOKENS = 1024; // 计划轮输出预算（关思考，见 server.js 调用处；若开思考须 ≥2048）

/** 给 aux 计划轮的 system（写死三条纪律，照 buildTurnTagPrompt 的紧凑风格） */
function buildPlanPrompt(ctx) {
 const tools = (ctx.toolNames || []).join(' / ') || '（本轮无可用工具）';
 return [
 `你是 Moonrabbit 的**规划器**。任务只有一个：为"接下来这一轮 RP 回复"列一份简短的核对与演出计划。`,
 `【硬纪律】`,
 `- **已预注入的信息不要重复查**：下面「本轮已注入」列出的类别（只给类别与条数，不给条目名）已经在 system 里，不要再为它们安排查询；需要细节才查。`,
 `- **库内检索放行，联网一律禁止**：可用工具只有 ${tools}，全部为只读；内部设定（本名/年龄/着装/关系/剧情）严禁联网。`,
 `- 只读工具查不到就写「查不到」，**不得安排编造**；不要为了显得严谨而堆查询。`,
 `【输出格式】`,
 `- 不超过 ${PLAN_MAX_CHARS} 字；3-6 条短行，每行以「- 」开头。`,
 `- 内容＝本轮要核对的事实点 + 要承接的剧情线 + 落点（场景/在场/情绪）。`,
 `- 🔴 **禁止输出任何时间戳、日期、序号随机量、问候语、自我解释**（这些文本会进提示词，抖动会作废前缀缓存）。`,
 `- 不要写正文台词，不要扮演角色，不要复述设定原文。`,
 ].join('\n');
}

/** 给 aux 的 user 消息：本轮用户输入 + 已注入清单 + 状态新鲜度 */
function buildPlanUser(ctx) {
 const lines = [];
 lines.push(`【本轮用户输入】\n${String(ctx.lastUserText || '').slice(0, 1200)}`);
 if (ctx.injectedText) lines.push(`【本轮已注入（类别+条数）】\n${ctx.injectedText}`);
 if (ctx.revNote) lines.push(`【状态快照】${ctx.revNote}`);
 lines.push('请输出本轮计划。');
 return lines.join('\n\n');
}

const TS_RE = /(20\d{2}[-/年][01]?\d[-/月][0-3]?\d|[01]?\d:[0-5]\d(:[0-5]\d)?|GMT|[A-Z][a-z]{2}\s\d{1,2}|Unix\s*时间|时间戳|timestamp)/g;

/** 清洗 aux 产物：去时间戳/随机量、限长、去围栏、压空行。返回 '' 表示不可用（→ 回落单次调用）。 */
function sanitizePlan(raw) {
 let t = String(raw == null ? '' : raw).trim();
 if (!t) return '';
 t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
 t = t.replace(TS_RE, ''); // 去时间戳/日期/时钟
 t = t.replace(/[ \t]{2,}/g, ' '); // 去完时间戳常留双空格 → 压成一个（防把无意义抖动带进提示词）
 const lines = t.split('\n').map((l) => l.replace(/\s+$/, '').trim())
 .filter((l) => l && !/^\s*$/.test(l))
 .map((l) => (/^[-*·]\s?/.test(l) ? '- ' + l.replace(/^[-*·]\s?/, '') : l));
 let out = lines.join('\n');
 if (out.length > PLAN_MAX_CHARS) out = out.slice(0, PLAN_MAX_CHARS).replace(/\n[^\n]*$/, '') + '\n- …（计划超长已截断）';
 return out.trim();
}

/** 注入 system 底部的计划块（含纪律句与 rev 标注） */
function renderPlanBlock(plan, opts) {
 const revNote = opts && opts.revNote ? ` ${opts.revNote}` : '';
 return `## 🤖 本轮演出计划（agent 预跑，仅供参照；不是剧情内容，不得在正文里提及"计划"本身）${revNote}\n${plan}\n\n【工具使用纪律（本轮）】已预注入的类别不要重复查；库内检索（read_setting / search_memory / get_state / get_timeline / list_injected）放行，**联网仍禁**。`;
}

/**
 * （搬迁版）：计划轮执行器。**调用链由 server.js 注入**（模块不 require server.js）。
 * 语义与搬迁前逐字一致：agent 开关关 → 直接返回 ''；失败/超时/空产物 → 打日志并返回 ''
 * （＝调用方静默回落单次调用，正文照常由主模型产出）。
 * @param {Object} deps
 * auxCall(sys, user, maxTokens, extraBody) → Promise<string>
 * revOnly(chatId) → {rev}; revAnnotation(rev, stale) → string
 * injected 注入清单记录器（render(chatId)）; agentModeOn(chatId) → boolean
 * toolNames string[]; endpointLabel() → string（如 'aux:deepseek-flash'）
 * onCall(kind, inChars, outChars, ms) 费用归口回调; log(...args)
 */
function createPlanRunner(deps) {
 const log = deps.log || (() => {});
 return async function runAgentPlan(chatId, lastUserText) {
 if (!deps.agentModeOn(chatId)) return '';
 const t0 = Date.now();
 try {
 const rev = deps.revOnly(chatId);
 // ⚠️ toolNames 允许传函数：注入方（server.js）的 agentTools 是 const 且在接线点之后声明，传值会 TDZ 崩
 const toolNames = typeof deps.toolNames === 'function' ? deps.toolNames() : deps.toolNames;
 const sys = buildPlanPrompt({ toolNames });
 // 注入清单取自**上一轮**的旁路记录（本轮 buildSystemPrompt 还没跑）——"看见自己的边界"够用
 const user = buildPlanUser({ lastUserText, injectedText: deps.injected.render(chatId), revNote: deps.revAnnotation(rev.rev, false) });
 const raw = await Promise.race([
 deps.auxCall(sys, user, PLAN_MAX_TOKENS, { thinking: { type: 'disabled' } },
 deps.onUsage ? (u) => deps.onUsage(u) : undefined), // 关思考（附录 C 红线：开思考须 ≥2048）
 new Promise((_, rej) => setTimeout(() => rej(new Error('超时 ' + PLAN_TIMEOUT_MS + 'ms')), PLAN_TIMEOUT_MS)),
 ]);
 const plan = sanitizePlan(raw);
 if (deps.onCall) deps.onCall('plan', sys.length + user.length, plan.length, Date.now() - t0); // 归口（估算口径见 budget.js）
 if (!plan) { log('[agent] 计划轮产物为空/解析失败 → 静默回落单次调用（' + (Date.now() - t0) + 'ms）'); return ''; }
 log('[agent] 计划轮 ok 字数=' + plan.length + ' 耗时=' + (Date.now() - t0) + 'ms 端点=' + deps.endpointLabel());
 return plan;
 } catch (e) {
 log('[agent] 计划轮失败 → 静默回落单次调用: ' + e.message);
 return '';
 }
 };
}

module.exports = { PLAN_MAX_CHARS, PLAN_TIMEOUT_MS, PLAN_MAX_TOKENS, buildPlanPrompt, buildPlanUser, sanitizePlan, renderPlanBlock, TS_RE, createPlanRunner };
