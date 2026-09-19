// lib/agent/injected.js —— 本轮注入清单旁路（list_injected 的数据源）
// ⚠️ 依赖倒置：本模块不 require server.js，只导出纯函数；store 由 server.js 持有并注入。
// 🔴 设计纪律：**只报「类别 + 条数」，绝不列条目名**——
// 条目名本身可能剧透（实测有条目叫「禁止提及的未来信息」）。
'use strict';

/** 建一个注入清单记录器（每轮开头 begin() 清空重建） */
function createInjectedRecorder() {
 const store = {}; // chatId -> [{ cat, n }]
 const key = (chatId) => String(chatId == null ? '' : chatId);

 function begin(chatId) { store[key(chatId)] = []; return store[key(chatId)]; }

 /** 记一类注入。n=条数/段数（非条目名）。cat 必须是白名单内的类别，防把内容本身带进来。 */
 function add(chatId, cat, n) {
 const k = key(chatId);
 if (!store[k]) store[k] = [];
 const cnt = Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0;
 store[k].push({ cat: String(cat), n: cnt });
 return cnt;
 }

 function list(chatId) { return store[key(chatId)] || []; }

 function clear(chatId) { delete store[key(chatId)]; }

 /** 序列化成给模型看的文本（只类别+条数）；未注入的库显式写明边界 */
 function render(chatId) {
 const items = list(chatId);
 const lines = items.map((it) => ` · ${it.cat}：${it.n} 条/段`);
 return [
 `本轮 system 实际注入 ${items.length} 类内容，共 ${items.reduce((a, it) => a + it.n, 0)} 条/段：`,
 ...(lines.length ? lines : ' · （无记录）'),
 '未注入：本版不连任何外部知识库；只读工具只覆盖本会话的回合记录、用户自建设定与本版状态面板。',
 '以上为类别与条数，不含条目名（条目名本身可能剧透）。已注入的类别不要再重复查询。',
 ].join('\n');
 }

 return { store, begin, add, list, clear, render };
}

/** 注入类别定档表（顺序即清单顺序；✅ 认不出的小节不进清单，也不影响任何注入文本） */
const PROMPT_BLOCK_RULES = [
 ['界面操作覆盖', /## ⚠️ 界面操作覆盖/],
 ['禁忌（强制·未被违反）', /【强制·禁忌】/g], // 角色级/全局各一块 → n=块数
 ['硬规则（每轮必读）', /【创作自由】|【输出格式|【叙事要求】|【回合记账协议】/],
 ['世界设定/角色卡/规则', /【世界设定】|【角色卡】|【规则】/],
 ['自定义注入（前缀+后缀）', /## ⚙️ 自定义注入/g],
 ['剧情记忆', /## 剧情记忆/],
 ['当前情绪', /## 当前情绪/],
 ['当前着装', /## 当前着装/],
 ['当前物品栏', /## 当前物品栏/],
 ['补充资料', /## 补充资料/],
 ['设定触发器/世界书', /## 设定触发器 \/ 世界书/],
 ['旁注（位置感知）', /## 旁注（位置感知引导）/],
];

/**
 * 从**已拼好的**注入块里统计「类别 + 条数」写进清单（list_injected 的数据源）。
 * 🔴 只读统计，绝不改动任何注入文本（逐字节回归靠这条）；只记类别，不记条目名。
 * @param {Object} recorder createInjectedRecorder() 的返回值
 * @param {string} chatId
 * @param {string[]} blocks 拼好的块（main + tail）
 * @param {{lorebookCount?:number, annotationCount?:number}} extra 世界书命中/旁注启用数
 * @returns {number} 命中的类别数（V7：0 命中要能被看见）
 */
function recordFromPromptBlocks(recorder, chatId, blocks, extra) {
 const cid = String(chatId == null ? '' : chatId);
 recorder.begin(cid);
 const joined = (blocks || []).join('\n\n');
 let cats = 0;
 for (const [cat, re] of PROMPT_BLOCK_RULES) {
 // ⚠️ 不用 re.test()：带 /g 的正则 lastIndex 会残留，导致下一轮漏判；match 不受影响
 const m = joined.match(re);
 const n = m ? m.length : 0;
 if (n) { recorder.add(cid, cat, n); cats++; }
 }
 const lc = Number((extra && extra.lorebookCount) || 0);
 if (lc > 0) { recorder.add(cid, '世界书命中条数', lc); cats++; }
 const ac = Number((extra && extra.annotationCount) || 0);
 if (ac > 0) { recorder.add(cid, '旁注启用数', ac); cats++; }
 return cats;
}

module.exports = { createInjectedRecorder, recordFromPromptBlocks, PROMPT_BLOCK_RULES };
