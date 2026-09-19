// lib/agent/cogpack.js —— 认知包三段式（零侵入）
// ⚠️ 依赖倒置：本模块**不 require server.js**，纯函数；Meta 历史由 server.js 读好传进来。
// 🔑 核心区分（ · 验收 20）：**agent 知道 ≠ 角色知道**。
// knowledge（角色可知·可体现）→ 进角色 system 的「角色可知」段；
// direction（导演意图·🔴 绝不可体现）→ **只进 agent 计划层**，角色不得未卜先知。
// 🔴 本模块**零设定库写入**（没有 fs，没有设定库路径，没有写函数）。
'use strict';

const KNOW_MAX = 12; // knowledge 段最多注入几条（防膨胀）
const DIR_MAX = 6; // direction 段最多取最近几条（"仅本轮/本节点"的当前口径）
const TEXT_MAX = 200; // 单条文本上限

/** 空认知包（三段齐全；taboo 本批留空，填） */
function newCogPack() { return { knowledge: [], direction: [], taboo: [], candidates: [] }; }

const clip = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);

/**
 * 从 Meta 历史组装认知包。
 * @param {Array} entries data/meta/<chatId>.jsonl 的行（按时间正序）
 * @param {{confirmCanon?:boolean}} opts
 * 🔴 canon 进 knowledge **必须先被用户采纳**（生效权在人）：只有 `kind:'adopt'` 的条目进 knowledge；
 * 未被采纳的 canon 只进 `candidates`（前端显示 + 「采纳为设定」按钮），**不注入**。
 * direction 直接进 direction 段（临时指示，本轮/本节点有效）。
 */
function buildCogPack(entries, opts) {
 const list = Array.isArray(entries) ? entries : [];
 const pack = newCogPack();
 const adopted = new Set();
 for (const e of list) {
 if (!e || typeof e !== 'object') continue;
 if (e.kind === 'adopt' && e.text) adopted.add(clip(e.text));
 }
 // knowledge ＝ 已采纳项（去重保序）；candidates ＝ 未采纳的 canon
 // 🔎 取文口径（定）：**优先用户原话**（`srcRaw`），其次分类摘要 —— 分类器的 summary 是转述，
 // 会丢原句（实测：「下章奥托会死」被转述成「预告下章奥托死亡」）；给 agent/角色的都应是原话。
 for (const e of list) {
 if (!e || typeof e !== 'object') continue;
 if (e.role !== 'agent' || e.cls !== 'canon') continue;
 const text = clip(e.srcRaw || e.summary || e.raw || '');
 if (!text) continue;
 if (adopted.has(text)) pack.knowledge.push({ text, src: 'adopted' });
 else pack.candidates.push({ text, src: 'candidate' });
 }
 // direction ＝ 最近的 DIR_MAX 条（用户原话优先，其次分类摘要）
 const dirs = [];
 for (const e of list) {
 if (!e || typeof e !== 'object') continue;
 if (e.kind === 'summary' || e.role !== 'agent' || e.cls !== 'direction') continue;
 const text = clip(e.srcRaw || e.summary || e.raw || '');
 if (text) dirs.push(text);
 }
 pack.direction = dirs.slice(-DIR_MAX).map((text) => ({ text, src: 'direction' }));
 // 去重（同一条被重复采纳/重复下达时只注入一次）
 const seenD = new Set();
 pack.direction = pack.direction.filter((d) => (seenD.has(d.text) ? false : (seenD.add(d.text), true)));
 const seen = new Set();
 pack.knowledge = pack.knowledge.filter((k) => (seen.has(k.text) ? false : (seen.add(k.text), true))).slice(-KNOW_MAX);
 const seenC = new Set();
 pack.candidates = pack.candidates
 .filter((c) => !adopted.has(c.text))
 .filter((c) => (seenC.has(c.text) ? false : (seenC.add(c.text), true)));
 return pack;
}

/** knowledge → 注入**角色 system 的「角色可知」段**（角色本人知道、可自然体现） */
function renderKnowledge(pack) {
 const ks = (pack && pack.knowledge) || [];
 if (!ks.length) return '';
 return [
 '## 角色可知（本轮认知包·已由主人确认的设定，可自然体现）',
 ...ks.map((k) => `- ${k.text}`),
 ].join('\n');
}

/**
 * direction → 注入**agent 计划层**（system 底部、随计划文本一起）。
 * 🔴 开头写死纪律行：这是导演意图，**角色不得未卜先知**、不得在台词/动作/心理里体现。
 */
function renderDirection(pack) {
 const ds = (pack && pack.direction) || [];
 if (!ds.length) return '';
 return [
 '## 🎬 导演意图（agent 专用·🔴 绝不可体现）',
 '【纪律】以下是主人给 agent 的导演意图，**不是角色知道的事**：角色**不得未卜先知**，不得在台词、动作、心理描写或任何正文里体现、暗示、影射这些内容；它只用来决定"这一段往哪个方向演"。',
 ...ds.map((d) => `- ${d.text}`),
 ].join('\n');
}

/** 禁忌段占位（实现；本批恒为空，故不注入） */
function renderTaboo(pack) {
 const ts = (pack && pack.taboo) || [];
 if (!ts.length) return '';
 return ['## 【强制·禁忌】', ...ts.map((t) => `- ${t.text || t}`)].join('\n');
}

module.exports = { KNOW_MAX, DIR_MAX, TEXT_MAX, newCogPack, buildCogPack, renderKnowledge, renderDirection, renderTaboo };