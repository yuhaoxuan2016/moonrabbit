// lib/agent/mode.js —— agent 化三态开关骨架（零侵入新增）
// ⚠️ 依赖倒置：本模块**不得 require server.js**（会循环依赖）。
// 需要的东西一律由 server.js 作参数注入；本文件只导出纯函数。
// 设计口径：featureFlags.agentMode（全局，落 data/settings.json）＋ opState.agentMode[chatId]（会话三态），
// 唯一判定入口 agentModeOn()；关掉即完全退回现状（的定义）。
'use strict';

const AGENT_MODE_VALUES = ['inherit', 'on', 'off'];
// 剥 BOM 用：按码点构造，避免源码里出现不可见字符
const BOM_RE = new RegExp('^' + String.fromCharCode(0xFEFF));

/** 归一化单个会话级取值：非法/缺失一律回落 'inherit'（照 normalizeToolsState 的宽容风格） */
function normalizeAgentMode(v) {
 return AGENT_MODE_VALUES.indexOf(v) >= 0 ? v : 'inherit';
}

/**
 * 归一化 opState.agentMode 整表，返回 { table, hits }。
 * 只保留取值明确为 on/off 的会话——'inherit' 与「键不存在」同义，不落盘，免得 op.json 堆一串无效键。
 * ⚠️ hits 必须打印（V7：按值筛表的 pass，0 命中与「本来就没有」同形）。
 */
function normalizeAgentModeTable(table) {
 const out = {};
 let hits = 0;
 const src = (table && typeof table === 'object' && !Array.isArray(table)) ? table : {};
 for (const cid of Object.keys(src)) {
 const n = normalizeAgentMode(src[cid]);
 if (n !== 'inherit') { out[cid] = n; hits++; }
 }
 return { table: out, hits };
}

/**
 * 解析 data/settings.json 原文。
 * raw == null → 文件不存在（首次启动 → 默认值，不告警）
 * raw 为字符串 → 解析失败必须返回 error（08-30 事故教训：静默 catch 会让空态覆盖真实数据）
 * 🔴 剥 BOM：PowerShell 可能以带 BOM 的 UTF-8 写盘 → JSON.parse 抛错 → 空态覆盖。
 */
function parseSettings(raw) {
 const base = { featureFlags: { agentMode: false } };
 if (raw == null) return { settings: base, firstRun: true };
 let j;
 try {
 j = JSON.parse(String(raw).replace(BOM_RE, ''));
 } catch (e) {
 return { settings: base, error: 'settings.json 解析失败：' + e.message };
 }
 if (!j || typeof j !== 'object' || Array.isArray(j)) return { settings: base, error: 'settings.json 顶层非对象' };
 const ff = (j.featureFlags && typeof j.featureFlags === 'object' && !Array.isArray(j.featureFlags)) ? j.featureFlags : {};
 const flags = Object.assign({}, ff); // 保留未来可能新增的其它开关
 flags.agentMode = !!ff.agentMode; // 只对 agentMode 显式布尔化
 return { settings: { featureFlags: Object.assign({ agentMode: false }, flags) }, firstRun: false };
}

/** 序列化 settings（写盘用）：2 空格缩进、无 BOM、无尾随空格 */
function serializeSettings(settings) {
 const on = !!(settings && settings.featureFlags && settings.featureFlags.agentMode);
 return JSON.stringify({ featureFlags: { agentMode: on } }, null, 2);
}

/**
 * 唯一判定入口。三态语义（步骤 3 契约）：
 * 全局关 → 恒 false；全局开 → 仅会话 'off' 为 false，'on'/'inherit'/缺省都 true。
 * @param {Object} settings loadSettings() 的结果
 * @param {Object} opState State.opState（用到 .agentMode）
 * @param {string} chatId
 */
function agentModeOn(settings, opState, chatId) {
 if (!settings || !settings.featureFlags || settings.featureFlags.agentMode !== true) return false;
 const table = (opState && opState.agentMode) || {};
 const per = normalizeAgentMode(table[chatId || '']);
 if (per === 'off') return false;
 return true;
}

/** GET /api/agent-mode 响应体：{ global, perChat }（纯配置态，不含任何剧情内容） */
function agentModeView(settings, opState) {
 const table = (opState && opState.agentMode) || {};
 const perChat = {};
 for (const cid of Object.keys(table)) perChat[cid] = normalizeAgentMode(table[cid]);
 return {
 global: !!(settings && settings.featureFlags && settings.featureFlags.agentMode),
 perChat,
 };
}

/**
 * （搬迁版）：POST /api/agent-mode 的业务逻辑。**副作用一律经 io 注入**，本函数只做判断与调用，
 * 这样 server.js 侧只剩「读 body → 调本函数 → 写响应」三行（：新逻辑不进 server.js）。
 * @param {Object} body 已 JSON.parse 的请求体，可含 { global?, chatId?, mode? }
 * @param {Object} io { getSettings, getOpState, saveSettings, saveOpState, sanitizeId }
 * @returns {{changed: string[], view: {global: boolean, perChat: Object}}}
 */
function applyAgentModeChange(body, io) {
 const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
 const changed = [];
 if (typeof b.global === 'boolean') {
 io.getSettings().featureFlags.agentMode = b.global;
 io.saveSettings(io.getSettings());
 changed.push('global=' + b.global);
 }
 if (b.chatId != null && b.mode != null) {
 const cid = io.sanitizeId(String(b.chatId));
 const m = normalizeAgentMode(String(b.mode));
 const table = io.getOpState().agentMode;
 if (m === 'inherit') delete table[cid]; else table[cid] = m;
 io.saveOpState(); // 既有落盘函数：整体写回、不漏槽（坑②）
 changed.push('chat:' + cid + '=' + m);
 }
 return { changed, view: agentModeView(io.getSettings(), io.getOpState()) };
}

module.exports = {
 AGENT_MODE_VALUES,
 normalizeAgentMode,
 normalizeAgentModeTable,
 parseSettings,
 serializeSettings,
 agentModeOn,
 agentModeView,
 applyAgentModeChange,
};
