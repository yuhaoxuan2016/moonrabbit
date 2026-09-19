// lib/agent/budget.js —— token 预算闸门（六档降级顺序）＋ agentTokens 归口
// ⚠️ 纯函数模块，不 require server.js。
// ⚠️ 依据变更备案：原「余量 1323」的论据已失效（早先那条字数硬截断已取消）
// ⇒ 本模块**按实际字符数**做预算，不照抄原方案的 token 数字。
'use strict';

// 六档（1 最高，永不砍；6 最低，最后砍/整体丢弃）——按既定口径
const TIER_RULES = [
 { tier: 1, never: true, name: '常驻设定/硬规则', re: /【创作自由】|【输出格式|【叙事要求】|【回合记账协议】|## ⚠️ 界面操作覆盖|## ⚙️ 自定义注入/ },
 { tier: 2, never: true, name: '世界设定/角色卡/规则/状态', re: /【世界设定】|【角色卡】|【规则】|## 当前着装|## 当前物品栏|## 当前情绪/ },
 { tier: 3, never: true, name: '世界书触发条目', re: /## 设定触发器 \/ 世界书|## 旁注（位置感知引导）/ }, // 已有 lorebookSettings.tokenBudget 机制，这里不再砍
 { tier: 4, never: false, name: '补充资料', re: /## 补充资料/ },
 { tier: 5, never: false, name: '剧情记忆/情绪', re: /## 剧情记忆|## 当前情绪/ },
 { tier: 6, never: false, name: 'agent 计划文本', re: /## 🤖 本轮演出计划/ },
];

/** 给一段注入文本定档；认不出的一律按"永不砍"处理（安全侧：宁可不砍，也不误砍设定） */
function tierOf(text) {
 const t = String(text == null ? '' : text);
 for (const r of TIER_RULES) if (r.re.test(t)) return r;
 return { tier: 0, never: true, name: '未分类（按永不砍处理）' };
}

/**
 * 六档降级：从档位号大的往小的砍，`never` 档永不动，砍到 ≤ limit 即停。
 * @param {Array<{text:string}>} blocks 变化段块（顺序＝拼装顺序）
 * @param {number} limit 允许的最大字符数
 * @returns {{kept:string[], dropped:Array<{name:string,tier:number,chars:number}>, before:number, after:number, limit:number}}
 */
function applyBudget(blocks, limit) {
 const items = (blocks || []).map((b) => {
 const text = typeof b === 'string' ? b : String(b && b.text || '');
 const r = tierOf(text);
 return { text, tier: r.tier, name: r.name, never: r.never, chars: text.length };
 });
 const before = items.reduce((a, x) => a + x.chars, 0);
 const dropped = [];
 let after = before;
 // 「不限制」只由 非有限值（undefined/NaN）表达；**limit<=0 是真·零预算**（把可砍档全砍，只留永不砍），
 // 否则调用方算出 0 预算时闸门会形同虚设（端到端实测踩过：预算被 main 吃满→limit=0→不砍）。
 if (!Number.isFinite(limit) || before <= limit) return { kept: items.map((x) => x.text), dropped, before, after, limit: Number.isFinite(limit) ? limit : 0 };
 // 档位号从大到小；同档位内从后往前（越靠后越近生成点，但越晚拼装的一般越次要）
 const order = items.map((x, i) => ({ x, i })).filter(({ x }) => !x.never && x.tier >= 4)
 .sort((a, b) => (b.x.tier - a.x.tier) || (b.i - a.i));
 const cut = new Set();
 for (const { x, i } of order) {
 if (after <= limit) break;
 cut.add(i); dropped.push({ name: x.name, tier: x.tier, chars: x.chars }); after -= x.chars;
 }
 return { kept: items.filter((_, i) => !cut.has(i)).map((x) => x.text), dropped, before, after, limit };
}

/** 字符 → token 的既有近似口径（server.js 上下文裁剪用 0.67） */
const estTokens = (chars) => Math.ceil(Math.max(0, Number(chars) || 0) * 0.67);

/**
 * agentTokens 记账结构。⚠️ 估算口径如实标注：auxCall→completeText 只回正文文本、
 * **不回传 usage**，所以本桶是「按字符×0.67 估算」而非 API 实报；精确化需改 completeText（
 * 摘要/TTS 等多处共用），本批不改，已记为待办。
 */
function newAgentBucket() {
 return { estimated: true, calls: 0, planCalls: 0, checkCalls: 0, retryCalls: 0, tokensIn: 0, tokensOut: 0, ms: 0, droppedPlans: 0, deniedTools: 0, realIn: 0, realOut: 0, realCacheRead: 0, realCalls: 0, usageKnown: false };
}
function addAgentCall(b, kind, inChars, outChars, ms) {
 if (!b || typeof b !== 'object') return b;
 b.calls += 1;
 if (kind === 'plan') b.planCalls += 1; else if (kind === 'check') b.checkCalls += 1; else if (kind === 'retry') b.retryCalls += 1;
 b.tokensIn += estTokens(inChars);
 b.tokensOut += estTokens(outChars);
 b.ms += Math.max(0, Number(ms) || 0);
 return b;
}

/**
 * 真实 usage 归口（调用方在 completeText/auxCall 回传 usage 后才有）。
 * 与 addAgentCall 的字符估算**并存不互相覆盖**：tokensIn/tokensOut 仍是估算，
 * realIn/realOut/realCacheRead 是 API 实报；usageKnown 表示本桶是否已有真数。
 * 字段名两协议都认（openai: prompt_tokens/completion_tokens/prompt_cache_hit_tokens；
 * anthropic: input_tokens/output_tokens/cache_read_input_tokens）。
 */
function addAgentUsage(b, usage, ms) {
 if (!b || typeof b !== 'object' || !usage) return b;
 const inTok = Number(usage.input_tokens != null ? usage.input_tokens : usage.prompt_tokens) || 0;
 const outTok = Number(usage.output_tokens != null ? usage.output_tokens : usage.completion_tokens) || 0;
 const cacheRead = Number(usage.cache_read_input_tokens != null ? usage.cache_read_input_tokens : usage.prompt_cache_hit_tokens) || 0;
 b.realIn = (b.realIn || 0) + inTok;
 b.realOut = (b.realOut || 0) + outTok;
 b.realCacheRead = (b.realCacheRead || 0) + cacheRead;
 b.realCalls = (b.realCalls || 0) + 1;
 b.usageKnown = true;
 if (Number.isFinite(ms)) b.ms += Math.max(0, ms);
 return b;
}

module.exports = { TIER_RULES, tierOf, applyBudget, estTokens, newAgentBucket, addAgentCall, addAgentUsage };
