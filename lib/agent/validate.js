// lib/agent/validate.js —— 格式校验 + 失败留痕 + 三层回传摘要（新增）
// ⚠️ 纯函数模块，不 require server.js。
// 纪律（设计 /）：**失败要留痕，成功可以轻**——
// · 工具成功 → 只留一行「✓ 已查 xxx」；工具失败/空 → 完整留痕（含原因），那才是模型要学的东西。
// · 记账标签缺失 → 把失败原因写进本轮记录，并在**下一轮**的 system 底部回传（不打断本轮流式正文）。
// · L3 模型 raw reasoning 一律不回传（保持现状）。
'use strict';

// 必填字段（storyevent 块内）
const REQUIRED_KV = ['time', 'location', 'characters', 'event'];
const TAG_RE = /<storyevent>[\s\S]*?<\/storyevent>/i;
const ITEMS_RE = /<items>[\s\S]*?<\/items>/i;

/**
 * 校验一轮正文的记账标签是否合格。
 * @param {string} content 模型正文
 * @param {{}} opts 预留（当前无额外开关）
 * @returns {{ok:boolean, missing:string[], reason:string}}
 */
function validateTurnTags(content, opts) {
 const t = String(content == null ? '' : content);
 const missing = [];
 if (!TAG_RE.test(t)) missing.push('storyevent 块');
 else {
 const block = (t.match(TAG_RE) || [''])[0];
 for (const k of REQUIRED_KV) {
 const re = new RegExp('\\b' + k + '\\s*[：:]\\s*([^\\n;；]*)', 'i');
 const m = block.match(re);
 if (!m || !String(m[1]).trim()) missing.push('storyevent.' + k);
 }
 }
 if (!ITEMS_RE.test(t)) missing.push('items 块');
 return { ok: missing.length === 0, missing, reason: missing.length ? '缺 ' + missing.join('、') : '' };
}

/**
 * 当场打回用的指令：要求模型**保留正文**、只补齐缺失的记账标签。
 * 与 tagFailFeedback 的区别：那个是"下一轮 system 里提醒"，这个是"本轮立刻重问一次"。
 */
function retryInstruction(vv) {
 const miss = (vv && vv.missing && vv.missing.length) ? vv.missing.join('、') : '记账标签';
 return [
 '（系统格式校验提示）你上一条回复的记账标签不合格：缺 ' + miss + '。',
 '请**原样保留上一条正文内容**（不要改写剧情、不要重新起笔、不要解释），',
 '只在末尾补齐 <storyevent>（time / location / characters / event 四项必须有值）、<items>，然后输出完整一条回复。',
 ].join('\n');
}

/** 写进回合记录的失败标记（成功时调用方不要写＝"成功可以轻"） */
function makeTagFail(v, seq) {
 return { missing: v.missing.slice(0, 8), reason: v.reason, seq: seq == null ? null : seq, retry: 0 };
}

/**
 * 下一轮 system 底部的回传段（只讲事实与要求，不含时间戳/随机量＝ 防前缀抖动）。
 * @param {Object|null} fail makeTagFail 的产物
 */
function tagFailFeedback(fail) {
 if (!fail || !fail.missing || !fail.missing.length) return '';
 return [
 '## ⚠️ 上一轮回合记账不合格（请在本次回复中改正）',
 `- 缺失项：${fail.missing.join('、')}`,
 '- 要求：`<storyevent>` 内的 time / location / characters / event 四项**必须有值**（无法判断也要写最接近的时段或"同上"，不许整块省略），并输出 `<items>`。',
 '- 这是记账格式问题，**不影响剧情连续性**；正文照常按当前场景写。',
 ].join('\n');
}

/**
 * L1 工具 trace 摘要化回传（三层回传的第一层）。
 * 成功 → 一行；失败/空 → 带原因与参数，让模型下一轮不重查同一条。
 * @param {Array<{name:string,input:Object,resultHead:string,ok?:boolean,note?:string,error?:string}>} trace
 */
function traceDigest(trace) {
 const rows = Array.isArray(trace) ? trace : [];
 const lines = [];
 for (const t of rows) {
 const name = String((t && t.name) || '?');
 const arg = (() => {
 try { return JSON.stringify((t && t.input) || {}).slice(0, 60); } catch (e) { return '{}'; }
 })();
 const head = String((t && t.resultHead) || '');
 const bad = (t && t.ok === false) || (t && t.error) || /^(拒绝|查询失败|工具执行失败|文件不存在|检索服务错误|联网搜索失败)/.test(head);
 const empty = (t && t.note === '无匹配') || /^无匹配|^（搜索未返回结果）|^（搜索多次未返回结果）/.test(head);
 if (bad) lines.push(`· ${name}(${arg}) ✗ 失败：${head.slice(0, 120)}`);
 else if (empty) lines.push(`· ${name}(${arg}) ○ 查过但无匹配（不要再查同一条）`);
 else lines.push(`· ${name}(${arg}) ✓`);
 }
 return lines.join('\n');
}

module.exports = { validateTurnTags, retryInstruction, makeTagFail, tagFailFeedback, traceDigest, REQUIRED_KV };
