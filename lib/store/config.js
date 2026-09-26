// lib/store/config.js —— M-08·config-store 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { readJson, writeFileAtomicSync, listJsonMeta, backupConfig } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');
const { CHATS_DIR } = require('./chats');
const { sanitizeId, assertSafeEndpoint } = require('../tools/misc');

const MODEL_FILE = path.join(DATA_DIR, 'model.json');
const PRESET_FILE = path.join(DATA_DIR, 'presets.json');
const BUILTIN_PRESETS = {
  'DeepSeek 默认（官方参数）': { temperature: 1.0, top_p: 1.0, top_k: 0, presence_penalty: 0, frequency_penalty: 0, maxTokens: 393216, maxContext: 1048576 },
  'RP 创作（社区向）': { temperature: 1.5, top_p: 0.9, top_k: 40, presence_penalty: 0, frequency_penalty: 0, maxTokens: 393216, maxContext: 1048576 },
  '省 token 快速': { temperature: 1.0, top_p: 1.0, top_k: 0, presence_penalty: 0, frequency_penalty: 0, maxTokens: 2048, maxContext: 32000 },
};
function normPreset(p) {
  const out = {};
  if (Number.isFinite(p.temperature) && p.temperature >= 0 && p.temperature <= 2) out.temperature = p.temperature;
  if (Number.isFinite(p.top_p) && p.top_p > 0 && p.top_p <= 1) out.top_p = p.top_p;
  if (Number.isFinite(p.top_k) && p.top_k >= 0 && p.top_k <= 100) out.top_k = Math.round(p.top_k);
  if (Number.isFinite(p.presence_penalty) && p.presence_penalty >= 0 && p.presence_penalty <= 2) out.presence_penalty = p.presence_penalty;
  if (Number.isFinite(p.frequency_penalty) && p.frequency_penalty >= 0 && p.frequency_penalty <= 2) out.frequency_penalty = p.frequency_penalty;
  if (Number.isFinite(p.maxTokens) && p.maxTokens >= 256 && p.maxTokens <= 393216) out.maxTokens = Math.round(p.maxTokens);
  if (Number.isFinite(p.maxContext) && p.maxContext >= 0 && p.maxContext <= 1048576) out.maxContext = Math.round(p.maxContext);
  return out;
}
function savePresets() {
  const custom = {};
  for (const [k, v] of Object.entries(State.presets)) if (!BUILTIN_PRESETS[k]) custom[k] = v;
  try { backupConfig(PRESET_FILE); writeFileAtomicSync(PRESET_FILE, JSON.stringify({ custom, active: State.activePreset }, null, 2), 'utf8'); } catch (e) { console.error('保存预设失败:', e.message); }
}
function applyPreset(name) {
  const p = State.presets[name];
  if (!p) return false;
  State.activePreset = name;
  State.samplers.temperature = p.temperature != null ? p.temperature : null;
  State.samplers.top_p = p.top_p != null ? p.top_p : null;
  State.samplers.top_k = p.top_k != null && p.top_k > 0 ? p.top_k : null;
  State.samplers.presence_penalty = p.presence_penalty != null ? p.presence_penalty : null;
  State.samplers.frequency_penalty = p.frequency_penalty != null ? p.frequency_penalty : null;
  if (p.maxTokens != null) State.endpoint.maxTokens = p.maxTokens;
  if (p.maxContext != null) State.endpoint.maxContext = p.maxContext;
  savePresets();
  return true;
}
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const BUILTIN_PROFILES = {
  'DeepSeek 官方': { protocol: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', thinking: 'auto', maxTokens: 393216, maxContext: 1048576, preset: 'DeepSeek 默认（官方参数）', desc: '官方直连（高峰时段加价）' },
  'DeepSeek 官方·Reasoner': { protocol: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-reasoner', thinking: 'auto', maxTokens: 393216, maxContext: 1048576, preset: 'DeepSeek 默认（官方参数）', desc: '官方直连推理模型' },
  '硅基流动': { protocol: 'openai', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', thinking: 'auto', maxTokens: 8192, maxContext: 65536, preset: 'DeepSeek 默认（官方参数）', desc: '硅基流动 V3（按量计费）' },
  '本地 Ollama': { protocol: 'openai', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:14b', thinking: 'disabled', maxTokens: 4096, maxContext: 32768, desc: '本地 Ollama（无需 Key）' },
};
function saveProfiles() {
  const custom = {};
  for (const [k, v] of Object.entries(State.profiles)) if (!BUILTIN_PROFILES[k]) custom[k] = v;
  try { backupConfig(PROFILES_FILE); writeFileAtomicSync(PROFILES_FILE, JSON.stringify({ custom, active: State.activeProfile }, null, 2), 'utf8'); } catch (e) { console.error('保存配置档案失败:', e.message); }
}
function snapshotEndpoint() {
  return {
    protocol: State.endpoint.protocol, baseURL: State.endpoint.baseURL,
    model: State.endpoint.model, thinking: State.endpoint.thinking,
    thinkingBudget: State.endpoint.thinkingBudget, maxTokens: State.endpoint.maxTokens,
    maxContext: State.endpoint.maxContext, autoSummary: State.endpoint.autoSummary,
    autoSummaryThreshold: State.endpoint.autoSummaryThreshold,
    preset: State.activePreset || '',
    aux: { enabled: State.aux.enabled, protocol: State.aux.protocol, baseURL: State.aux.baseURL, model: State.aux.model, fallback: State.aux.fallback },
  };
}
function applyProfile(name) {
  const p = State.profiles[name];
  if (!p) return false;
  State.activeProfile = name;
  // Key 自动记忆：切档前把当前生效 Key 记到旧端点名下，防止「切走再切回」丢 Key
  if (State.endpoint.apiKey && State.endpoint.baseURL && !State.keyMemo.by[State.endpoint.baseURL]) State.keyMemo.by[State.endpoint.baseURL] = State.endpoint.apiKey;
  if (State.aux.apiKey && State.aux.baseURL && !State.keyMemo.auxBy[State.aux.baseURL]) State.keyMemo.auxBy[State.aux.baseURL] = State.aux.apiKey;
  if (p.protocol === 'anthropic' || p.protocol === 'openai') State.endpoint.protocol = p.protocol;
  // C-2 纵深防御：历史脏档案/手工编辑的 profiles.json 可能含内网端点，恢复时同样校验（失败则保留当前端点）
  // 注意：必须在下方 keyMemo 查表之前完成，否则会用未校验的 baseURL 取 Key
  if (p.baseURL && typeof p.baseURL === 'string' && p.baseURL.trim()) {
    try { State.endpoint.baseURL = assertSafeEndpoint(p.baseURL); }
    catch (e) { console.error('[applyProfile] 档案 baseURL 被拒绝，保留当前端点:', e.message); }
  }
  if (p.model) State.endpoint.model = p.model;
  // 优先取该端点的记忆 Key，未记忆则沿用当前值（档案本身不存 Key）
  if (State.keyMemo.by[State.endpoint.baseURL]) State.endpoint.apiKey = State.keyMemo.by[State.endpoint.baseURL];
  if (['auto', 'disabled', 'low', 'medium', 'high', 'max', 'custom'].includes(p.thinking)) State.endpoint.thinking = p.thinking;
  if (Number.isFinite(p.thinkingBudget) && p.thinkingBudget >= 256) State.endpoint.thinkingBudget = p.thinkingBudget;
  if (Number.isFinite(p.maxTokens) && p.maxTokens >= 256 && p.maxTokens <= 393216) State.endpoint.maxTokens = p.maxTokens;   /* E-8 修复：补上限钳制（防 1e9 写入 model.json） */
  if (Number.isFinite(p.maxContext) && p.maxContext >= 0) State.endpoint.maxContext = p.maxContext;
  if (typeof p.autoSummary === 'boolean') State.endpoint.autoSummary = p.autoSummary;
  if (Number.isFinite(p.autoSummaryThreshold) && p.autoSummaryThreshold >= 2000) State.endpoint.autoSummaryThreshold = p.autoSummaryThreshold;
  if (p.aux && typeof p.aux === 'object') {
    if (typeof p.aux.enabled === 'boolean') State.aux.enabled = p.aux.enabled;
    if (p.aux.protocol === 'anthropic' || p.aux.protocol === 'openai') State.aux.protocol = p.aux.protocol;
    if (p.aux.baseURL && p.aux.baseURL.trim()) {
      try { State.aux.baseURL = assertSafeEndpoint(p.aux.baseURL); }   // C-2
      catch (e) { console.error('[applyProfile] 档案 aux.baseURL 被拒绝:', e.message); }
    }
    if (State.keyMemo.auxBy[State.aux.baseURL]) State.aux.apiKey = State.keyMemo.auxBy[State.aux.baseURL];
    if (p.aux.model && p.aux.model.trim()) State.aux.model = p.aux.model.trim();
    if (typeof p.aux.fallback === 'boolean') State.aux.fallback = p.aux.fallback;
  }
  if (p.preset && State.presets[p.preset]) applyPreset(p.preset);
  // 同步 model.json（写盘失败不阻塞端点切换；下次保存会再试）
  try {
    backupConfig(MODEL_FILE);
    writeFileAtomicSync(MODEL_FILE, JSON.stringify({
      protocol: State.endpoint.protocol, baseURL: State.endpoint.baseURL, apiKey: State.endpoint.apiKey,
      model: State.endpoint.model, maxTokens: State.endpoint.maxTokens, thinking: State.endpoint.thinking,
      thinkingBudget: State.endpoint.thinkingBudget, maxContext: State.endpoint.maxContext,
      autoSummary: State.endpoint.autoSummary, autoSummaryThreshold: State.endpoint.autoSummaryThreshold,
      aux: { enabled: State.aux.enabled, protocol: State.aux.protocol, baseURL: State.aux.baseURL, apiKey: State.aux.apiKey, model: State.aux.model, fallback: State.aux.fallback },
      updatedAt: new Date().toISOString(),
    }), 'utf8');
  } catch (e) { console.error('[applyProfile] model.json 写盘失败:', e.message); }
  saveProfiles();
  saveKeyMemo();
  return true;
}
function saveKeyMemo() {
  try {
    backupConfig(KEY_MEMO_FILE);
    writeFileAtomicSync(KEY_MEMO_FILE, JSON.stringify(State.keyMemo, null, 2), 'utf8');
  } catch (e) { console.error('保存 Key 记忆失败:', e.message); }
}
const KEY_MEMO_FILE = path.join(DATA_DIR, 'keyMemo.json');
const BUILTIN_CHAT_PROFILES = {
  main: { label: '默认', color: '#639922', isDefault: true, firstMsg: '' },
};
const CHAT_PROFILES_FILE = path.join(DATA_DIR, 'chat-profiles.json');
function saveChatProfiles() {
  const custom = {};
  for (const [k, v] of Object.entries(State.chatProfiles)) if (!BUILTIN_CHAT_PROFILES[k]) custom[k] = v;
  try { backupConfig(CHAT_PROFILES_FILE); writeFileAtomicSync(CHAT_PROFILES_FILE, JSON.stringify({ profiles: { ...BUILTIN_CHAT_PROFILES, ...custom }, version: 1 }, null, 2), 'utf8'); } catch (e) { console.error('保存配置档失败:', e.message); }
}
function recordLastChat(cid) {
  const raw = String(cid || '').trim();
  if (!raw) return;   // 空 id 不记（sanitizeId('') 会回退成 'default'，写进去就成了假会话）
  try { fs.writeFileSync(LAST_CHAT_FILE, JSON.stringify({ chatId: sanitizeId(raw), ts: Date.now() }), 'utf8'); } catch (e) { /* 忽略 */ }
}
function readLastChat() {
  try { return JSON.parse(fs.readFileSync(LAST_CHAT_FILE, 'utf8')).chatId || ''; } catch (e) { return ''; }
}
const LAST_CHAT_FILE = path.join(DATA_DIR, 'last-chat.json');
const sanitizeText = (s) => String(s || '')
const cleanMsg = (m) => (m && typeof m === 'object' && typeof m.content === 'string'
  ? { ...m, content: sanitizeText(m.content), ...(typeof m.thinking === 'string' ? { thinking: sanitizeText(m.thinking) } : {}) }
  : m);
const cleanMsgs = (arr) => (Array.isArray(arr) ? arr.map(cleanMsg) : arr);
async function probeEndpoint(ep) {
  if (ep.protocol === 'openai') {
    const r = await fetch(`${ep.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({ model: ep.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const d = await r.json();
    return { model: (d.model || ep.model).trim() };
  }
  const r = await fetch(`${ep.baseURL}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ep.model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const d = await r.json();
  return { model: (d.model || ep.model).trim() };
}
function readChats(showHidden = false) {
  try {
    return fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json')).map((f) => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
        const hidden = !!c.hidden;
        if (!showHidden && hidden) return null;
        return { id: c.id, title: c.title || '未命名', createdAt: c.createdAt, updatedAt: c.updatedAt, count: (c.messages || []).length, pinned: !!c.pinned, hidden };
      } catch (e) { return null; }
    }).filter(Boolean).sort((a, b) => {
      // 置顶会话优先，其余按最近更新排序
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
  } catch (e) { return []; }
}
async function loadChatMetas() {
  try {
    const list = (await listJsonMeta(CHATS_DIR)).filter((m) => m.file.endsWith('.json'));
    const sig = list.map((m) => `${m.file}:${m.mtimeMs}:${m.size}`).sort().join('|');
    if (sig === State.chatMetaCache.sig) return State.chatMetaCache.metas;
    const metas = [];
    for (const m of list) {
      const c = await readJson(path.join(CHATS_DIR, m.file));
      if (!c) continue;
      metas.push({ id: c.id, title: c.title || '未命名', createdAt: c.createdAt, updatedAt: c.updatedAt, count: (c.messages || []).length, pinned: !!c.pinned, hidden: !!c.hidden });
    }
    metas.sort((a, b) => {
      // 置顶会话优先，其余按最近更新排序（与 readChats 一致）
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
    State.chatMetaCache = { sig, metas };
    return metas;
  } catch (e) { return []; }
}

module.exports = { MODEL_FILE, PRESET_FILE, BUILTIN_PRESETS, normPreset, savePresets, applyPreset, PROFILES_FILE, BUILTIN_PROFILES, saveProfiles, snapshotEndpoint, applyProfile, saveKeyMemo, KEY_MEMO_FILE, BUILTIN_CHAT_PROFILES, CHAT_PROFILES_FILE, saveChatProfiles, recordLastChat, readLastChat, LAST_CHAT_FILE, sanitizeText, cleanMsg, cleanMsgs, probeEndpoint, readChats, loadChatMetas };
