// lib/store/loaders.js —— M-08·loaders 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const agentModeLib = require('../agent/mode');
const { BRIDGE_TOOL_NAMES } = require('../agent/bridge');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');
const { SETTINGS_FILE } = require('../http/handlers/agent');
const { EXPRESSIONS_DIR, EXPRESSION_CONFIG } = require('./avatars');
const { PROFILES_FILE, BUILTIN_PROFILES, saveProfiles, KEY_MEMO_FILE, BUILTIN_CHAT_PROFILES, CHAT_PROFILES_FILE, saveChatProfiles } = require('./config');
const { DEFAULT_EMOTION_MAP } = require('./emotions');
const { REGEX_RULES_FILE } = require('./regex');
const { WORLDBOOKS_DIR, LOREBOOK_FILE, GRAPH_FILE } = require('./worldbooks');
const { VEC_CONFIG_FILE } = require('../vec/index');

function loadChatProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHAT_PROFILES_FILE, 'utf8'));
    State.chatProfiles = { ...BUILTIN_CHAT_PROFILES, ...(raw.profiles || {}) };
  } catch (e) {
    State.chatProfiles = { ...BUILTIN_CHAT_PROFILES };
    saveChatProfiles();
  }
}
function getChatProfile(chatId) {
  try {
    const chatFile = path.join(DATA_DIR, 'chats', `${chatId}.json`);
    if (!fs.existsSync(chatFile)) return null;
    const chat = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
    const profileId = chat.chatProfile || 'main';
    return State.chatProfiles[profileId] || State.chatProfiles.main || null;
  } catch (e) { return null; }
}
function loadExpressionConfig() { try { const r = JSON.parse(fs.readFileSync(EXPRESSION_CONFIG, 'utf8')); State.emotionMap = { ...DEFAULT_EMOTION_MAP, ...(r.emotionMap || {}) }; State.enableAutoSwitch = r.enableAutoSwitch !== false; } catch (e) { /* 默认 */ } }
function getExpressionPath(charName, emotion) {
  const mapped = State.emotionMap[emotion] || State.emotionMap['默认'] || '默认';
  const dir = path.join(EXPRESSIONS_DIR, charName);
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) { if (fs.existsSync(path.join(dir, mapped + ext))) return `/api/expressions/static/${encodeURIComponent(charName)}/${encodeURIComponent(mapped + ext)}`; }
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) { if (fs.existsSync(path.join(dir, '默认' + ext))) return `/api/expressions/static/${encodeURIComponent(charName)}/${encodeURIComponent('默认' + ext)}`; }
  return null;
}
function loadRegexRules() { try { const r = JSON.parse(fs.readFileSync(REGEX_RULES_FILE, 'utf8')); State.regexRules = Array.isArray(r.rules) ? r.rules : []; } catch (e) { State.regexRules = []; } }
function applyRegexRules(text) {
  let r = text;
  for (const rule of State.regexRules) {
    if (!rule.enabled) continue;
    // ReDoS 防护：限制正则模式长度
    if (!rule.pattern || rule.pattern.length > 200) continue;
    try { r = r.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replacement || ''); } catch (e) { /* 跳过 */ }
  }
  return r;
}
function loadLorebook() { try { const r = JSON.parse(fs.readFileSync(LOREBOOK_FILE, 'utf8')); State.lorebookEntries = r.entries || {}; if (r.settings) State.lorebookSettings = { ...State.lorebookSettings, ...r.settings }; } catch (e) { State.lorebookEntries = {}; } }
function loadWorldbooks() {
  State.worldbooks = {};
  try {
    if (!fs.existsSync(WORLDBOOKS_DIR)) return;   // 空库：直接可用
    for (const f of fs.readdirSync(WORLDBOOKS_DIR)) {
      if (!f.endsWith('.json')) continue;         // .bak_* 等非 json 自然不进
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(WORLDBOOKS_DIR, f), 'utf8'));
        const bid = (raw.book && raw.book.id) || f.replace(/\.json$/, '');
        State.worldbooks[bid] = {
          book: {
            id: bid,
            name: (raw.book && raw.book.name) || bid,
            description: (raw.book && raw.book.description) || '',
            scope: (raw.book && raw.book.scope) === 'global' ? 'global' : 'chat',
            version: (raw.book && raw.book.version) || 1,
            note: (raw.book && raw.book.note) || '',
          },
          settings: { enabled: true, tokenBudget: 'auto', budgetRatio: 0.08, scanDepth: 10, ...(raw.settings || {}) },
          entries: raw.entries || {},
        };
      } catch (e) { console.error('世界书解析失败 ' + f + ': ' + e.message); }
    }
  } catch (e) { /* 忽略 */ }
}
function loadGraph() { try { State.graphData = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8')); if (!State.graphData.nodes) State.graphData.nodes = []; if (!State.graphData.edges) State.graphData.edges = []; } catch (e) { State.graphData = { nodes: [], edges: [], version: 1 }; } }
function loadProfiles() {
  try {
    const pj = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    if (pj.custom && typeof pj.custom === 'object') State.profiles = { ...BUILTIN_PROFILES, ...pj.custom };
    else State.profiles = { ...BUILTIN_PROFILES };
    if (pj.active && State.profiles[pj.active]) State.activeProfile = pj.active;
    else State.activeProfile = '';
  } catch (e) {
    State.profiles = { ...BUILTIN_PROFILES };
    State.activeProfile = '';
    saveProfiles();
  }
}
function loadKeyMemo() {
  try {
    const kj = JSON.parse(fs.readFileSync(KEY_MEMO_FILE, 'utf8'));
    if (kj && typeof kj === 'object') {
      if (kj.by && typeof kj.by === 'object') State.keyMemo.by = kj.by;
      if (kj.auxBy && typeof kj.auxBy === 'object') State.keyMemo.auxBy = kj.auxBy;
    }
  } catch (e) { /* 首次使用 */ }
  // 启动种子：当前生效的 Key 归属当前端点，直接纳入记忆（避免「已配置却切档后丢 Key」）
  if (State.endpoint.apiKey && State.endpoint.baseURL) State.keyMemo.by[State.endpoint.baseURL] = State.endpoint.apiKey;
  if (State.aux.apiKey && State.aux.baseURL) State.keyMemo.auxBy[State.aux.baseURL] = State.aux.apiKey;
}
function loadVecConfig() {
  try {
    if (fs.existsSync(VEC_CONFIG_FILE)) State.vecConfig = { ...State.vecConfig, ...JSON.parse(fs.readFileSync(VEC_CONFIG_FILE, 'utf8')) };
  } catch (e) { /* 使用默认值 */ }
}
function loadSettings() {
  let raw = null;
  try { raw = fs.readFileSync(SETTINGS_FILE, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') console.error('[settings.json] 读取失败：' + e.message); }
  const r = agentModeLib.parseSettings(raw);
  if (r.error) console.error('[settings.json] ' + r.error + '（本次用默认值；未回写盘，避免空态覆盖真实数据）');
  return r.settings;
}
function agentModeOn(chatId) { return agentModeLib.agentModeOn(State.settings, State.opState, chatId); }
function normalizeToolsState() {
  const out = {};
  for (const [cid, v] of Object.entries(State.opState.tools || {})) {
    if (v === true) out[cid] = BRIDGE_TOOL_NAMES.slice();
    else if (Array.isArray(v)) out[cid] = v.filter((n) => BRIDGE_TOOL_NAMES.includes(n));
    else if (v && typeof v === 'object') out[cid] = BRIDGE_TOOL_NAMES.filter((n) => v[n]);
    else out[cid] = [];
  }
  State.opState.tools = out;
}

module.exports = { loadChatProfiles, getChatProfile, loadExpressionConfig, getExpressionPath, loadRegexRules, applyRegexRules, loadLorebook, loadWorldbooks, loadGraph, loadProfiles, loadKeyMemo, loadVecConfig, loadSettings, agentModeOn, normalizeToolsState };
