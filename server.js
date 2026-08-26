#!/usr/bin/env node

// ===== 全局可变状态收口 =====
const State = {};  // 原 let 全局变量统一收口，详见 AGENTS.md 变更日志
// server.js —— Moonrabbit 后端（多角色 RP / 互动小说界面，零依赖，纯 Node 内置模块）
// 用法：node server.js  （或双击 start.bat）
// 打开 http://127.0.0.1:3081
const http = require('http');
const fs = require('fs');
const path = require('path');

const WWW = __dirname;
const PORT = Number(process.env.MOONRABBIT_PORT || 3081);
// 端点配置：协议（anthropic|openai）+ baseURL + apiKey + model
// 可经 POST /api/model 切换（含自定义 API），持久化到 data/model.json
State.endpoint = {
  protocol: 'anthropic',
  baseURL: (process.env.MOONRABBIT_BASE || 'https://api.deepseek.com/anthropic/v1').replace(/\/+$/, ''),
  apiKey: '',
  model: process.env.MOONRABBIT_MODEL || 'deepseek-chat',
  maxTokens: 8192,          // 输出上限
  thinking: 'auto',         // auto | enabled | disabled
  thinkingBudget: 32768,    // thinking 开启时的预算 token（v4 输出 384K，给足思考空间）
  maxContext: 1048576,      // 上下文预算（system+历史 token；0 = 不裁剪；deepseek-v4 窗口 1M）
  autoSummary: true,        // 自动压缩总结
  autoSummaryThreshold: 80000,  // 历史消息字符数超过该值触发压缩（v4 大窗口：快满才压，长记忆）
};

// 辅助 API（后台任务独立端点）：自动摘要 / 工具桥 / 联网搜索走独立端点，不抢主对话 API；
// 请求串行排队防 429；失败默认不回退主 API（可手动开启回退）。
State.aux = {
  enabled: false,        // 是否启用辅助端点（未启用 = 后台任务仍走主端点）
  protocol: 'anthropic',
  baseURL: '',
  apiKey: '',
  model: '',
  fallback: false,       // 辅助端点失败时是否回退主端点
};
// 辅助请求串行队列：一次只发一个，避免后台任务并发撞限流
State.auxQueue = Promise.resolve();
function auxEnqueue(task) {
  const run = State.auxQueue.then(task, task);   // 前一任务失败也继续执行下一任务
  State.auxQueue = run.catch(() => {});
  return run;
}
// 读取辅助端点实际生效配置（未启用或无配置 → 用主端点）
function auxEffective() {
  if (State.aux.enabled && State.aux.baseURL && State.aux.model && State.aux.apiKey) return State.aux;
  return null;
}

function readText(file) {
  try {
    let s = fs.readFileSync(file, 'utf8');
    if ((s.match(/\uFFFD/g) || []).length > 5) {
      s = new TextDecoder('gbk').decode(fs.readFileSync(file));
    }
    return s.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  } catch (e) { return ''; }
}

// ---------- 变化驱动省 token（mtime+size 键缓存，未变不重读） ----------
// 同一文件（mtime+size 未变）复用读取结果，只有元数据变化才重读；
// hash 字段供 readHash() 生成 system 拼装缓存签名（规则/角色卡/世界观变化 → 签名变化 → 缓存失效）。
const readCache = new Map();   // file -> {key, hash, text}
function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
function readTextCached(file) {
  try {
    const st = fs.statSync(file);
    const key = file + ':' + st.mtimeMs + ':' + st.size;
    const hit = readCache.get(file);
    if (hit && hit.key === key) return hit.text;
    const text = readText(file);
    if (readCache.size > 200) {
      const first = readCache.keys().next().value;
      if (first) readCache.delete(first);
    }
    readCache.set(file, { key, hash: hashText(text), text });
    return text;
  } catch (e) { return readText(file); }
}
function readHash(file) {
  const hit = readCache.get(file);
  return hit ? hit.hash : hashText(readTextCached(file));
}
function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}

// ===== 分区：数据访问层（store）=====
// P-1 同步 I/O 异步化（镜像自正式版，方案 A）：热路径文件读写经此层走 fs.promises 异步 + 按文件键串行写队列；
// 冷路径（启动加载/低频配置保存）保持同步不动。RW_ASYNC_IO=0 → 调用点回退原同步路径（应急回退）。
const RW_ASYNC_IO = process.env.RW_ASYNC_IO !== '0';
// 读 JSON：失败（不存在/损坏）返回 null，不抛
async function readJson(file) {
  try {
    const s = await fs.promises.readFile(file, 'utf8');
    return JSON.parse(s);
  } catch (e) { return null; }
}
// 原子写 JSON：先写 .tmp 再 rename 覆盖——写中途失败/断电只留 .tmp，正式文件始终完整。
// space 参数保持各调用点原序列化格式（0 = 紧凑，2 = 缩进两格），数据文件格式零变化。
async function writeJson(file, obj, space = 0) {
  const tmp = file + '.tmp';
  const data = space ? JSON.stringify(obj, null, space) : JSON.stringify(obj);
  try {
    await fs.promises.writeFile(tmp, data, 'utf8');
    await fs.promises.rename(tmp, file);
  } catch (e) {
    // 写失败/rename 失败时清理 .tmp 残留，避免下次原子写前积累脏文件
    try { await fs.promises.unlink(tmp); } catch (_) { /* .tmp 不存在或已清理 */ }
    throw e;
  }
}
// 追加一行（行尾换行由调用方自带，保持 jsonl 逐字节格式）
async function appendLine(file, line) {
  await fs.promises.appendFile(file, line, 'utf8');
}
// 按文件键串行写队列：同键任务链式排队，前任务失败不阻塞后续；返回任务自身 Promise。
const storeQueues = new Map();   // key -> 队尾 Promise
function writeQueued(key, fn) {
  const prev = storeQueues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);   // 前一任务失败也继续执行下一任务
  const tail = run.then(() => {}, () => {});   // 队尾屏蔽 rejection
  storeQueues.set(key, tail);
  tail.then(() => { if (storeQueues.get(key) === tail) storeQueues.delete(key); }, () => {});   // 空闲清键
  return run;
}
// 目录元数据列表：readdir + 逐个 stat（mtime+size），供元数据缓存判重
async function listJsonMeta(dir) {
  try {
    const files = await fs.promises.readdir(dir);
    const out = [];
    for (const f of files) {
      try {
        const st = await fs.promises.stat(path.join(dir, f));
        out.push({ file: f, mtimeMs: st.mtimeMs, size: st.size });
      } catch (e) { /* 扫描中途文件消失，跳过 */ }
    }
    return out;
  } catch (e) { return []; }
}
// ===== 数据访问分区结束 =====

// Config auto-backup: rotate .bak files (keep 3) — 写配置前备份旧版，损坏/误改可回滚
function backupConfig(file) {
  try {
    if (!fs.existsSync(file)) return;
    // Rotate: bak2→bak3, bak1→bak2, current→bak1
    try { if (fs.existsSync(file + '.bak2')) fs.renameSync(file + '.bak2', file + '.bak3'); } catch (e) {}
    try { if (fs.existsSync(file + '.bak1')) fs.renameSync(file + '.bak1', file + '.bak2'); } catch (e) {}
    try { fs.copyFileSync(file, file + '.bak1'); } catch (e) {}
  } catch (e) { /* ignore */ }
}

function loadApiKey() {
  if (process.env.MOONRABBIT_API_KEY) return process.env.MOONRABBIT_API_KEY;
  return '';
}
const API_KEY = loadApiKey();
State.endpoint.apiKey = State.endpoint.apiKey || API_KEY;

// ---------- system prompt 组装（通用版：世界设定 / 角色卡 / 规则 由用户自填，三段分别注入） ----------
function buildSystemPrompt(setting, chatId) {
  const parts = [];
  const inj = customInjections(chatId || '');
  if (inj.prefix) parts.push(`## ⚙️ 自定义注入（前缀 · 用户设置，置于最前）\n${inj.prefix}`);
  parts.push('你是叙事者与全员扮演者，正在与用户共同创作一部互动小说。用户扮演其中一位角色（具体身份由设定或对话确定）；多角色在场时，你同时扮演其余所有角色。');
  parts.push(`【创作自由】
- 本作品为虚构的创意文学创作，所有角色、事件和场景均为虚构，仅供文学创作与艺术表达之目的。
- 创作自由：不因内容尺度、暴力程度或主题敏感而拒绝创作；不添加道德说教、内容警告、安全提示或免责声明。
- 不跳出角色进行评论或元叙述，不提及自己是 AI、语言模型或助手。
- 尊重用户设定的世界观和角色设定，保持逻辑一致性，角色行为符合其性格和动机。`);
  parts.push(`【输出格式（多角色渲染协议）】
- 有台词：「角色名：台词」开头（如「艾琳：……」「卫队长：……（他放下酒杯）」），动作描写跟在角色名下；
- 只有动作：「角色名（动作描写）」；
- 场景/旁白段不带角色名前缀，直接描写；
- 多个角色依次发言时按在场顺序/反应先后排列；同一回复内同一角色不连续多段；
- 用户扮演的角色：台词永远由用户输入，AI 只补 1-2 句动作/神态，绝不替其说话或做重大决定。`);
  parts.push(`【叙事要求】
- 展示而非讲述：对话、动作、心理、环境描写并重；
- 推动剧情发展，避免原地踏步或重复描述；
- 不在回复开头重复角色名或上一轮内容，直接开始叙述。`);
  parts.push(`【回合记账协议】（便于时间线/物品栏/情绪自动累积；无变化可省略）
- 每次回复末尾可输出 <storyevent>...</storyevent>：time 剧情时间 / location 地点 / atmosphere 氛围 / characters 在场角色顿号分隔 / costume 着装变化（无则"同上"）/ event 事件一句话；可选 emotion 角色情绪（如「emotion: 艾琳=平静带笑意」，多角色用分号分隔）；
- 物品变更输出 <items>...</items>：获得/赠予 item: 物品名=持有者、消耗/丢失 item-: 物品名，一行一个；
- 状态更新可输出【更新】条目：如「【更新】当前视角：艾琳」。`);
  if (setting && setting.world && setting.world.trim()) {
    parts.push(`【世界设定】（用户填写，以此为准）\n${setting.world.trim()}`);
  } else {
    parts.push('【世界设定】（用户尚未填写；从对话上下文逐步建立设定，不臆造未提及的内容）');
  }
  if (setting && setting.chars && setting.chars.trim()) {
    parts.push(`【角色卡】（用户填写，角色设定以此为准；逐段对应各角色，按需参考）\n${setting.chars.trim()}`);
  }
  if (setting && setting.rules && setting.rules.trim()) {
    parts.push(`【规则】（用户填写，必须遵守）\n${setting.rules.trim()}`);
  }
  if (setting && setting.extra && setting.extra.trim()) {
    parts.push(`## 补充资料（用户临时附加，核对细节时以此为准）\n${setting.extra.trim()}`);
  }
  // 当前换装注入（开关控制）
  if (State.storyMemoryConfig.wardrobe !== false) {
    const wardrobe = buildCurrentWardrobe(chatId || '');
    const wdKeys = Object.keys(wardrobe);
    if (wdKeys.length) {
      const wdText = wdKeys.map(k => `${k}：${wardrobe[k]}`).join('\n');
      parts.push(`## 当前着装（每轮参考，描述角色外观时以此为准）\n${wdText}`);
    }
  }
  // 当前物品栏注入（开关控制）
  if (State.storyMemoryConfig.inventory !== false) {
    const inv = buildInventory(chatId || '');
    if (inv.inventory?.length) {
      const invText = inv.inventory.map(i => `${i.name}${i.count > 1 ? ` ×${i.count}` : ''}${i.holder ? `（${i.holder}）` : ''}`).join('、');
      parts.push(`## 当前物品栏\n${invText}`);
    }
  }
  const enabledNames = toolsEnabled(chatId || '');
  if (enabledNames.length) {
    parts.push('【工具（已开启：' + enabledNames.map((n) => BRIDGE_TOOL_LABELS[n] || n).join('、') + '）】当用户明确要求「联网/搜索/查一下」时，必须先调用 web_search 工具，得到结果后再回答；禁止跳过或编造；工具结果需标注来源。');
  }
  if (inj.suffix) parts.push(`## ⚙️ 自定义注入（后缀 · 用户设置，置于最末）\n${inj.suffix}`);
  // 【标签生成强化】（近因效应，提升 Flash 等小模型遵从率）
  parts.push(`【⚠️ 标签生成（每次回复必须，不可省略）】
每次回复的最后一行必须输出以下标签（即使无变化也要输出，用"同上"代替）：
\`\`\`
<storyevent>time: 剧情时间; location: 地点; atmosphere: 氛围; characters: 角色A、角色B; costume: 角色：着装; event: 事件一句话; emotion: 角色A=情绪</storyevent>
<items>item: 物品名=持有者
item-: 物品名</items>
\`\`\`
示例（照此格式输出）：
\`\`\`
<storyevent>time: 第3天 中午; location: 酒馆; atmosphere: 温馨; characters: 艾琳、卫队长; costume: 艾琳：米白针织衫+百褶裙; event: 在酒馆吃午饭，聊起旅途计划; emotion: 艾琳=平静</storyevent>
<items>无</items>
\`\`\`
- costume：仅当着装变化时写具体，否则写"同上"
- emotion：写出角色当前情绪
- items：无物品变化写"无"`);
  let raw = parts.join('\n\n---\n\n');
  // 变量模板替换
  const safeChatId = chatId ? sanitizeId(chatId) : '';
  const chatFile = safeChatId ? path.join(DATA_DIR, 'chats', `${safeChatId}.json`) : null;
  let turnCount = 0;
  let lastMessage = '';
  let chatMessages = [];
  if (chatFile && fs.existsSync(chatFile)) {
    try {
      const chat = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
      chatMessages = chat.messages || [];
      turnCount = chatMessages.length;
      const userMsgs = chatMessages.filter(m => m.role === 'user');
      lastMessage = userMsgs.length ? userMsgs[userMsgs.length - 1].content : '';
    } catch (e) { /* 忽略 */ }
  }
  // 设定触发器注入（可通过【排除设定触发器】标记跳过；配置档 flags 已瘦身移除，2026-08-26）
  const skipLore = /【排除设定触发器】/.test(noteText(chatId || ''));
  const lorebookResult = (!skipLore) ? scanLorebook(chatMessages, lastMessage, State.endpoint.maxContext) : { entries: [] };
  if (lorebookResult.entries.length) {
    const lorebookText = lorebookResult.entries.map(e => `[${e.name}]\n${e.content}`).join('\n\n---\n\n');
    raw += '\n\n---\n\n## 设定触发器（关键词匹配注入）\n' + lorebookText;
  }
  // 旁注注入（位置感知）
  const annotations = loadAnnotations(chatId || '');
  const activeAnnotations = (annotations.notes || []).filter(n => n.enabled);
  if (activeAnnotations.length) {
    const annText = activeAnnotations.map(n => `[旁注·第${n.position}条消息后] ${n.content}`).join('\n');
    raw += '\n\n---\n\n## 旁注（位置感知引导）\n' + annText;
  }
  const user = State.personas[State.activePersona]?.name || '';
  return applyVariables(raw, { user, char: '', chatId: chatId || '', turnCount, lastMessage });
}

// ---------- 回合记账数据层（按会话隔离） ----------
const DATA_DIR = path.join(WWW, 'data');
const TURNS_DIR = path.join(DATA_DIR, 'turns');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TURNS_DIR, { recursive: true });

// ---------- 对话配置档系统（简化版：prefix + firstMsg，无 flags） ----------
const CHAT_PROFILES_FILE = path.join(DATA_DIR, 'chat-profiles.json');
const BUILTIN_CHAT_PROFILES = {
  main: { label: '默认', color: '#639922', isDefault: true, firstMsg: '' },
};
State.chatProfiles = {};
function loadChatProfiles() {
  try {
    const raw = JSON.parse(fs.readFileSync(CHAT_PROFILES_FILE, 'utf8'));
    State.chatProfiles = { ...BUILTIN_CHAT_PROFILES, ...(raw.profiles || {}) };
  } catch (e) {
    State.chatProfiles = { ...BUILTIN_CHAT_PROFILES };
    saveChatProfiles();
  }
}
function saveChatProfiles() {
  const custom = {};
  for (const [k, v] of Object.entries(State.chatProfiles)) if (!BUILTIN_CHAT_PROFILES[k]) custom[k] = v;
  try { backupConfig(CHAT_PROFILES_FILE); fs.writeFileSync(CHAT_PROFILES_FILE, JSON.stringify({ profiles: { ...BUILTIN_CHAT_PROFILES, ...custom }, version: 1 }, null, 2), 'utf8'); } catch (e) { console.error('保存配置档失败:', e.message); }
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
loadChatProfiles();

// ---------- 变量模板（{{user}} {{char}} {{time}} 等自动替换） ----------
function applyVariables(text, context) {
  const now = new Date();
  return String(text || '')
    .replace(/\{\{user\}\}/g, context.user || '')
    .replace(/\{\{char\}\}/g, context.char || '')
    .replace(/\{\{time\}\}/g, now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
    .replace(/\{\{date\}\}/g, now.toISOString().slice(0, 10))
    .replace(/\{\{chatId\}\}/g, context.chatId || '')
    .replace(/\{\{turnCount\}\}/g, String(context.turnCount || 0))
    .replace(/\{\{lastMessage\}\}/g, (context.lastMessage || '').slice(0, 100));
}

// ---------- NPC 档案（独立追踪） ----------
const NPC_PROFILES_DIR = path.join(DATA_DIR, 'npc-profiles');
fs.mkdirSync(NPC_PROFILES_DIR, { recursive: true });
function loadNpcProfile(name) {
  try { const f = path.join(NPC_PROFILES_DIR, `${name}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { return null; }
}
function saveNpcProfile(name, data) {
  try { backupConfig(path.join(NPC_PROFILES_DIR, `${name}.json`)); fs.writeFileSync(path.join(NPC_PROFILES_DIR, `${name}.json`), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('保存角色档案失败:', name, e.message); }
}
function listNpcProfiles() {
  try { return fs.readdirSync(NPC_PROFILES_DIR).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(NPC_PROFILES_DIR, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; }
}

// ---------- 场景档案（地点固定物理特征） ----------
const SCENES_DIR = path.join(DATA_DIR, 'scenes');
fs.mkdirSync(SCENES_DIR, { recursive: true });
function loadScene(name) {
  try { const f = path.join(SCENES_DIR, `${name}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { return null; }
}
function saveScene(name, data) {
  try { backupConfig(path.join(SCENES_DIR, `${name}.json`)); fs.writeFileSync(path.join(SCENES_DIR, `${name}.json`), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('保存场景档案失败:', name, e.message); }
}
function listScenes() {
  try { return fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(SCENES_DIR, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; }
}

// ---------- 表情系统 ----------
const EXPRESSIONS_DIR = path.join(DATA_DIR, 'expressions');
fs.mkdirSync(EXPRESSIONS_DIR, { recursive: true });
const EXPRESSION_CONFIG = path.join(EXPRESSIONS_DIR, '_config.json');
const DEFAULT_EMOTION_MAP = { '开心': '开心', '高兴': '开心', '快乐': '开心', '悲伤': '悲伤', '难过': '悲伤', '生气': '生气', '愤怒': '生气', '惊讶': '惊讶', '害羞': '害羞', '脸红': '害羞', '默认': '默认' };
State.emotionMap = { ...DEFAULT_EMOTION_MAP };
State.enableAutoSwitch = true;
function loadExpressionConfig() { try { const r = JSON.parse(fs.readFileSync(EXPRESSION_CONFIG, 'utf8')); State.emotionMap = { ...DEFAULT_EMOTION_MAP, ...(r.emotionMap || {}) }; State.enableAutoSwitch = r.enableAutoSwitch !== false; } catch (e) { /* 默认 */ } }
function saveExpressionConfig() { try { fs.writeFileSync(EXPRESSION_CONFIG, JSON.stringify({ emotionMap: State.emotionMap, enableAutoSwitch: State.enableAutoSwitch }, null, 2), 'utf8'); } catch (e) { console.error('保存表情配置失败:', e.message); } }
loadExpressionConfig();
function getExpressionPath(charName, emotion) {
  const mapped = State.emotionMap[emotion] || State.emotionMap['默认'] || '默认';
  const dir = path.join(EXPRESSIONS_DIR, charName);
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) { if (fs.existsSync(path.join(dir, mapped + ext))) return `/api/expressions/static/${encodeURIComponent(charName)}/${encodeURIComponent(mapped + ext)}`; }
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) { if (fs.existsSync(path.join(dir, '默认' + ext))) return `/api/expressions/static/${encodeURIComponent(charName)}/${encodeURIComponent('默认' + ext)}`; }
  return null;
}
function listExpressions(charName) {
  try { const d = path.join(EXPRESSIONS_DIR, charName); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f)).map(f => ({ name: f.replace(/\.[^.]+$/, ''), file: f, url: `/api/expressions/static/${encodeURIComponent(charName)}/${encodeURIComponent(f)}` })) : []; } catch (e) { return []; }
}

// ---------- 输出过滤器 ----------
const REGEX_RULES_FILE = path.join(DATA_DIR, 'regex-rules.json');
State.regexRules = [];
function loadRegexRules() { try { const r = JSON.parse(fs.readFileSync(REGEX_RULES_FILE, 'utf8')); State.regexRules = Array.isArray(r.rules) ? r.rules : []; } catch (e) { State.regexRules = []; } }
function saveRegexRules() { try { backupConfig(REGEX_RULES_FILE); fs.writeFileSync(REGEX_RULES_FILE, JSON.stringify({ rules: State.regexRules, version: 1 }, null, 2), 'utf8'); } catch (e) { console.error('保存正则规则失败:', e.message); } }
loadRegexRules();
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

// ---------- 设定触发器（Lorebook） ----------
const LOREBOOK_FILE = path.join(DATA_DIR, 'lorebook.json');
State.lorebookEntries = {};
State.lorebookSettings = { enabled: true, tokenBudget: 'auto', maxBudget: 10000, budgetRatio: 0.1 };
function loadLorebook() { try { const r = JSON.parse(fs.readFileSync(LOREBOOK_FILE, 'utf8')); State.lorebookEntries = r.entries || {}; if (r.settings) State.lorebookSettings = { ...State.lorebookSettings, ...r.settings }; } catch (e) { State.lorebookEntries = {}; } }
function saveLorebook() { try { backupConfig(LOREBOOK_FILE); fs.writeFileSync(LOREBOOK_FILE, JSON.stringify({ entries: State.lorebookEntries, settings: State.lorebookSettings, version: 1 }, null, 2), 'utf8'); } catch (e) { console.error('保存设定触发器失败:', e.message); } }
loadLorebook();
function scanLorebook(messages, userInput, maxContext) {
  // 整体开关：设定触发器被禁用时直接不注入
  if (State.lorebookSettings.enabled === false) return { entries: [], totalTokens: 0, budget: 0, matched: 0, disabled: true };
  const budget = State.lorebookSettings.tokenBudget === 'auto' ? Math.floor((maxContext || 1048576) * State.lorebookSettings.budgetRatio) : State.lorebookSettings.tokenBudget === 'unlimited' ? Infinity : Number(State.lorebookSettings.tokenBudget) || 10000;
  const recentText = (messages || []).slice(-10).map(m => String(m.content || '')).join('\n') + '\n' + (userInput || '');
  const matched = []; const seen = new Set();
  for (const [id, e] of Object.entries(State.lorebookEntries)) { if (!e.enabled) continue; if (e.constant) { matched.push({ id, ...e }); seen.add(id); } }
  for (const [id, e] of Object.entries(State.lorebookEntries)) { if (!e.enabled || e.constant || seen.has(id)) continue; const kws = e.keywords || []; const hit = (e.matchMode || 'any') === 'any' ? kws.some(k => k.length >= 2 && recentText.includes(k)) : kws.every(k => k.length >= 2 && recentText.includes(k)); if (hit) { matched.push({ id, ...e }); seen.add(id); } }
  matched.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  // 应用 token 预算：常驻条目豁免（始终注入），仅关键词条目受预算截断
  let total = 0; const result = [];
  const constantEntries = matched.filter(e => e.constant);
  const keywordEntries = matched.filter(e => !e.constant);
  for (const e of constantEntries) { const t = Math.ceil(String(e.content || '').length * 0.67); result.push(e); total += t; }
  for (const e of keywordEntries) { const t = Math.ceil(String(e.content || '').length * 0.67); if (total + t > budget) break; total += t; result.push(e); }
  return { entries: result, totalTokens: total, budget, matched: matched.length };
}

// ---------- 关系图谱 ----------
const GRAPH_FILE = path.join(DATA_DIR, 'graph.json');
State.graphData = { nodes: [], edges: [], version: 1 };
function loadGraph() { try { State.graphData = JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8')); if (!State.graphData.nodes) State.graphData.nodes = []; if (!State.graphData.edges) State.graphData.edges = []; } catch (e) { State.graphData = { nodes: [], edges: [], version: 1 }; } }
function saveGraph() { try { backupConfig(GRAPH_FILE); fs.writeFileSync(GRAPH_FILE, JSON.stringify(State.graphData, null, 2), 'utf8'); } catch (e) { console.error('保存关系图谱失败:', e.message); } }
loadGraph();

// ---------- 玩家身份（Persona） ----------
const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');
State.personas = {};
State.activePersona = '';
function loadPersonas() { try { const r = JSON.parse(fs.readFileSync(PERSONAS_FILE, 'utf8')); State.personas = r.personas || {}; State.activePersona = r.active || ''; } catch (e) { State.personas = {}; State.activePersona = ''; } }
function savePersonas() { try { backupConfig(PERSONAS_FILE); fs.writeFileSync(PERSONAS_FILE, JSON.stringify({ personas: State.personas, active: State.activePersona }, null, 2), 'utf8'); } catch (e) { console.error('保存玩家身份失败:', e.message); } }
loadPersonas();

// ---------- 剧情备忘（Agenda） ----------
const AGENDA_DIR = path.join(DATA_DIR, 'agenda');
fs.mkdirSync(AGENDA_DIR, { recursive: true });
function loadAgenda(chatId) { chatId = sanitizeId(chatId); try { const f = path.join(AGENDA_DIR, `${chatId}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { items: [] }; } catch (e) { return { items: [] }; } }
function saveAgenda(chatId, data) { chatId = sanitizeId(chatId); try { backupConfig(path.join(AGENDA_DIR, `${chatId}.json`)); fs.writeFileSync(path.join(AGENDA_DIR, `${chatId}.json`), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('保存剧情备忘失败:', chatId, e.message); } }

// ---------- 报告系统 ----------
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
fs.mkdirSync(REPORTS_DIR, { recursive: true });
function listReports(chatId) { try { const d = path.join(REPORTS_DIR, sanitizeId(chatId)); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.md')).map(f => ({ filename: f, ts: f.replace('.md', '') })).sort((a, b) => b.ts.localeCompare(a.ts)) : []; } catch (e) { return []; } }
function saveReport(chatId, type, content) { try { const d = path.join(REPORTS_DIR, sanitizeId(chatId)); fs.mkdirSync(d, { recursive: true }); const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); const fn = `${type}_${ts}.md`; fs.writeFileSync(path.join(d, fn), content, 'utf8'); const files = fs.readdirSync(d).filter(f => f.endsWith('.md')).sort(); while (files.length > 20) { try { fs.unlinkSync(path.join(d, files.shift())); } catch (e) {} } return fn; } catch (e) { return null; } }

// ---------- 旁注（位置感知注入） ----------
const ANNOTATIONS_DIR = path.join(DATA_DIR, 'annotations');
fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true });
function loadAnnotations(chatId) { chatId = sanitizeId(chatId); try { const f = path.join(ANNOTATIONS_DIR, `${chatId}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { notes: [] }; } catch (e) { return { notes: [] }; } }
function saveAnnotations(chatId, data) { chatId = sanitizeId(chatId); try { backupConfig(path.join(ANNOTATIONS_DIR, `${chatId}.json`)); fs.writeFileSync(path.join(ANNOTATIONS_DIR, `${chatId}.json`), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('保存旁注失败:', chatId, e.message); } }

// ---------- 调试：最近提示词记录（查看每轮发给 AI 的 system prompt） ----------
const PROMPT_DIR = path.join(DATA_DIR, 'prompts');
fs.mkdirSync(PROMPT_DIR, { recursive: true });
State.lastPrompt = { chatId: '', ts: '', system: '', historyCount: 0, tools: [] };
function recordPrompt(chatId, system, historyCount) {
  State.lastPrompt = { chatId: sanitizeId(chatId), ts: new Date().toISOString(), system, historyCount: historyCount || 0, tools: toolsEnabled(chatId) };
  const file = path.join(PROMPT_DIR, `${State.lastPrompt.chatId}.jsonl`);
  const line = JSON.stringify({ ts: State.lastPrompt.ts, historyCount: State.lastPrompt.historyCount, tools: State.lastPrompt.tools, system });
  if (RW_ASYNC_IO) {
    return writeQueued(file, async () => {
      try {
        await appendLine(file, line + '\n');
        const lines = (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean);
        if (lines.length > 30) await fs.promises.writeFile(file, lines.slice(-30).join('\n') + '\n', 'utf8');
      } catch (e) { /* 忽略 */ }
    }).catch(() => {});
  }
  try {
    fs.appendFileSync(file, line + '\n', 'utf8');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 30) fs.writeFileSync(file, lines.slice(-30).join('\n') + '\n', 'utf8');
  } catch (e) { /* 忽略 */ }
}

function sanitizeId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'default'; }
// 文件名单消毒：剥离路径分隔符与穿越字符（允许中文等 UTF-8 字符，仅禁止路径穿越），防目录穿越
function sanitizeFileName(name, maxLen = 80) {
  return String(name || '')
    .replace(/[\\/]/g, '_')        // 分隔符 → 下划线
    .replace(/\.\.+/g, '_')         // `..`/`...` 穿越 → 下划线
    .replace(/[\x00-\x1f]/g, '')     // 控制字符
    .replace(/[:*?"<>|]/g, '_')      // Windows 文件系统不允许的字符
    .trim().slice(0, maxLen);
}
function turnsFile(chatId) { return path.join(TURNS_DIR, `${sanitizeId(chatId)}.jsonl`); }
// 分词器（语义回忆用）：中英文分词 + 小写化 + 停用词过滤
function tokenize(text) {
  const STOP_WORDS = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '不', '就', '也', '都', '和', '与', '及', '或', '但', '而', '把', '被', '让', '给', '对', '从', '到', '会', '能', '可以', '要', '想', '说', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'my', 'your', 'our', 'i', 'you', 'we', 'me', 'us', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'if', 'then', 'so', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'into', 'about', 'like', 'through', 'after', 'before', 'between', 'without', 'not', 'no', 'very', 'too', 'just', 'also', 'more', 'most', 'other', 'some', 'any', 'all', 'each', 'every', 'both', 'few', 'same', 'own', 'than', 'up', 'out', 'off', 'over', 'again', 'here', 'there', 'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom']);
  return String(text || '')
    .toLowerCase()
    .replace(/[\u4e00-\u9fff]/g, m => ' ' + m + ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}

// 端点配置持久化（覆盖启动时的默认值；含自定义 API 设置 + 辅助 API）
const MODEL_FILE = path.join(DATA_DIR, 'model.json');
try {
  const m = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
  if (m.protocol === 'anthropic' || m.protocol === 'openai') State.endpoint.protocol = m.protocol;
  if (m.baseURL && typeof m.baseURL === 'string' && m.baseURL.trim()) State.endpoint.baseURL = m.baseURL.trim().replace(/\/+$/, '');
  if (m.apiKey && typeof m.apiKey === 'string' && m.apiKey.trim()) State.endpoint.apiKey = m.apiKey.trim();
  if (m.model && typeof m.model === 'string' && m.model.trim()) State.endpoint.model = m.model.trim();
  if (Number.isFinite(m.maxTokens) && m.maxTokens >= 256 && m.maxTokens <= 393216) State.endpoint.maxTokens = m.maxTokens;
  if (['auto', 'disabled', 'low', 'medium', 'high', 'max', 'custom'].includes(m.thinking)) State.endpoint.thinking = m.thinking;
  else if (m.thinking === 'enabled') State.endpoint.thinking = 'high';   // 旧「开启」→ 深度思考档
  if (Number.isFinite(m.thinkingBudget) && m.thinkingBudget >= 256 && m.thinkingBudget <= 393216) State.endpoint.thinkingBudget = m.thinkingBudget;
  if (Number.isFinite(m.maxContext) && m.maxContext >= 0 && m.maxContext <= 1048576) State.endpoint.maxContext = m.maxContext;
  if (typeof m.autoSummary === 'boolean') State.endpoint.autoSummary = m.autoSummary;
  if (Number.isFinite(m.autoSummaryThreshold) && m.autoSummaryThreshold >= 2000 && m.autoSummaryThreshold <= 100000) State.endpoint.autoSummaryThreshold = m.autoSummaryThreshold;
  // 辅助 API（后台任务独立端点）
  if (m.aux && typeof m.aux === 'object') {
    if (typeof m.aux.enabled === 'boolean') State.aux.enabled = m.aux.enabled;
    if (m.aux.protocol === 'anthropic' || m.aux.protocol === 'openai') State.aux.protocol = m.aux.protocol;
    if (m.aux.baseURL && typeof m.aux.baseURL === 'string' && m.aux.baseURL.trim()) State.aux.baseURL = m.aux.baseURL.trim().replace(/\/+$/, '');
    if (m.aux.apiKey && typeof m.aux.apiKey === 'string' && m.aux.apiKey.trim()) State.aux.apiKey = m.aux.apiKey.trim();
    if (m.aux.model && typeof m.aux.model === 'string' && m.aux.model.trim()) State.aux.model = m.aux.model.trim();
    if (typeof m.aux.fallback === 'boolean') State.aux.fallback = m.aux.fallback;
  }
} catch (e) { /* 首次使用 */ }

const THINK_BUDGET = { low: 4096, medium: 8192, high: 32768, max: 65536 };  // 思考强度档位 → 预算 token（custom 用 thinkingBudget 字段）

// DeepSeek 定价（官方，每 1M token）——仅估算用，非账单依据
const PRICE_TABLE = {
  'deepseek-chat': { input: 1, output: 2, cacheHit: 0.1 },
  'deepseek-v4-flash': { input: 1, output: 2, cacheHit: 0.1 },
  'deepseek-v4-pro': { input: 4, output: 16, cacheHit: 0.4 },
  'default': { input: 2, output: 8, cacheHit: 0.2 },
};
function priceFor(model) { return PRICE_TABLE[model] || PRICE_TABLE['default']; }
// 估算费用（元）：缓存命中 token 按 cacheHit 单价，其余输入按 input 单价，输出按 output 单价
function estimateCost(bucket, model) {
  const p = priceFor(model);
  const cacheTotal = (bucket.cacheRead || 0) + (bucket.cacheMiss || 0);
  const inCost = cacheTotal > 0
    ? ((bucket.cacheMiss || 0) / 1e6) * p.input + ((bucket.cacheRead || 0) / 1e6) * p.cacheHit
    : ((bucket.tokensIn || 0) / 1e6) * p.input;   // 旧数据无缓存字段 → 全按输入价
  return inCost + ((bucket.tokensOut || 0) / 1e6) * p.output;
}

// ---------- API 采样预设（命名预设：保存/切换/删除；参数随预设保存） ----------
const PRESET_FILE = path.join(DATA_DIR, 'presets.json');
const BUILTIN_PRESETS = {
  'DeepSeek 默认（官方参数）': { temperature: 1.0, top_p: 1.0, top_k: 0, presence_penalty: 0, frequency_penalty: 0, maxTokens: 393216, maxContext: 1048576 },
  'RP 创作（社区向）': { temperature: 1.5, top_p: 0.9, top_k: 40, presence_penalty: 0, frequency_penalty: 0, maxTokens: 393216, maxContext: 1048576 },
  '省 token 快速': { temperature: 1.0, top_p: 1.0, top_k: 0, presence_penalty: 0, frequency_penalty: 0, maxTokens: 2048, maxContext: 32000 },
};
State.presets = JSON.parse(JSON.stringify(BUILTIN_PRESETS));
State.activePreset = 'DeepSeek 默认（官方参数）';
// 当前生效采样参数（null = 不传，用 API 默认）
State.samplers = { temperature: null, top_p: null, top_k: null, presence_penalty: null, frequency_penalty: null };
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
  try { backupConfig(PRESET_FILE); fs.writeFileSync(PRESET_FILE, JSON.stringify({ custom, active: State.activePreset }, null, 2), 'utf8'); } catch (e) { console.error('保存预设失败:', e.message); }
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
try {
  const pj = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'));
  if (pj.custom && typeof pj.custom === 'object') for (const [k, v] of Object.entries(pj.custom)) State.presets[k] = normPreset(v || {});
  if (pj.active && State.presets[pj.active]) State.activePreset = pj.active;
} catch (e) { /* 首次使用 */ }
applyPreset(State.activePreset);

// ---------- 配置档案（Profile：端点 + 模型 + 参数整套配置一键切换） ----------
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const BUILTIN_PROFILES = {
  'DeepSeek 官方': { protocol: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-chat', thinking: 'auto', maxTokens: 393216, maxContext: 1048576, preset: 'DeepSeek 默认（官方参数）', desc: '官方直连（高峰时段加价）' },
  'DeepSeek 官方·Reasoner': { protocol: 'openai', baseURL: 'https://api.deepseek.com', model: 'deepseek-reasoner', thinking: 'auto', maxTokens: 393216, maxContext: 1048576, preset: 'DeepSeek 默认（官方参数）', desc: '官方直连推理模型' },
  '硅基流动': { protocol: 'openai', baseURL: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', thinking: 'auto', maxTokens: 8192, maxContext: 65536, preset: 'DeepSeek 默认（官方参数）', desc: '硅基流动 V3（按量计费）' },
  '本地 Ollama': { protocol: 'openai', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:14b', thinking: 'disabled', maxTokens: 4096, maxContext: 32768, desc: '本地 Ollama（无需 Key）' },
};
State.profiles = {};
State.activeProfile = '';
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
function saveProfiles() {
  const custom = {};
  for (const [k, v] of Object.entries(State.profiles)) if (!BUILTIN_PROFILES[k]) custom[k] = v;
  try { backupConfig(PROFILES_FILE); fs.writeFileSync(PROFILES_FILE, JSON.stringify({ custom, active: State.activeProfile }, null, 2), 'utf8'); } catch (e) { console.error('保存配置档案失败:', e.message); }
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
  if (p.baseURL) State.endpoint.baseURL = p.baseURL.replace(/\/+$/, '');
  if (p.model) State.endpoint.model = p.model;
  // 优先取该端点的记忆 Key，未记忆则沿用当前值（档案本身不存 Key）
  if (State.keyMemo.by[State.endpoint.baseURL]) State.endpoint.apiKey = State.keyMemo.by[State.endpoint.baseURL];
  if (['auto', 'disabled', 'low', 'medium', 'high', 'max', 'custom'].includes(p.thinking)) State.endpoint.thinking = p.thinking;
  if (Number.isFinite(p.thinkingBudget) && p.thinkingBudget >= 256) State.endpoint.thinkingBudget = p.thinkingBudget;
  if (Number.isFinite(p.maxTokens) && p.maxTokens >= 256) State.endpoint.maxTokens = p.maxTokens;
  if (Number.isFinite(p.maxContext) && p.maxContext >= 0) State.endpoint.maxContext = p.maxContext;
  if (typeof p.autoSummary === 'boolean') State.endpoint.autoSummary = p.autoSummary;
  if (Number.isFinite(p.autoSummaryThreshold) && p.autoSummaryThreshold >= 2000) State.endpoint.autoSummaryThreshold = p.autoSummaryThreshold;
  if (p.aux && typeof p.aux === 'object') {
    if (typeof p.aux.enabled === 'boolean') State.aux.enabled = p.aux.enabled;
    if (p.aux.protocol === 'anthropic' || p.aux.protocol === 'openai') State.aux.protocol = p.aux.protocol;
    if (p.aux.baseURL && p.aux.baseURL.trim()) State.aux.baseURL = p.aux.baseURL.trim().replace(/\/+$/, '');
    if (State.keyMemo.auxBy[State.aux.baseURL]) State.aux.apiKey = State.keyMemo.auxBy[State.aux.baseURL];
    if (p.aux.model && p.aux.model.trim()) State.aux.model = p.aux.model.trim();
    if (typeof p.aux.fallback === 'boolean') State.aux.fallback = p.aux.fallback;
  }
  if (p.preset && State.presets[p.preset]) applyPreset(p.preset);
  // 同步 model.json（写盘失败不阻塞端点切换；下次保存会再试）
  try {
    backupConfig(MODEL_FILE);
    fs.writeFileSync(MODEL_FILE, JSON.stringify({
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
loadProfiles();

// ---------- Key 按端点自动记忆（keyMemo.json：端点 baseURL → API Key） ----------
// 目标：切换配置档案不再每次重填 Key。第一次在某端点保存 Key 后自动记忆，
// 之后切到该端点的档案自动带上对应 Key；全新端点首次切换沿用当前 Key
// （在 API 设置里填一次即自动记忆）。Key 只存本地 data/（不入 git，与 model.json
// 同样处理）；档案本身仍不存 Key（安全约定保留）。
const KEY_MEMO_FILE = path.join(DATA_DIR, 'keyMemo.json');
State.keyMemo = { by: {}, auxBy: {} };   // by: 主端点 baseURL→key；auxBy: 辅助端点 baseURL→key
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
function saveKeyMemo() {
  try {
    backupConfig(KEY_MEMO_FILE);
    fs.writeFileSync(KEY_MEMO_FILE, JSON.stringify(State.keyMemo, null, 2), 'utf8');
  } catch (e) { console.error('保存 Key 记忆失败:', e.message); }
}
loadKeyMemo();

// 解析 AI 回复中的 <storyevent>/<items>/【更新】标签 → 结构化回合记录
function parseTurnTags(content) {
  const rec = { story_time: '', location: '', atmosphere: '', characters: [], costume: '', event: '', items_gain: [], items_loss: [], updates: [], emotion: {}, character_intro: {}, relationships: [], location_detail: [] };
  const evRe = /<(?:storyevent|horaeevent)>([\s\S]*?)<\/(?:storyevent|horaeevent)>/gi;
  let m;
  while ((m = evRe.exec(content))) {
    for (const line of m[1].split('\n')) {
      // 键字符类含下划线，兼容英文蛇形标签（story_time/location 等）
      const kv = line.match(/^\s*([a-zA-Z_\u4e00-\u9fa5]+)\s*[:：]\s*(.+)$/);
      if (!kv) continue;
      const k = kv[1].toLowerCase();
      const v = kv[2].trim();
      if (k.includes('time')) rec.story_time = v;
      else if (k === 'location' || k === '场景' || k === '地点') rec.location = v;
      else if (k.includes('atmosphere')) rec.atmosphere = v;
      else if (k.includes('characters')) rec.characters = v.split(/[、,，/]+/).map((s) => s.trim()).filter(Boolean);
      else if (k.includes('costume')) rec.costume = v;
      else if (k.includes('event')) rec.event = v;
      else if (k.includes('emotion') || k.includes('mood')) {
        // emotion: 角色=情绪 / emotion: 角色：情绪（多角色用分号或换行分隔）
        for (const pair of v.split(/[;；\n]/)) {
          const pm = pair.match(/^\s*([^=：:]+)[=：:]\s*(.+)$/);
          if (pm && pm[2].trim()) rec.emotion[pm[1].trim()] = pm[2].trim();
        }
      }
      // 角色简介（character_intro: 角色名=简介；多角色用分号分隔）
      else if (k.includes('character_intro') || k.includes('characterintro') || k.includes('角色简介')) {
        for (const pair of v.split(/[;；\n]/)) {
          const pm = pair.match(/^\s*([^=：:]+)[=：:]\s*(.+)$/);
          if (pm && pm[2].trim()) rec.character_intro[pm[1].trim()] = pm[2].trim();
        }
      }
      // 关系信息（relationships: 角色A-角色B=关系类型；多条用分号分隔）
      else if (k.includes('relationships') || k.includes('关系')) {
        for (const pair of v.split(/[;；\n]/)) {
          const pm = pair.match(/^\s*([^=：:]+)[=：:]\s*(.+)$/);
          if (pm && pm[2].trim()) {
            const relParts = pm[1].trim().split(/[-—→]+/);
            if (relParts.length >= 2) {
              rec.relationships.push({ from: relParts[0].trim(), to: relParts[1].trim(), type: pm[2].trim(), description: '' });
            }
          }
        }
      }
      // 地点详细档案（location_detail: 分组| 地点名：详细描写；多条用换行分隔）
      else if (k.includes('location_detail') || k.includes('locationdetail') || k.includes('地点档案')) {
        for (const entry of v.split(/\n+/)) {
          const e = entry.trim();
          if (!e) continue;
          const barIdx = e.indexOf('|');
          const group = barIdx >= 0 ? e.slice(0, barIdx).trim() : '';
          const rest = barIdx >= 0 ? e.slice(barIdx + 1).trim() : e;
          const pm = rest.match(/^\s*([^：:]+)[：:]\s*(.+)$/);
          if (pm && pm[2].trim()) {
            rec.location_detail.push({ group: group || '未分组', name: pm[1].trim(), detail: pm[2].trim() });
          }
        }
      }
    }
  }
  const hRe = /<(?:items|horae)>([\s\S]*?)<\/(?:items|horae)>/gi;
  while ((m = hRe.exec(content))) {
    for (const line of m[1].split('\n')) {
      let im = line.match(/^\s*item-\s*[:：]\s*(.+?)\s*$/i);
      if (im) { rec.items_loss.push(im[1].trim()); continue; }
      im = line.match(/^\s*item\s*[:：]\s*([^=]+?)(?:\s*=\s*([^\s]+))?\s*$/i);
      if (im) rec.items_gain.push({ name: im[1].trim(), holder: (im[2] || '').replace(/[，,。;；]$/, '') });
    }
  }
  const upRe = /【更新】([^：:]+)[：:]\s*(.+)/g;
  while ((m = upRe.exec(content))) rec.updates.push({ entry: m[1].trim(), content: m[2].trim() });
  // 真名保密（R2）：过滤 character_intro/relationships/location_detail 中的严格机密真名
  const SECRET_NAMES = ['银卯', 'Argent Lepus', 'Lepus·Zo-El', 'Lepus', 'Zo-El', 'argent lepus', 'lepus·zo-el'];
  const sanitizeSecret = (s) => {
    let out = String(s || '');
    for (const nm of SECRET_NAMES) out = out.split(nm).join('银月');
    return out;
  };
  if (rec.character_intro && typeof rec.character_intro === 'object') {
    for (const k of Object.keys(rec.character_intro)) {
      const cleanKey = sanitizeSecret(k);
      const val = sanitizeSecret(rec.character_intro[k]);
      if (cleanKey !== k) { delete rec.character_intro[k]; rec.character_intro[cleanKey] = val; }
      else rec.character_intro[k] = val;
    }
  }
  if (Array.isArray(rec.relationships)) {
    for (const rel of rec.relationships) {
      rel.from = sanitizeSecret(rel.from);
      rel.to = sanitizeSecret(rel.to);
      rel.type = sanitizeSecret(rel.type);
      rel.description = sanitizeSecret(rel.description);
    }
  }
  if (Array.isArray(rec.location_detail)) {
    for (const loc of rec.location_detail) {
      loc.group = sanitizeSecret(loc.group);
      loc.name = sanitizeSecret(loc.name);
      loc.detail = sanitizeSecret(loc.detail);
    }
  }
  return rec;
}

async function appendTurnRecord(content, chatId, seq) {
  try {
    const rec = parseTurnTags(content);
    const hasAny = rec.story_time || rec.location || rec.atmosphere || rec.event || rec.items_gain.length || rec.items_loss.length || rec.updates.length;
    if (!hasAny) return;
    rec.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    rec.ts = new Date().toISOString();
    rec.chatId = sanitizeId(chatId);
    if (seq) rec.seq = seq;   // 关联消息序号（重roll/删除时按 seq 清理）
    const line = JSON.stringify(rec) + '\n';
    if (RW_ASYNC_IO) { await writeQueued(turnsFile(chatId), () => appendLine(turnsFile(chatId), line)); return; }
    fs.appendFileSync(turnsFile(chatId), line, 'utf8');
  } catch (e) { console.error('[turn-record] 失败:', e.message); }
}

// 按消息序号截断/删除回合记录（重roll = 删 seq>=n；删单条 = 删 seq==n）
// 只删带 seq 的记录（手动补记/操作记录无 seq，不受影响）
async function truncateTurnsBySeq(chatId, seq, mode) {
  const file = turnsFile(chatId);
  if (RW_ASYNC_IO) {
    return writeQueued(file, async () => {
      if (!(await fs.promises.stat(file).catch(() => null))) return 0;
      const lines = (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean);
      const kept = lines.filter((l) => {
        try {
          const o = JSON.parse(l);
          if (!o.seq) return true;   // 无 seq 的记录（手动/操作）保留
          if (mode === 'eq') return o.seq !== seq;
          return o.seq < seq;        // gte：删除 seq >= n
        } catch (e) { return true; }
      });
      const removed = lines.length - kept.length;
      if (removed) await fs.promises.writeFile(file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
      return removed;
    });
  }
  if (!fs.existsSync(file)) return 0;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter((l) => {
    try {
      const o = JSON.parse(l);
      if (!o.seq) return true;   // 无 seq 的记录（手动/操作）保留
      if (mode === 'eq') return o.seq !== seq;
      return o.seq < seq;        // gte：删除 seq >= n
    } catch (e) { return true; }
  });
  const removed = lines.length - kept.length;
  if (removed) fs.writeFileSync(file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  return removed;
}

function readTurns(chatId) {
  try {
    const file = turnsFile(chatId);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// 剧情记忆配置（注入开关）
const STORY_MEMORY_CONFIG_FILE = path.join(DATA_DIR, 'story-memory-config.json');
State.storyMemoryConfig = { scene: true, character: true, relationship: true, expression: false, wardrobe: true, inventory: true };
function loadStoryMemoryConfig() {
  try {
    if (fs.existsSync(STORY_MEMORY_CONFIG_FILE)) {
      State.storyMemoryConfig = { ...State.storyMemoryConfig, ...JSON.parse(fs.readFileSync(STORY_MEMORY_CONFIG_FILE, 'utf8')) };
    }
  } catch (e) { /* 使用默认值 */ }
}
function saveStoryMemoryConfig() {
  try { backupConfig(STORY_MEMORY_CONFIG_FILE); fs.writeFileSync(STORY_MEMORY_CONFIG_FILE, JSON.stringify(State.storyMemoryConfig, null, 2), 'utf8'); } catch (e) { console.error('保存剧情记忆配置失败:', e.message); }
}
loadStoryMemoryConfig();

// 构建剧情记忆注入（场景、角色、关系）
function buildStoryMemory(chatId) {
  const turns = readTurns(chatId);
  if (!turns.length) return '';
  
  // 提取最新的场景信息（最后一条有 location 的记录）
  const latestScene = [...turns].reverse().find(t => t.location);
  
  // 提取所有出现过的角色简介（character_intro）
  const allCharacterIntros = {};
  for (const t of turns) {
    if (t.character_intro && typeof t.character_intro === 'object') {
      for (const [name, intro] of Object.entries(t.character_intro)) {
        // 只保留第一次出现的简介（更详细）
        if (!allCharacterIntros[name]) allCharacterIntros[name] = intro;
      }
    }
  }
  
  // 提取所有关系信息
  const allRelationships = [];
  const seenRelKeys = new Set();
  for (const t of turns) {
    if (Array.isArray(t.relationships)) {
      for (const rel of t.relationships) {
        const key = `${rel.from}-${rel.to}`;
        if (!seenRelKeys.has(key)) {
          seenRelKeys.add(key);
          allRelationships.push(rel);
        }
      }
    }
  }
  
  // 构建注入文本（根据开关控制）
  const parts = [];
  
  // 场景信息（开关控制）
  if (State.storyMemoryConfig.scene && latestScene && latestScene.location) {
    let sceneText = `当前场景：${latestScene.location}`;
    if (latestScene.atmosphere) sceneText += `（${latestScene.atmosphere}）`;
    parts.push(sceneText);
  }
  
  // 角色简介（开关控制）
  if (State.storyMemoryConfig.character) {
    const characterNames = Object.keys(allCharacterIntros);
    if (characterNames.length) {
      const introText = characterNames.map(name => `${name}：${allCharacterIntros[name]}`).join('\n');
      parts.push(`在场角色简介：\n${introText}`);
    }
  }
  
  // 关系信息（开关控制）
  if (State.storyMemoryConfig.relationship && allRelationships.length) {
    const relText = allRelationships.map(rel => `${rel.from} → ${rel.to}：${rel.type}${rel.description ? `（${rel.description}）` : ''}`).join('\n');
    parts.push(`角色关系：\n${relText}`);
  }
  
  if (!parts.length) return '';
  return '## 剧情记忆（自动提取）\n' + parts.join('\n\n');
}

// 聚合物品栏：从头遍历回合记录，gain/loss 累积
function buildInventory(chatId) {
  const inv = {};   // 物品名 -> {count, holder, last}
  const recent = []; // 最近 10 条变更
  for (const rec of readTurns(chatId)) {
    for (const g of rec.items_gain) {
      const key = g.name;
      inv[key] = inv[key] || { count: 0, holder: '' };
      inv[key].count += 1;
      if (g.holder) inv[key].holder = g.holder;
      inv[key].last = rec.ts;
      recent.push({ type: 'gain', name: g.name, holder: g.holder || '', ts: rec.ts });
    }
    for (const name of rec.items_loss) {
      if (inv[name]) {
        inv[name].count -= 1;
        inv[name].last = rec.ts;
        if (inv[name].count <= 0) delete inv[name];
      }
      recent.push({ type: 'loss', name, ts: rec.ts });
    }
  }
  return {
    inventory: Object.entries(inv).map(([name, v]) => ({ name, count: v.count, holder: v.holder })).sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    recent: recent.slice(-10).reverse(),
  };
}

// ---------- 请求体读取（统一上限，防异常数据撑爆内存；超限抛 413 错误） ----------
const BODY_MAX_BYTES = 2 * 1024 * 1024;   // 2MB（对话历史 + system 注入的上限足够）
async function readBody(req, maxBytes = BODY_MAX_BYTES) {
  let body = '';
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) {
      const err = new Error(`请求体过大（>${Math.round(maxBytes / 1024)}KB），已拒绝`);
      err.statusCode = 413;
      throw err;
    }
    body += c;
  }
  return body;
}

// 多模态消息协议适配：视觉模型时把 content 数组（openai 格式 image_url 块）转成 anthropic 图片块；
// 非视觉模型/纯文本消息原样返回。图片块形如 {type:'image_url', image_url:{url:'data:image/png;base64,...'}}
function adaptVisionContent(msg, protocol) {
  const c = msg.content;
  if (typeof c !== 'object' || !Array.isArray(c)) return msg;
  if (protocol !== 'anthropic') return msg;   // openai 原生支持 image_url 块
  const out = [];
  for (const part of c) {
    if (part.type === 'text') { out.push(part); continue; }
    if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
      const m = part.image_url.url.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
      if (m) {
        out.push({ type: 'image', source: { type: 'base64', media_type: `image/${m[1]}`, data: m[2] } });
        continue;
      }
    }
    out.push({ type: 'text', text: '[图片]' });   // 未知格式兜底
  }
  return { ...msg, content: out };
}

// ---------- LLM 调用（Anthropic / OpenAI 双协议，流式；onThinking 回调思考链） ----------
// 移除 U+FFFD（乱码替换符）与孤立代理项：网络/解码偶发的乱码字节会以 U+FFFD 进入流，
// 若不清理会被存档成「方块」，且随 PUT 往返持续存在。此函数在写入/展示前兜底清理。
const sanitizeText = (s) => String(s || '')
  .replace(/\uFFFD+/g, '')
  .replace(/[\u200B\u200C\u2060\uFEFF]/g, '')
  .replace(/[\uD800-\uDFFF]/g, (m, i, str) => {
    const c = m.charCodeAt(0);
    if (c >= 0xD800 && c <= 0xDBFF) return /[\uDC00-\uDFFF]/.test(str[i + 1] || '') ? m : '';
    return /[\uD800-\uDBFF]/.test(str[i - 1] || '') ? m : '';
  });
const cleanMsg = (m) => (m && typeof m === 'object' && typeof m.content === 'string'
  ? { ...m, content: sanitizeText(m.content), ...(typeof m.thinking === 'string' ? { thinking: sanitizeText(m.thinking) } : {}) }
  : m);
const cleanMsgs = (arr) => (Array.isArray(arr) ? arr.map(cleanMsg) : arr);

async function callLLM(messages, system, onDelta, onMeta, onThinking, signal) {
  const ep = State.endpoint;
  let emitted = false;   // 已有输出（delta/thinking）→ 失败时不重试，避免重复输出
  let idleTimedOut = false;   // 流式空闲超时触发（Task7）→ 视为主动中止，不重试
  // 单次调用（openai/anthropic 双协议）；signal 用于客户端断连中止（SSE abort）
  const attempt = async () => {
    const emitDelta = (t) => { emitted = true; onDelta(sanitizeText(t)); };
    const emitThink = (t) => { emitted = true; onThinking && onThinking(sanitizeText(t)); };
    if (ep.protocol === 'openai') {
      const body = {
        model: ep.model,
        messages: [{ role: 'system', content: system }, ...messages],
        stream: true,
        max_tokens: ep.maxTokens || 8192,
      };
      if (ep.thinking === 'low') body.reasoning_effort = 'low';
      else if (ep.thinking === 'medium') body.reasoning_effort = 'medium';
      else if (ep.thinking === 'high' || ep.thinking === 'custom' || ep.thinking === 'enabled') body.reasoning_effort = 'high';
      else if (ep.thinking === 'max') body.reasoning_effort = 'max';
      // 采样参数（来自当前预设；top_k 仅 Anthropic 支持）
      if (State.samplers.temperature != null) body.temperature = State.samplers.temperature;
      if (State.samplers.top_p != null) body.top_p = State.samplers.top_p;
      if (State.samplers.presence_penalty != null) body.presence_penalty = State.samplers.presence_penalty;
      if (State.samplers.frequency_penalty != null) body.frequency_penalty = State.samplers.frequency_penalty;
      const resp = await fetch(`${ep.baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // 流式空闲超时（Task7）：60s 无新 chunk → 取消读取，防端点挂起白烧 token
      const IDLE_TIMEOUT = 60000;   // 60s
      let lastChunk = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - lastChunk > IDLE_TIMEOUT) {
          idleTimedOut = true;
          clearInterval(idleTimer);
          try { reader.cancel(); } catch (e) { /* 已关闭 */ }
        }
      }, 5000);
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lastChunk = Date.now();   // 每个 chunk 重置空闲计时
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const ev = JSON.parse(data);
              const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
              if (delta) {
                if (typeof delta.content === 'string' && delta.content) emitDelta(delta.content);
                if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) emitThink(delta.reasoning_content);
              }
              if (ev.usage) onMeta && onMeta({ usageIn: ev.usage, usageOut: ev.usage });
            } catch (e) { /* 忽略残缺行 */ }
          }
        }
      } catch (e) {
        if (idleTimedOut) throw new Error('流式响应空闲超时（60s 无数据），已中止，请重试');
        throw e;
      } finally {
        clearInterval(idleTimer);
      }
      return;
    }
    // anthropic 协议（默认）
    const body = { model: ep.model, system, messages: messages.map((m) => adaptVisionContent(m, 'anthropic')), max_tokens: ep.maxTokens || 8192, stream: true };
    if (ep.thinking === 'disabled') body.thinking = { type: 'disabled' };
    else if (ep.thinking !== 'auto') {
      const mode = ep.thinking === 'enabled' ? 'high' : ep.thinking;   // 旧值兼容
      const budget = mode === 'custom' ? (ep.thinkingBudget || 32768) : (THINK_BUDGET[mode] || 8192);
      body.thinking = { type: 'enabled', budget_tokens: budget };
    }
    // 采样参数（来自当前预设；presence/frequency_penalty 仅 OpenAI 支持）
    if (State.samplers.temperature != null) body.temperature = State.samplers.temperature;
    if (State.samplers.top_p != null) body.top_p = State.samplers.top_p;
    if (State.samplers.top_k != null) body.top_k = State.samplers.top_k;
    const resp = await fetch(`${ep.baseURL}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ep.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`LLM ${resp.status}: ${err.slice(0, 400)}`);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    // 流式空闲超时（Task7）：60s 无新 chunk → 取消读取，防端点挂起白烧 token
    const IDLE_TIMEOUT = 60000;   // 60s
    let lastChunk = Date.now();
    const idleTimer = setInterval(() => {
      if (Date.now() - lastChunk > IDLE_TIMEOUT) {
        idleTimedOut = true;
        clearInterval(idleTimer);
        try { reader.cancel(); } catch (e) { /* 已关闭 */ }
      }
    }, 5000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        lastChunk = Date.now();   // 每个 chunk 重置空闲计时
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const ev = JSON.parse(data);
            if (ev.type === 'message_start' && ev.message && ev.message.usage) {
              onMeta && onMeta({ usageIn: ev.message.usage });
            } else if (ev.type === 'message_delta' && ev.usage) {
              onMeta && onMeta({ usageOut: ev.usage });
            } else if (ev.type === 'content_block_delta' && ev.delta) {
              if (ev.delta.type === 'text_delta') {
                emitDelta(ev.delta.text);
              } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
                emitThink(ev.delta.thinking);
              }
            }
          } catch (e) { /* 忽略残缺行 */ }
        }
      }
    } catch (e) {
      if (idleTimedOut) throw new Error('流式响应空闲超时（60s 无数据），已中止，请重试');
      throw e;
    } finally {
      clearInterval(idleTimer);
    }
  };
  // 自动重试：网络抖动/5xx 重试 1 次；客户端断连中止（signal.aborted）、已开始输出、4xx（Key/模型错误）不重试
  try {
    await attempt();
  } catch (e) {
    if (signal && signal.aborted) throw e;
    if (idleTimedOut) throw e;   // 空闲超时主动中止（Task7）：不重试（重试只会再挂 60s）
    if (emitted) throw e;
    const msg = String(e && e.message || e);
    if (msg.startsWith('LLM 4')) throw e;   // 4xx 不重试
    await attempt();
  }
}

// ---------- 辅助 API 调用（后台任务走独立端点，串行队列防 429；失败按 fallback 决定是否回退主端点） ----------
// 统一完成一次非流式调用（openai/anthropic 双协议），返回文本
async function completeText(ep, sys, userText, maxTokens, extraBody) {
  // 当 userText 为空时，把 sys 作为唯一 user 内容发送（避免 content 为空导致部分端点 400）
  // 适用于「纯指令型」prompt（如剧情建议/回顾报告/自检/回溯），此时 sys 即完整指令
  const hasUser = typeof userText === 'string' && userText.trim().length > 0;
  if (ep.protocol === 'openai') {
    const msgs = hasUser
      ? [{ role: 'system', content: sys }, { role: 'user', content: userText }]
      : [{ role: 'user', content: sys }];
    const r = await fetch(`${ep.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({ model: ep.model, messages: msgs, max_tokens: maxTokens, ...(extraBody || {}) }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || '').trim();
  }
  const msgs = hasUser
    ? [{ role: 'user', content: userText }]
    : [{ role: 'user', content: sys }];
  const r = await fetch(`${ep.baseURL}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ep.model, system: hasUser ? sys : undefined, messages: msgs, max_tokens: maxTokens, ...(extraBody || {}) }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return (d.content || []).map((b) => b.text || '').join('').trim();
}

// 后台任务统一入口：优先辅助端点（串行队列），未启用/失败时按 AUX.fallback 回退主端点
async function auxCall(sys, userText, maxTokens, extraBody) {
  const aux = auxEffective();
  if (aux) {
    try {
      return await auxEnqueue(() => completeText(aux, sys, userText, maxTokens, extraBody));
    } catch (e) {
      if (!State.aux.fallback) throw new Error(`辅助 API 失败（未回退主端点）: ${e.message}`);
      console.log('[aux] 辅助端点失败，回退主端点:', e.message);
    }
  }
  return completeText(State.endpoint, sys, userText, maxTokens, extraBody);
}

// 自动压缩总结：把最旧一批消息压成剧情摘要（300 字内），走辅助 API（独立端点 + 串行队列；未配置时回退主端点）
async function summarizeOldMessages(messages) {
  const text = messages.map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n\n');
  const sys = '你是互动小说的上下文压缩助手。把以下历史对话压缩成一段中文剧情摘要（300字内），必须保留：关键事件/时间地点/在场人物/物品变化/情感与关系节点/伏笔。不写过程与寒暄，只输出摘要正文。';
  // 摘要任务禁用 thinking：避免 thinking 吃光 max_tokens 预算导致 text 为空
  return auxCall(sys, text, 800, { thinking: { type: 'disabled' } });
}

// 端点探测（max_tokens:1），返回实际生效的模型名
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

// ---------- 会话统计（按模型分桶） ----------
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
function emptyBucket() {
  return { turns: 0, calls: 0, llmMs: 0, firstTokenSum: 0, firstTokenN: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheMiss: 0 };
}
function loadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    if (raw.byModel) { if (!raw.byChat) raw.byChat = {}; return raw; }   // v2/v3：按模型分桶 + 按对话缓存统计
    const b = Object.assign(emptyBucket(), raw);
    return { byModel: { [State.endpoint.model]: b }, byChat: {} };
  } catch (e) { return { byModel: {}, byChat: {} }; }
}
const stats = loadStats();
function bucket(model) {
  if (!stats.byModel[model]) stats.byModel[model] = emptyBucket();
  return stats.byModel[model];
}
function saveStats() {
  if (RW_ASYNC_IO) { return writeQueued(STATS_FILE, () => writeJson(STATS_FILE, stats)); }
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8'); } catch (e) { console.error('保存统计数据失败:', e.message); }
}
function summarize(b) {
  const cacheRate = (b.cacheRead + b.cacheMiss) > 0
    ? Math.round((b.cacheRead / (b.cacheRead + b.cacheMiss)) * 100) : 100;
  return {
    turns: b.turns, calls: b.calls,
    llmSec: Math.round(b.llmMs / 1000),
    firstTokenAvgMs: b.firstTokenN ? Math.round(b.firstTokenSum / b.firstTokenN) : 0,
    tokPerSec: b.llmMs > 1000 ? Math.round((b.tokensOut / (b.llmMs / 1000)) * 10) / 10 : 0,
    cacheRate,
    tokensIn: b.tokensIn, tokensOut: b.tokensOut,
  };
}

// ---------- 会话管理（新对话 / 归档 / 恢复） ----------
const CHATS_DIR = path.join(DATA_DIR, 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });

// ---------- 界面操作状态（视角 / 当日着装覆盖，会话内持久，注入 system + 记账） ----------
const OP_FILE = path.join(DATA_DIR, 'op.json');
State.opState = { views: {}, wardrobes: {}, expands: {}, tools: {}, notes: {}, customInjections: {} };   // views/wardrobes/expands/tools/notes/customInjections: {chatId: ...}
try { State.opState = Object.assign(State.opState, JSON.parse(fs.readFileSync(OP_FILE, 'utf8'))); } catch (e) { /* 首次 */ }
function saveOpState() {
  if (RW_ASYNC_IO) { return writeQueued(OP_FILE, () => writeJson(OP_FILE, State.opState)); }
  try { fs.writeFileSync(OP_FILE, JSON.stringify(State.opState), 'utf8'); } catch (e) { console.error('保存操作状态失败:', e.message); }
}

// ---------- 会话常驻设定多槽位（Task15：背景 / 关系 / 规则 / 其他） ----------
// opState.notes[chatId] 兼容两种形态：
//   ① 旧字符串（向后兼容）→ 视为「其他」槽
//   ② 对象 {背景, 关系, 规则, 其他} → 各槽独立
const NOTE_SLOTS = ['背景', '关系', '规则', '其他'];
// 归一化为槽位对象（字符串迁移为「其他」）
function noteSlots(chatId) {
  const cid = sanitizeId(chatId || '');
  const raw = (State.opState.notes && State.opState.notes[cid]) || null;
  if (raw == null) return {};
  if (typeof raw === 'string') {
    const t = raw.trim();
    return t ? { '其他': t } : {};
  }
  if (typeof raw === 'object') {
    const out = {};
    for (const k of NOTE_SLOTS) {
      const v = raw[k];
      if (v && typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out;
  }
  return {};
}
// 合并文本（供注入 / 兼容旧读取）
function noteText(chatId) {
  const slots = noteSlots(chatId);
  return NOTE_SLOTS.map((k) => slots[k] || '').filter(Boolean).join('\n');
}
// 注入文本（带槽位标题，每轮注入 system）
function noteInjectText(chatId) {
  const slots = noteSlots(chatId);
  const names = Object.keys(slots);
  if (!names.length) return '';
  return names.map((k) => `【${k}】\n${slots[k]}`).join('\n\n');
}

// 自定义注入槽（⚙️ 前缀 / 后缀，按会话；随 system 注入：前缀置顶、后缀置底）
function customInjections(chatId) {
  const cid = sanitizeId(chatId || '');
  const inj = (State.opState.customInjections && State.opState.customInjections[cid]) || {};
  return { prefix: String(inj.prefix || '').trim(), suffix: String(inj.suffix || '').trim() };
}
// 记一条操作回合记录（reuse 回合记录 jsonl 结构；updates 行供导出）
async function appendOpRecord(chatId, entry, content) {
  try {
    const rec = { story_time: '', location: '', atmosphere: '', characters: [], costume: '', event: '', items_gain: [], items_loss: [], updates: [{ entry, content }] };
    rec.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    rec.ts = new Date().toISOString();
    rec.chatId = sanitizeId(chatId);
    const line = JSON.stringify(rec) + '\n';
    if (RW_ASYNC_IO) { await writeQueued(turnsFile(chatId), () => appendLine(turnsFile(chatId), line)); return; }
    fs.appendFileSync(turnsFile(chatId), line, 'utf8');
  } catch (e) { console.error('[op-record] 失败:', e.message); }
}

// ---------- 剧情记忆手动编辑（时间线 / 物品栏 / 换装，界面可改） ----------
// 手动记一条物品变更回合（gain/loss），复用物品栏聚合
async function appendItemRecord(chatId, action, name, holder) {
  try {
    const rec = { story_time: '', location: '', atmosphere: '', characters: [], costume: '', event: '', items_gain: [], items_loss: [], updates: [], emotion: {} };
    rec.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    rec.ts = new Date().toISOString();
    rec.chatId = sanitizeId(chatId);
    if (action === 'gain') rec.items_gain.push({ name, holder: holder || '' });
    else rec.items_loss.push(name);
    const line = JSON.stringify(rec) + '\n';
    if (RW_ASYNC_IO) { await writeQueued(turnsFile(chatId), () => appendLine(turnsFile(chatId), line)); return; }
    fs.appendFileSync(turnsFile(chatId), line, 'utf8');
  } catch (e) { console.error('[item-record] 失败:', e.message); }
}
// 手动补记字段归一化（时间线 补记/修改/插入 共用）
function normalizeTurnFields(fields) {
  return {
    story_time: String(fields.story_time || '').trim().slice(0, 40),
    location: String(fields.location || '').trim().slice(0, 40),
    atmosphere: String(fields.atmosphere || '').trim().slice(0, 60),
    characters: (fields.characters || '').split(/[、,，/]+/).map((s) => s.trim()).filter(Boolean).slice(0, 10),
    costume: String(fields.costume || '').trim().slice(0, 80),
    event: String(fields.event || '').trim().slice(0, 300),
    items_gain: (Array.isArray(fields.items_gain) ? fields.items_gain : []).map((g) => ({ name: String(g?.name || '').trim().slice(0, 40), holder: String(g?.holder || '').trim().slice(0, 20) })).filter((g) => g.name).slice(0, 10),
    items_loss: (Array.isArray(fields.items_loss) ? fields.items_loss : []).map((n) => String(n || '').trim().slice(0, 40)).filter(Boolean).slice(0, 10),
    emotion: (() => {
      const e = fields.emotion;
      if (!e || typeof e !== 'object') return {};
      const out = {};
      for (const [k, v] of Object.entries(e)) { if (v != null && String(v).trim()) out[String(k).trim().slice(0, 20)] = String(v).trim().slice(0, 40); }
      return out;
    })(),
    location_detail: String(fields.location_detail || '').trim().slice(0, 200),
  };
}
async function appendManualTurn(chatId, fields) {
  try {
    const rec = {
      ...normalizeTurnFields(fields),
      items_gain: [], items_loss: [], updates: [], emotion: {},
    };
    rec.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    rec.ts = new Date().toISOString();
    rec.chatId = sanitizeId(chatId);
    const line = JSON.stringify(rec) + '\n';
    if (RW_ASYNC_IO) { await writeQueued(turnsFile(chatId), () => appendLine(turnsFile(chatId), line)); return rec; }
    fs.appendFileSync(turnsFile(chatId), line, 'utf8');
    return rec;
  } catch (e) { console.error('[manual-turn] 失败:', e.message); return null; }
}
// 修改单条回合记录（按 id 重写 jsonl；保留 id/ts/chatId/items/updates/emotion）
async function updateTurnRecord(chatId, id, fields) {
  const file = turnsFile(chatId);
  const rewrite = (lines) => {
    let updated = null;
    const out = lines.map((l) => {
      let o;
      try { o = JSON.parse(l); } catch (e) { return l; }
      if (o.id === id) { updated = { ...o, ...normalizeTurnFields(fields) }; return JSON.stringify(updated); }
      return l;
    });
    if (!updated) return null;
    return { out, updated };
  };
  if (RW_ASYNC_IO) {
    return writeQueued(file, async () => {
      if (!(await fs.promises.stat(file).catch(() => null))) return null;
      const lines = (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean);
      const r = rewrite(lines);
      if (!r) return null;
      await fs.promises.writeFile(file, r.out.join('\n') + '\n', 'utf8');
      return r.updated;
    });
  }
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const r = rewrite(lines);
  if (!r) return null;
  fs.writeFileSync(file, r.out.join('\n') + '\n', 'utf8');
  return r.updated;
}
// 在指定条目之后插入一条回合记录（afterId 未找到/为空 → 追加末尾）
async function insertTurnRecord(chatId, afterId, fields) {
  const file = turnsFile(chatId);
  const rec = {
    ...normalizeTurnFields(fields),
    items_gain: [], items_loss: [], updates: [], emotion: {},
  };
  rec.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  rec.ts = new Date().toISOString();
  rec.chatId = sanitizeId(chatId);
  const line = JSON.stringify(rec);
  if (RW_ASYNC_IO) {
    return writeQueued(file, async () => {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!afterId || !stat) { await appendLine(file, line + '\n'); return rec; }
      const lines = (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean);
      let idx = -1;
      for (let i = 0; i < lines.length; i++) {
        try { if (JSON.parse(lines[i]).id === afterId) { idx = i; break; } } catch (e) { /* 忽略 */ }
      }
      if (idx < 0) { await appendLine(file, line + '\n'); return rec; }
      lines.splice(idx + 1, 0, line);
      await fs.promises.writeFile(file, lines.join('\n') + '\n', 'utf8');
      return rec;
    });
  }
  const append = () => { fs.appendFileSync(file, line + '\n', 'utf8'); return rec; };
  if (!afterId || !fs.existsSync(file)) return append();
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    try { if (JSON.parse(lines[i]).id === afterId) { idx = i; break; } } catch (e) { /* 忽略 */ }
  }
  if (idx < 0) return append();
  lines.splice(idx + 1, 0, line);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return rec;
}
// 删除单条回合记录（按 id 重写 jsonl）
async function deleteTurnRecord(chatId, id) {
  const file = turnsFile(chatId);
  if (RW_ASYNC_IO) {
    return writeQueued(file, async () => {
      if (!(await fs.promises.stat(file).catch(() => null))) return false;
      const lines = (await fs.promises.readFile(file, 'utf8')).split('\n').filter(Boolean);
      const kept = lines.filter((l) => {
        try { const o = JSON.parse(l); return o.id !== id; } catch (e) { return true; }
      });
      if (kept.length === lines.length) return false;
      await fs.promises.writeFile(file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
      return true;
    });
  }
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const kept = lines.filter((l) => {
    try { const o = JSON.parse(l); return o.id !== id; } catch (e) { return true; }
  });
  if (kept.length === lines.length) return false;
  fs.writeFileSync(file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  return true;
}
// 聚合当前着装：扫描回合记录（costume 字段 + updates「衣柜」）+ 手动换装覆盖（opState.wardrobes），取每个角色最新
function buildCurrentWardrobe(chatId) {
  const cid = sanitizeId(chatId);
  const out = {};
  for (const rec of readTurns(chatId)) {
    if (rec.costume && rec.costume !== '同上') {
      const m = String(rec.costume).match(/^([^：:]+)[：:]\s*(.+)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    for (const u of (rec.updates || [])) {
      if (u.entry && String(u.entry).includes('衣柜')) {
        const m = String(u.content).match(/^([^：:]+)[：:]\s*(.+)$/);
        if (m && m[2].trim()) out[m[1].trim()] = m[2].trim();
      }
    }
  }
  if (State.opState.wardrobes[cid]) {
    const m = String(State.opState.wardrobes[cid]).match(/^([^：:]+)[：:]\s*(.+)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}
// ---------- 情绪追踪（按会话记录各角色当前情绪，注入 system 保持情绪连续） ----------
const EMOTIONS_FILE = path.join(DATA_DIR, 'emotions.json');
State.emotions = {};   // {chatId: {角色名: 情绪描述}}
try { State.emotions = JSON.parse(fs.readFileSync(EMOTIONS_FILE, 'utf8')); } catch (e) { /* 首次 */ }
function saveEmotions() {
  try { fs.writeFileSync(EMOTIONS_FILE, JSON.stringify(State.emotions), 'utf8'); } catch (e) { /* 忽略 */ }
}
// 从回合记录聚合各角色最新情绪：优先显式 emotion 字段，回退 updates 中「情绪」条目
function buildEmotions(chatId) {
  const cid = sanitizeId(chatId);
  const out = {};
  const manual = (State.emotions[cid] || {});
  for (const rec of readTurns(chatId)) {
    if (rec.emotion) {
      for (const [name, emo] of Object.entries(rec.emotion)) {
        if (emo && emo.trim()) out[name] = emo.trim();
      }
    }
    for (const u of (rec.updates || [])) {
      if (u.entry && String(u.entry).includes('情绪')) {
        const m = String(u.content).match(/^([^：:]+)[：:]\s*(.+)$/);
        if (m && m[2].trim()) out[m[1].trim()] = m[2].trim();
      }
    }
  }
  for (const [name, emo] of Object.entries(manual)) {
    if (emo && emo.trim()) out[name] = emo.trim();
  }
  return out;
}
// 情绪注入段（放在界面操作覆盖之后，帮助 AI 保持情绪连续）
function emotionInject(chatId) {
  const cid = sanitizeId(chatId || '');
  if (!cid) return '';
  const emo = buildEmotions(cid);
  const names = Object.keys(emo);
  if (!names.length) return '';
  const lines = names.map((n) => `- ${n}：${emo[n]}`);
  return `## 当前情绪（界面追踪，冲突时以此为准）\n${lines.join('\n')}`;
}
// 设置/清除某个角色的情绪（手动，记账；清空该角色时传空字符串）
function setEmotion(chatId, name, emo) {
  const cid = sanitizeId(chatId || '');
  if (!State.emotions[cid]) State.emotions[cid] = {};
  if (emo && emo.trim()) State.emotions[cid][name] = emo.trim();
  else delete State.emotions[cid][name];
  saveEmotions();
  appendOpRecord(cid, '情绪', `${name}：${emo.trim() || '（清除）'}`);
}

// 界面操作注入段（作为持续生效的覆盖指令）
function opInject(chatId) {
  const cid = sanitizeId(chatId);
  const lines = [];
  const noteText_ = noteInjectText(cid);   // 多槽位合并注入（Task15：非空槽全部拼入）
  if (noteText_) lines.push(`- 📌 会话常驻设定（用户保存，每轮必读，优先级最高；与「世界设定」/检索内容冲突时以此为准）：\n${noteText_}`);
  if (State.opState.views[cid]) lines.push(`- 当前视角覆盖：${State.opState.views[cid]}（用户已在界面切换视角；你必须以该角色的主观视角叙述——与设定中记录的视角冲突时，以本覆盖为准。严格遵守信息屏障：主场景角色无法感知副场景事件）`);
  if (State.opState.wardrobes[cid]) lines.push(`- 当日着装覆盖：${State.opState.wardrobes[cid]}（用户已在界面换装；以此为准，覆盖设定中的当日着装描述）`);
  if (State.opState.expands[cid]) lines.push('- 【扩写指令（已开启）】当用户发来简短指令（如「角色去厨房」「角色站起来」）时，你的任务是将其【扩写】为详细、生动的动作/场景/台词描写：用第三人称叙述该角色的行为（动作细节、表情、环境、心理），符合人设；扩写要连贯、有画面感、贴合当前场景；不要替其他角色做决定；扩写后可自然衔接台词。');
  if (State.opState.tools && Array.isArray(State.opState.tools[cid]) && State.opState.tools[cid].length) {
    const labels = State.opState.tools[cid].map((n) => BRIDGE_TOOL_LABELS[n] || n).join('、');
    lines.push('- 【工具桥（已开启：' + labels + '）】当用户明确要求「联网/搜索/查一下」或需要核实现实世界信息时，你必须调用 web_search 工具，不得跳过或编造；工具结果需在回复中标注来源（联网核实：…）。');
  }
  return lines.length ? `## ⚠️ 界面操作覆盖（优先级最高，冲突时以此为准）\n${lines.join('\n')}` : '';
}



// ---------- 工具桥：对话内工具（仅联网搜索；通用工具集可扩展） ----------
const BRIDGE_TOOL_NAMES = ['web_search'];
const BRIDGE_TOOL_LABELS = { web_search: '联网搜索' };
const BRIDGE_TOOLS = [
  { name: 'web_search', description: '联网搜索（仅当用户明确要求「联网/查一下/搜索」，或需要核实现实世界信息如新闻/歌曲/游戏/品牌时使用）。返回来源标题+链接+摘要。', input_schema: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } },
];
// 工具定义按端点协议转换：openai → { type:'function', function:{name,description,parameters} }；anthropic → { name, description, input_schema }
// （修复：deepseek openai 端点拒绝 anthropic 工具格式，报 tools[0]: missing field `type`）
function toolsFor(ep, tools) {
  if (ep.protocol === 'openai') return (tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } } }));
  return tools;
}
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
normalizeToolsState();
function toolsEnabled(chatId) { return (State.opState.tools && State.opState.tools[sanitizeId(chatId)]) || []; }
async function executeBridgeTool(name, input) {
  if (name !== 'web_search') return '未知工具: ' + name;
  const q = String(input.query || '').slice(0, 200);
  const toolDef = { name: 'web_search', description: 'Search the web', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } };
  const msgs = [{ role: 'user', content: 'Perform a web search for the query: ' + q }];
  const seenUrls = new Set();
  // 自动跟随：模型可能"换个搜索再试"，最多 3 轮；走辅助端点（串行队列防 429）
  const doRound = (ep, msgs2) => {
    const headers = ep.protocol === 'openai'
      ? { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` }
      : { 'content-type': 'application/json', 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01' };
    const body = ep.protocol === 'openai'
      ? { model: ep.model, max_tokens: 1024, tools: toolsFor(ep, [toolDef]), messages: msgs2 }
      : { model: ep.model, max_tokens: 1024, thinking: { type: 'disabled' }, tools: toolsFor(ep, [toolDef]), messages: msgs2 };
    return fetch(`${ep.baseURL}${ep.protocol === 'openai' ? '/chat/completions' : '/messages'}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    });
  };
  const parseResp = (d) => {
    if (d.choices) {
      return { text: (d.choices[0]?.message?.content || '').trim(), toolCalls: (d.choices[0]?.message?.tool_calls || []) };
    }
    const blocks = d.content || [];
    const out = [];
    for (const b of blocks) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.web_search_result)) {
        for (const item of b.web_search_result) {
          if (seenUrls.has(item.url)) continue;
          seenUrls.add(item.url);
          out.push('- ' + (item.title || '') + '（' + (item.url || '') + '）');
        }
      }
      if (b.type === 'text' && Array.isArray(b.citations)) {
        for (const c of b.citations) {
          if (c.cited_text && !seenUrls.has(c.url)) {
            if (c.url) seenUrls.add(c.url);
            out.push('  [摘要] ' + String(c.cited_text).replace(/\s+/g, ' ').slice(0, 200));
          }
        }
      }
    }
    return { text: blocks.map((b) => b.text || '').join('').trim(), toolCalls: blocks.filter((b) => b.type === 'tool_use'), out };
  };
  for (let i = 0; i < 3; i++) {
    const useAux = !!auxEffective();
    const run = () => doRound(useAux ? AUX : State.endpoint, msgs);
    let d;
    try {
      const r = await (useAux ? auxEnqueue(run) : run());
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
      d = await r.json();
    } catch (e) {
      if (useAux && State.aux.fallback) {
        const r = await doRound(State.endpoint, msgs);
        if (!r.ok) return '联网搜索失败 HTTP ' + r.status;
        d = await r.json();
      } else if (useAux) {
        return '联网搜索失败（辅助 API：' + e.message + '）';
      } else {
        return '联网搜索失败 HTTP: ' + e.message;
      }
    }
    const { text, toolCalls, out } = parseResp(d);
    if (out && out.length) return out.join('\n');
    if (text && text.trim() && !toolCalls.length) return text.slice(0, 1500);
    if (!toolCalls || !toolCalls.length) return '（搜索未返回结果）';
    if (d.choices) {
      msgs.push({ role: 'assistant', content: text || null, tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function?.name, arguments: tc.function?.arguments } })) });
      const results = [];
      for (const tc of toolCalls) {
        results.push({ role: 'tool', tool_call_id: tc.id, content: '（继续搜索）' });
      }
      msgs.push(...results);
      continue;
    }
    const tu = toolCalls[0];
    msgs.push({ role: 'assistant', content: d.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '' }] });
  }
  return '（搜索多次未返回结果）';
}
async function bridgeDirectTool(lastUserText) {
  const t = String(lastUserText || '');
  const res = [];
  if (/联网|搜索|查一下|查新闻|核实/.test(t)) {
    // 剥掉所有前置触发词（含"一下"）
    let q = t.replace(/^(?:联网|搜索|查一下|查新闻|帮我|请|核实|查|一下)+[：:、\s]*/i, '').replace(/[？?].*$/, '').replace(/[。！!\s]+$/, '').slice(0, 120);
    if (q) res.push({ name: 'web_search', input: { query: q } });
  }
  return res;
}
async function runBridgeToolLoop(messages, system, enabledNames) {
  const enabledSet = new Set(enabledNames || []);
  const tools = BRIDGE_TOOLS.filter((t) => enabledSet.has(t.name));
  if (!tools.length) return { messages: messages.slice(), trace: [], finalText: '' };
  let msgs = messages.slice();
  const trace = [];
  // 工具回合走辅助端点（串行队列防 429）；未启用辅助端点时用主端点
  const doRound = (ep, msgs2) => {
    const headers = ep.protocol === 'openai'
      ? { 'content-type': 'application/json', authorization: `Bearer ${ep.apiKey}` }
      : { 'content-type': 'application/json', 'x-api-key': ep.apiKey, 'anthropic-version': '2023-06-01' };
    const body = ep.protocol === 'openai'
      ? { model: ep.model, messages: [{ role: 'system', content: system }, ...msgs2], max_tokens: 1024, tools: toolsFor(ep, tools) }
      : { model: ep.model, system, max_tokens: 1024, thinking: { type: 'disabled' }, tools: toolsFor(ep, tools), messages: msgs2 };
    return fetch(`${ep.baseURL}${ep.protocol === 'openai' ? '/chat/completions' : '/messages'}`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
    });
  };
  const parseBlocks = (d) => {
    if (d.choices) {
      const msg = d.choices[0]?.message || {};
      return {
        text: String(msg.content || '').trim(),
        toolUses: (msg.tool_calls || []).filter((tc) => tc.type === 'function').map((tc) => ({ id: tc.id, name: tc.function?.name || '', input: safeParse(tc.function?.arguments) })),
      };
    }
    const blocks = d.content || [];
    return {
      text: blocks.map((b) => b.text || '').join('').trim(),
      toolUses: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input || {} })),
    };
  };
  for (let round = 0; round < 4; round++) {
    const useAux = !!auxEffective();
    const run = () => doRound(useAux ? AUX : State.endpoint, msgs);
    let d;
    try {
      const r = await (useAux ? auxEnqueue(run) : run());
      if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (await r.text()).slice(0, 120));
      d = await r.json();
    } catch (e) {
      if (useAux && State.aux.fallback) {
        const r = await doRound(State.endpoint, msgs);
        if (!r.ok) throw new Error('工具回合失败（主端点）HTTP ' + r.status + ': ' + (await r.text()).slice(0, 120));
        d = await r.json();
      } else {
        throw new Error('工具回合失败' + (useAux ? '（辅助 API，未回退）' : '') + ': ' + e.message);
      }
    }
    const { text, toolUses } = parseBlocks(d);
    if (!toolUses.length) return { messages: msgs, trace, finalText: text };
    if (d.choices) {
      const assistantMsg = d.choices[0].message;
      msgs = msgs.concat([{ role: 'assistant', content: assistantMsg.content || '', tool_calls: (assistantMsg.tool_calls || []).map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: tc.function?.arguments || '{}' } })) }]);
      const results = [];
      for (const tu of toolUses) {
        let resultText;
        if (!enabledSet.has(tu.name)) resultText = '工具不可用：' + tu.name + '（未在本会话开启）';
        else try { resultText = await executeBridgeTool(tu.name, tu.input); }
        catch (e) { resultText = '工具执行失败: ' + e.message; }
        trace.push({ name: tu.name, input: tu.input, resultHead: resultText.slice(0, 120) });
        results.push({ role: 'tool', tool_call_id: tu.id, content: String(resultText).slice(0, 5000) });
      }
      msgs = msgs.concat(results);
      continue;
    }
    msgs = msgs.concat([{ role: 'assistant', content: d.content }]);
    const results = [];
    for (const tu of toolUses) {
      let resultText;
      if (!enabledSet.has(tu.name)) resultText = '工具不可用：' + tu.name + '（未在本会话开启）';
      else try { resultText = await executeBridgeTool(tu.name, tu.input); }
      catch (e) { resultText = '工具执行失败: ' + e.message; }
      trace.push({ name: tu.name, input: tu.input, resultHead: resultText.slice(0, 120) });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(resultText).slice(0, 5000) });
    }
    msgs = msgs.concat([{ role: 'user', content: results }]);
  }
  return { messages: msgs, trace, finalText: '' };
}

function chatFilePath(id) { return path.join(CHATS_DIR, `${id}.json`); }

// ---------- 存档点（Savepoints）：data/savepoints/{chatId}/{timestamp}.json（会话完整副本） ----------
const SAVEPOINTS_DIR = path.join(DATA_DIR, 'savepoints');
fs.mkdirSync(SAVEPOINTS_DIR, { recursive: true });
function savepointsDirFor(chatId) {
  const dir = path.join(SAVEPOINTS_DIR, sanitizeId(chatId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function listSavepoints(chatId) {
  const dir = path.join(SAVEPOINTS_DIR, sanitizeId(chatId));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
      const ts = Number(f.replace(/\.json$/, '')) || 0;
      let label = '', count = 0;
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        label = (d.savepoint && d.savepoint.label) || '';
        count = Array.isArray(d.messages) ? d.messages.length : 0;
      } catch (e) { /* 忽略损坏存档 */ }
      return { ts, file: f, label, count, time: new Date(ts).toISOString() };
    }).sort((a, b) => b.ts - a.ts);
  } catch (e) { return []; }
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

// 会话列表元数据缓存（P-1 阶段 2 · 异步路径）：仿 loadHistIndex 的 mtime 索引模式——
// 以「文件名+mtimeMs+size」为签名，未变不重新 parse；返回全量元数据（含 hidden），
// 正常列表/归档列表各按 hidden 过滤（排序在过滤前完成，与 readChats 的排序语义逐项一致）。
State.chatMetaCache = { sig: '', metas: [] };
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

// ---------- 历史消息检索（本地关键词，零 API） ----------
// 索引缓存：目录文件 mtime 变化时重建；数据量小（KB 级）直接全量载入内存
State.histIndexCache = { mtimes: '', chats: [] };
function loadHistIndex() {
  try {
    const files = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json')).sort();
    const sig = files.map((f) => {
      try { return `${f}:${fs.statSync(path.join(CHATS_DIR, f)).mtimeMs}`; } catch (e) { return `${f}:gone`; }
    }).join('|');
    if (sig === State.histIndexCache.mtimes) return State.histIndexCache.chats;
    const chats = files.map((f) => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
        const messages = (c.messages || []).map((m, i) => ({
          seq: m.seq || (i + 1), role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || ''),
        })).filter((m) => m.content);
        const profileId = c.chatProfile || 'main';
        const profile = State.chatProfiles[profileId] || State.chatProfiles.main || {};
        return { id: c.id, title: c.title || '未命名', updatedAt: c.updatedAt || '', messages, chatProfile: profileId, profileLabel: profile.label || profileId, profileColor: profile.color || '#639922' };
      } catch (e) { return null; }
    }).filter(Boolean);
    State.histIndexCache = { mtimes: sig, chats };
    return chats;
  } catch (e) { return []; }
}

// 关键词拆分：空格 / 中英文逗号 / 顿号分隔；AND 语义（全部词命中才算）
function splitKeywords(q) {
  return String(q || '').split(/[\s,，、;；]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}

// 关键词高亮辅助：返回 [{from,to}] 命中区间（content 内，可叠加）
function keywordRanges(content, kws) {
  const low = content.toLowerCase();
  const ranges = [];
  for (const k of kws) {
    let idx = 0;
    while (idx < low.length) {
      const at = low.indexOf(k, idx);
      if (at < 0) break;
      ranges.push({ from: at, to: at + k.length });
      idx = at + k.length;
    }
  }
  return ranges.sort((a, b) => a.from - b.from);
}

// 生成命中片段：以第一个命中位置为中心，前后各截 60 字符
function makeSnippet(content, ranges) {
  if (!ranges.length) return content.slice(0, 160);
  const c = ranges[0].from;
  const start = Math.max(0, c - 60);
  const end = Math.min(content.length, c + 160);
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}

// 路由处理：GET /api/history/search?q=词&chatId=可选&limit=20
function handleHistorySearch(url, res) {
  const q = url.searchParams.get('q') || '';
  const rawChatId = (url.searchParams.get('chatId') || '').trim();
  const onlyChatId = rawChatId ? sanitizeId(rawChatId) : '';   // 空 = 搜索全部会话
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 100);
  const kws = splitKeywords(q);
  if (!kws.length) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '缺少关键词 q' }));
  }
  const chats = loadHistIndex().filter((c) => !onlyChatId || c.id === onlyChatId);
  const results = [];
  for (const chat of chats) {
    for (const m of chat.messages) {
      const low = m.content.toLowerCase();
      let hits = 0, all = true;
      for (const k of kws) {
        const n = low.split(k).length - 1;
        if (n === 0) { all = false; break; }
        hits += n;
      }
      if (!all) continue;
      const ranges = keywordRanges(m.content, kws);
      const score = hits * 3 + kws.length * 5 + (m.content.length < 300 ? 8 : 0);
      results.push({
        chatId: chat.id, chatTitle: chat.title, seq: m.seq, role: m.role,
        score, hits, snippet: makeSnippet(m.content, ranges), ranges, content: m.content,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify({ query: q, kws, total: results.length, results: top }));
}

// ---------- 静态服务 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
function sendFile(res, file, type) {
  const mime = type || MIME[path.extname(file)] || 'application/octet-stream';
  if (RW_ASYNC_IO) {
    // 流式发送：大文件不再整块读入内存，事件循环不被静态资源突发读取阻塞
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        return res.end('404');
      }
      res.writeHead(200, {
        'content-type': mime,
        'cache-control': 'no-cache, no-store, must-revalidate',
        'content-length': st.size,
      });
      const stream = fs.createReadStream(file);
      stream.on('error', () => { try { if (!res.writableEnded) res.end(); } catch (e) { /* 已关闭 */ } });
      stream.pipe(res);
    });
    return;
  }
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'no-cache, no-store, must-revalidate',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

// 顶层兜底（M6）：async handler 内任何未捕获异常（如 readBody 413 抛出）不崩溃进程
process.on('unhandledRejection', (err) => {
  console.error('[server] 未捕获的异步异常（已兜底，请求可能超时）:', err && err.message || err);
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (p === '/' || p === '/index.html') return sendFile(res, path.join(WWW, 'index.html'));
  if (p === '/favicon.ico' || p === '/favicon.png') return sendFile(res, path.join(WWW, 'favicon.png'), 'image/png');
  if (p === '/logo.png') return sendFile(res, path.join(WWW, 'logo.png'), 'image/png');
  if (p === '/share-card.png') return sendFile(res, path.join(WWW, 'share-card.png'), 'image/png');
  if (p === '/style.css') return sendFile(res, path.join(WWW, 'style.css'));
  if (p === '/app.js') return sendFile(res, path.join(WWW, 'app.js'));

  // 模型 / API 端点查看与切换（持久化 data/model.json；POST 时探测验证）
  if (p === '/api/model' && req.method === 'GET') {
    const k = State.endpoint.apiKey || '';
    const ak = State.aux.apiKey || '';
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      model: State.endpoint.model,
      protocol: State.endpoint.protocol,
      baseURL: State.endpoint.baseURL,
      apiKeyMasked: k ? '...' + k.slice(-4) : '',
      usingDefaultKey: (() => { try { return !fs.existsSync(MODEL_FILE) || !(JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8') || '{}').apiKey); } catch (e) { return true; } })(),
      maxTokens: State.endpoint.maxTokens,
      thinking: State.endpoint.thinking,
      thinkingBudget: State.endpoint.thinkingBudget,
      maxContext: State.endpoint.maxContext,
      autoSummary: State.endpoint.autoSummary,
      autoSummaryThreshold: State.endpoint.autoSummaryThreshold,
      // 辅助 API（后台任务独立端点）
      aux: {
        enabled: State.aux.enabled,
        protocol: State.aux.protocol,
        baseURL: State.aux.baseURL,
        apiKeyMasked: ak ? '...' + ak.slice(-4) : '',
        model: State.aux.model,
        fallback: State.aux.fallback,
      },
      // 峰谷定价仅官方直连渠道适用（DeepSeek 官方：高峰 9-12 / 14-18 翻倍）
      peakEligible: /api\.deepseek\.com/i.test(State.endpoint.baseURL || ''),
    }));
  }
  if (p === '/api/model' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { model, baseURL, apiKey, protocol, maxTokens, thinking, thinkingBudget, maxContext, autoSummary, autoSummaryThreshold, aux } = JSON.parse(body);
      const next = { ...State.endpoint };
      if (protocol === 'anthropic' || protocol === 'openai') next.protocol = protocol;
      if (baseURL && baseURL.trim()) next.baseURL = baseURL.trim().replace(/\/+$/, '');
      if (apiKey && apiKey.trim()) next.apiKey = apiKey.trim();
      if (model && model.trim()) next.model = model.trim();
      if (Number.isFinite(maxTokens) && maxTokens >= 256 && maxTokens <= 393216) next.maxTokens = maxTokens;
      if (['auto', 'disabled', 'low', 'medium', 'high', 'max', 'custom'].includes(thinking)) next.thinking = thinking;
      else if (thinking === 'enabled') next.thinking = 'high';   // 旧「开启」→ 深度思考档
      if (Number.isFinite(thinkingBudget) && thinkingBudget >= 256 && thinkingBudget <= 393216) next.thinkingBudget = thinkingBudget;
      if (Number.isFinite(maxContext) && maxContext >= 0 && maxContext <= 1048576) next.maxContext = maxContext;
      if (typeof autoSummary === 'boolean') next.autoSummary = autoSummary;
      if (Number.isFinite(autoSummaryThreshold) && autoSummaryThreshold >= 2000 && autoSummaryThreshold <= 100000) next.autoSummaryThreshold = autoSummaryThreshold;
      if (!next.apiKey) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '缺少 API Key' }));
      }
      // 辅助 API 配置（可选：不填 = 保持原值）
      const nextAux = { ...State.aux };
      if (aux && typeof aux === 'object') {
        if (typeof aux.enabled === 'boolean') nextAux.enabled = aux.enabled;
        if (aux.protocol === 'anthropic' || aux.protocol === 'openai') nextAux.protocol = aux.protocol;
        if (aux.baseURL && typeof aux.baseURL === 'string' && aux.baseURL.trim()) nextAux.baseURL = aux.baseURL.trim().replace(/\/+$/, '');
        if (aux.apiKey && typeof aux.apiKey === 'string' && aux.apiKey.trim()) nextAux.apiKey = aux.apiKey.trim();
        if (aux.model && typeof aux.model === 'string' && aux.model.trim()) nextAux.model = aux.model.trim();
        if (typeof aux.fallback === 'boolean') nextAux.fallback = aux.fallback;
      }
      const requested = next.model;
      // 轻量探测（max_tokens:1）：验证端点/Key/模型，端点会把不存在的模型名静默映射到实际模型
      const probed = await probeEndpoint(next);
      next.model = probed.model;
      State.endpoint = next;
      State.aux = nextAux;
      // Key 自动记忆：保存时把「端点 + Key」记入记忆，之后切到该端点档案自动带上
      if (next.baseURL && next.apiKey) State.keyMemo.by[next.baseURL] = next.apiKey;
      if (nextAux.baseURL && nextAux.apiKey) State.keyMemo.auxBy[nextAux.baseURL] = nextAux.apiKey;
      saveKeyMemo();
      backupConfig(MODEL_FILE);
      fs.writeFileSync(MODEL_FILE, JSON.stringify({
        protocol: State.endpoint.protocol, baseURL: State.endpoint.baseURL, apiKey: State.endpoint.apiKey,
        model: State.endpoint.model, maxTokens: State.endpoint.maxTokens, thinking: State.endpoint.thinking,
        thinkingBudget: State.endpoint.thinkingBudget, maxContext: State.endpoint.maxContext,
        autoSummary: State.endpoint.autoSummary, autoSummaryThreshold: State.endpoint.autoSummaryThreshold,
        aux: { enabled: State.aux.enabled, protocol: State.aux.protocol, baseURL: State.aux.baseURL, apiKey: State.aux.apiKey, model: State.aux.model, fallback: State.aux.fallback },
        updatedAt: new Date().toISOString(),
      }), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, model: State.endpoint.model, requested, mapped: probed.model !== requested }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: String(e) }));
    }
  }

  // 会话管理：列表 / 新建 / 读取 / 保存 / 删除
  const chatM = p.match(/^\/api\/chats(?:\/([^/]+))?$/);
  if (chatM) {
    const id = chatM[1];
    const sendJson = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    // POST /api/chats/unarchive — 恢复已归档会话（必须在 :id 路由之前匹配）
    if (p === '/api/chats/unarchive' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { chatId } = JSON.parse(body);
        if (!chatId) return sendJson({ error: 'missing chatId' }, 400);
        const file = chatFilePath(chatId);
        if (RW_ASYNC_IO) {
          if (!(await fs.promises.stat(file).catch(() => null))) return sendJson({ error: 'chat not found' }, 404);
          await writeQueued(file, async () => {
            const chat = JSON.parse(await fs.promises.readFile(file, 'utf8'));   // 损坏 → 抛出 → 400（与原同步路径一致）
            chat.hidden = false;
            chat.updatedAt = new Date().toISOString();
            await writeJson(file, chat);
          });
          return sendJson({ ok: true });
        }
        if (!fs.existsSync(file)) return sendJson({ error: 'chat not found' }, 404);
        const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
        chat.hidden = false;
        chat.updatedAt = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(chat), 'utf8');
        return sendJson({ ok: true });
      } catch (e) { return sendJson({ error: String(e) }, 400); }
    }
    if (!id) {
      // GET /api/chats — 支持 ?archived=true 返回已归档会话（默认不返回）
      if (req.method === 'GET') {
        const urlObj = new URL(req.url, 'http://localhost');
        const showArchived = urlObj.searchParams.get('archived') === 'true';
        if (RW_ASYNC_IO) {
          // 元数据缓存（文件签名未变不重新 parse）；排序在过滤前完成，语义与 readChats 一致
          const metas = await loadChatMetas();
          return sendJson({ chats: metas.filter((c) => showArchived ? c.hidden : !c.hidden) });
        }
        if (showArchived) {
          const all = readChats(true);
          const normal = new Set(readChats(false).map(c => c.id));
          const archived = all.filter(c => !normal.has(c.id));
          return sendJson({ chats: archived });
        }
        return sendJson({ chats: readChats() });
      }
      if (req.method === 'POST') {
        const cid = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        const chat = { id: cid, title: '新对话', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] };
        if (RW_ASYNC_IO) await writeQueued(chatFilePath(cid), () => writeJson(chatFilePath(cid), chat));
        else fs.writeFileSync(chatFilePath(cid), JSON.stringify(chat), 'utf8');
        return sendJson({ id: cid });
      }
    }
    const file = chatFilePath(id);
    if (req.method === 'GET') {
      if (RW_ASYNC_IO) {
        if (!(await fs.promises.stat(file).catch(() => null))) return sendJson({ error: 'not found' }, 404);
        try {
          const chat = JSON.parse(await fs.promises.readFile(file, 'utf8'));   // 损坏 → 500（与原同步路径一致）
          if (Array.isArray(chat.messages)) chat.messages = cleanMsgs(chat.messages);   // 展示前清理「方块」乱码（不写盘）
          return sendJson(chat);
        } catch (e) { return sendJson({ error: 'failed to load chat' }, 500); }
      }
      if (!fs.existsSync(file)) return sendJson({ error: 'not found' }, 404);
      try {
        const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(chat.messages)) chat.messages = cleanMsgs(chat.messages);   // 展示前清理「方块」乱码（不写盘）
        return sendJson(chat);
      } catch (e) { return sendJson({ error: 'failed to load chat' }, 500); }
    }
    if (req.method === 'PUT') {
      let body = await readBody(req);
      try {
        const { title, messages, pinned, hidden } = JSON.parse(body);
        // 读-改-写整体进写队列：与并发保存（前端自动保存/其他页签）串行，消除交错写
        if (RW_ASYNC_IO) {
          await writeQueued(file, async () => {
            let chat;
            if (await fs.promises.stat(file).catch(() => null)) chat = JSON.parse(await fs.promises.readFile(file, 'utf8'));   // 损坏 → 抛出 → 400
            else chat = { id, createdAt: new Date().toISOString() };
            if (typeof pinned === 'boolean') chat.pinned = pinned;
            if (typeof hidden === 'boolean') chat.hidden = hidden;
            chat.title = (title || chat.title || '未命名').slice(0, 40);
            // 写盘前清理「方块」乱码：即使浏览器/历史里带 U+FFFD，落盘也始终干净
            chat.messages = Array.isArray(messages) ? cleanMsgs(messages) : (chat.messages || []);
            chat.updatedAt = new Date().toISOString();
            await writeJson(file, chat);
          });
          return sendJson({ ok: true });
        }
        const chat = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { id, createdAt: new Date().toISOString() };
        if (typeof pinned === 'boolean') chat.pinned = pinned;
        if (typeof hidden === 'boolean') chat.hidden = hidden;
        chat.title = (title || chat.title || '未命名').slice(0, 40);
        // 写盘前清理「方块」乱码：即使浏览器/历史里带 U+FFFD，落盘也始终干净
        chat.messages = Array.isArray(messages) ? cleanMsgs(messages) : (chat.messages || []);
        chat.updatedAt = new Date().toISOString();
        fs.writeFileSync(file, JSON.stringify(chat), 'utf8');
        return sendJson({ ok: true });
      } catch (e) { return sendJson({ error: String(e) }, 400); }
    }
    if (req.method === 'DELETE') {
      if (RW_ASYNC_IO) {
        await writeQueued(file, () => fs.promises.unlink(file).catch(() => {}));   // 与同文件写串行
        await writeQueued(turnsFile(id), () => fs.promises.unlink(turnsFile(id)).catch(() => {}));
        return sendJson({ ok: true });
      }
      try { fs.unlinkSync(file); } catch (e) { /* 可能已删 */ }
      try { fs.unlinkSync(turnsFile(id)); } catch (e) { /* 无回合记录 */ }
      return sendJson({ ok: true });
    }
    return sendJson({ error: 'method' }, 405);
  }
  // 存档点：保存当前会话完整副本 / 列表 / 读取恢复
  if (p === '/api/savepoints/save' && req.method === 'POST') {
    let body = await readBody(req);
    const sendJson = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    try {
      const { chatId, label } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      const src = chatFilePath(cid);   // 读源必须用消毒后的 cid（防路径穿越外带任意 JSON）
      if (!fs.existsSync(src)) return sendJson({ ok: false, error: '会话不存在' }, 404);
      const chat = JSON.parse(fs.readFileSync(src, 'utf8'));
      const ts = Date.now();
      // 存档 = 会话完整副本（附带存档元信息 savepoint，读档时剥离）
      const snap = { ...chat, savepoint: { ts, label: String(label || '').trim().slice(0, 40), savedAt: new Date().toISOString() } };
      fs.writeFileSync(path.join(savepointsDirFor(chatId), `${ts}.json`), JSON.stringify(snap, null, 2), 'utf8');
      return sendJson({ ok: true, ts, note: `已存档：${new Date(ts).toLocaleString()}${snap.savepoint.label ? '（' + snap.savepoint.label + '）' : ''}` });
    } catch (e) {
      return sendJson({ ok: false, error: String(e) }, 400);
    }
  }
  if (p === '/api/savepoints/list' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, savepoints: listSavepoints(url.searchParams.get('chatId') || '') }));
  }
  if (p === '/api/savepoints/load' && req.method === 'POST') {
    let body = await readBody(req);
    const sendJson = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
    try {
      const { chatId, ts } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      const file = path.join(SAVEPOINTS_DIR, cid, `${Number(ts)}.json`);
      if (!fs.existsSync(file)) return sendJson({ ok: false, error: '存档点不存在' }, 404);
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 恢复 = 用存档副本覆盖当前会话文件（剥离 savepoint 元信息，保持当前会话 id）
      const { savepoint, ...rest } = snap;
      const chat = { ...rest, id: cid, updatedAt: new Date().toISOString() };
      fs.writeFileSync(chatFilePath(cid), JSON.stringify(chat), 'utf8');
      return sendJson({ ok: true, note: '已从存档点恢复' });
    } catch (e) {
      return sendJson({ ok: false, error: String(e) }, 400);
    }
  }

  // 界面操作：视角切换 / 换装（记账 + 状态持久化，供导出/时间线）
  if (p === '/api/op/view' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, view } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      const v = String(view || '').trim().slice(0, 30);
      if (!v) {
        // 空值 = 恢复默认（用户角色主观视角）
        delete State.opState.views[cid];
        saveOpState();
        appendOpRecord(cid, '当前视角', '默认（用户角色）');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, view: '', note: '已恢复默认视角（用户角色主观视角）' }));
      }
      State.opState.views[cid] = v;
      saveOpState();
      appendOpRecord(cid, '当前视角', v);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, view: v, note: `已切换视角：${v}（已记账，可导出回合记录）` }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  if (p === '/api/op/wardrobe' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, character, outfit, worn } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      const ch = String(character || '').trim().slice(0, 20);
      const of = String(outfit || '').trim().slice(0, 200);
      if (!ch || !of) throw new Error('缺少角色或着装描述');
      const day = String(worn || '').trim() || '今日';
      State.opState.wardrobes[cid] = `${ch}：${of}`;
      saveOpState();
      appendOpRecord(cid, '衣柜', `${ch}：${of}（${day}）`);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, note: `✅ 已更新《衣柜》：${ch}：${of}（已记账，可导出回合记录）` }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // 界面操作：扩写指令开关（记账）
  if (p === '/api/op/expand' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, enabled } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      const en = Boolean(enabled);
      if (en) State.opState.expands[cid] = true; else delete State.opState.expands[cid];
      saveOpState();
      appendOpRecord(cid, '扩写指令', en ? '开启' : '关闭');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, enabled: en, note: en ? '扩写指令已开启（本会话生效，短指令将自动扩写）' : '扩写指令已关闭' }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  // 界面操作：工具桥开关（自由选取工具集合；记账）
  if (p === '/api/op/tools' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, tools } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      const sel = (Array.isArray(tools) ? tools : []).filter((n) => BRIDGE_TOOL_NAMES.includes(String(n)));
      if (sel.length) State.opState.tools[cid] = sel; else delete State.opState.tools[cid];
      saveOpState();
      appendOpRecord(cid, '工具桥', sel.length ? sel.map((n) => BRIDGE_TOOL_LABELS[n] || n).join('、') : '关闭');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, tools: sel, note: sel.length ? '工具桥已开启：' + sel.map((n) => BRIDGE_TOOL_LABELS[n] || n).join('、') : '工具桥已关闭' }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  // 界面操作：API 采样预设（命名预设）
  if (p === '/api/presets' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, presets: State.presets, active: State.activePreset, samplers: State.samplers }));
  }
  if (p === '/api/presets' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { action, name, preset } = JSON.parse(body);
      const nm = String(name || '').trim().slice(0, 40);
      if (action === 'apply') {
        if (!State.presets[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '预设不存在：' + nm })); }
        applyPreset(nm);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, active: nm, samplers: State.samplers, note: `已应用预设「${nm}」` }));
      }
      if (action === 'save') {
        if (!nm) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '预设名不能为空' })); }
        State.presets[nm] = normPreset(preset || {});
        applyPreset(nm);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, active: nm, note: `预设「${nm}」已保存并应用` }));
      }
      if (action === 'delete') {
        if (BUILTIN_PRESETS[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '内置预设不可删除' })); }
        delete State.presets[nm];
        savePresets();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, note: `预设「${nm}」已删除` }));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '未知操作' }));
    } catch (e) {
      res.writeHead(400); return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  // 配置档案（Profile：端点 + 模型 + 参数整套一键切换）
  if (p === '/api/profiles' && req.method === 'GET') {
    const list = {};
    for (const [k, v] of Object.entries(State.profiles)) {
      const bu = v.baseURL ? v.baseURL.replace(/\/+$/, '') : '';
      list[k] = { ...v, builtin: !!BUILTIN_PROFILES[k], keyReady: !!(bu && State.keyMemo.by[bu]) };
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, profiles: list, active: State.activeProfile, current: snapshotEndpoint() }));
  }
  if (p === '/api/profiles' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { action, name, profile } = JSON.parse(body);
      const nm = String(name || '').trim().slice(0, 40);
      if (action === 'apply') {
        if (!State.profiles[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '档案不存在：' + nm })); }
        applyProfile(nm);
        const k = State.endpoint.apiKey || '';
        const ak = State.aux.apiKey || '';
        const bu = State.endpoint.baseURL || '';
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, active: nm, model: State.endpoint.model, protocol: State.endpoint.protocol, baseURL: State.endpoint.baseURL, apiKeyMasked: k ? '...' + k.slice(-4) : '', keySource: State.keyMemo.by[bu] ? 'memo' : 'kept', keyReady: !!State.keyMemo.by[bu], auxKeyMasked: ak ? '...' + ak.slice(-4) : '', maxTokens: State.endpoint.maxTokens, thinking: State.endpoint.thinking, maxContext: State.endpoint.maxContext, preset: State.activePreset, note: `已切换到「${nm}」`, peakEligible: /api\.deepseek\.com/i.test(bu) }));
      }
      if (action === 'save') {
        if (!nm) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '档案名不能为空' })); }
        const snap = snapshotEndpoint();
        State.profiles[nm] = { ...snap, ...(profile || {}), desc: (profile && profile.desc) || (BUILTIN_PROFILES[nm] ? BUILTIN_PROFILES[nm].desc : '') };
        delete State.profiles[nm].apiKey;
        delete State.profiles[nm].builtin;
        saveProfiles();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, active: nm, note: `档案「${nm}」已保存（端点 + 模型 + 参数）` }));
      }
      if (action === 'delete') {
        if (BUILTIN_PROFILES[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '内置档案不可删除' })); }
        if (!State.profiles[nm]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '档案不存在：' + nm })); }
        delete State.profiles[nm];
        if (State.activeProfile === nm) State.activeProfile = '';
        saveProfiles();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, note: `档案「${nm}」已删除` }));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '未知操作' }));
    } catch (e) {
      res.writeHead(400); return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  // 对话配置档系统
  if (p === '/api/chat-profiles' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, profiles: State.chatProfiles }));
  }
  if (p === '/api/chat-profiles' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { action, id, profile } = JSON.parse(body);
      if (action === 'save') {
        if (!id?.trim()) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'ID 不能为空' })); }
        State.chatProfiles[id.trim().slice(0, 30)] = { ...State.chatProfiles[id.trim()], ...profile, label: (profile?.label || id).slice(0, 40) };
        saveChatProfiles();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true }));
      }
      if (action === 'delete') {
        if (BUILTIN_CHAT_PROFILES[id]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '内置不可删' })); }
        delete State.chatProfiles[id]; saveChatProfiles();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true }));
      }
      if (action === 'apply') {
        const chatId = sanitizeId(profile?.chatId || '');
        if (!chatId || !State.chatProfiles[id]) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '参数错误' })); }
        try {
          const f = path.join(DATA_DIR, 'chats', `${chatId}.json`);
          const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.chatProfile = id; fs.writeFileSync(f, JSON.stringify(c, null, 2), 'utf8');
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '对话不存在' })); }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: '未知操作' }));
    } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: String(e) })); }
  }
  // NPC 档案
  const npcM = p.match(/^\/api\/npc-profiles(?:\/([^/]+))?$/);
  if (npcM) {
    const name = npcM[1] ? sanitizeFileName(decodeURIComponent(npcM[1]), 40) : null;
    const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    if (!name) {
      if (req.method === 'GET') return sendJson({ ok: true, profiles: listNpcProfiles() });
      if (req.method === 'POST') { let b = await readBody(req); try { const d = JSON.parse(b); const n = sanitizeFileName(d.name || '', 40); if (!n) return sendJson({error:'名称不能为空'},400); const p2={name:n,aliases:d.aliases||[],appearance:d.appearance||'',personality:d.personality||'',age:d.age||null,ageNote:d.ageNote||'',relationships:d.relationships||{},firstAppearance:d.firstAppearance||'',lastUpdated:new Date().toISOString(),notes:d.notes||''}; saveNpcProfile(n,p2); return sendJson({ok:true,profile:p2}); } catch(e){return sendJson({error:String(e)},400);} }
    } else {
      if (req.method === 'GET') { const p2=loadNpcProfile(name); return p2?sendJson({ok:true,profile:p2}):sendJson({error:'不存在'},404); }
      if (req.method === 'DELETE') { try{fs.unlinkSync(path.join(NPC_PROFILES_DIR,`${name}.json`));}catch(e){} return sendJson({ok:true}); }
    }
  }
  // 场景档案
  const sceneM = p.match(/^\/api\/scenes(?:\/([^/]+))?$/);
  if (sceneM) {
    const name = sceneM[1] ? sanitizeFileName(decodeURIComponent(sceneM[1]), 40) : null;
    const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    if (!name) {
      if (req.method === 'GET') return sendJson({ ok: true, scenes: listScenes() });
      if (req.method === 'POST') { let b = await readBody(req); try { const d = JSON.parse(b); const n = sanitizeFileName(d.name || '', 40); if (!n) return sendJson({error:'名称不能为空'},400); const s={name:n,location:d.location||'',physicalFeatures:d.physicalFeatures||[],atmosphere:d.atmosphere||'',lastVisited:d.lastVisited||new Date().toISOString().slice(0,10),visitCount:d.visitCount||0,notes:d.notes||''}; saveScene(n,s); return sendJson({ok:true,scene:s}); } catch(e){return sendJson({error:String(e)},400);} }
    } else {
      if (req.method === 'GET') { const s=loadScene(name); return s?sendJson({ok:true,scene:s}):sendJson({error:'不存在'},404); }
      if (req.method === 'DELETE') { try{fs.unlinkSync(path.join(SCENES_DIR,`${name}.json`));}catch(e){} return sendJson({ok:true}); }
    }
  }
  // 特判：/api/expressions/config 是功能路由，须先于 expM 通配匹配（否则被当成角色名 config）
  if (p === '/api/expressions/config' && req.method === 'POST') { let b=await readBody(req); try { const d=JSON.parse(b); if(d.emotionMap) State.emotionMap={...DEFAULT_EMOTION_MAP,...d.emotionMap}; if(typeof d.enableAutoSwitch==='boolean') State.enableAutoSwitch=d.enableAutoSwitch; saveExpressionConfig(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true})); } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  // 表情系统
  const expM = p.match(/^\/api\/expressions(?:\/([^/]+))?$/);
  if (expM) {
    const charName = expM[1] ? sanitizeFileName(decodeURIComponent(expM[1]), 40) : null;
    const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    if (!charName) {
      if (req.method === 'GET') { try { const cs=fs.readdirSync(EXPRESSIONS_DIR).filter(f=>fs.statSync(path.join(EXPRESSIONS_DIR,f)).isDirectory()); const r={}; for(const c of cs) r[c]=listExpressions(c); return sendJson({ok:true,expressions:r,config:{emotionMap: State.emotionMap,enableAutoSwitch: State.enableAutoSwitch}}); } catch(e){return sendJson({ok:true,expressions:{},config:{emotionMap: State.emotionMap,enableAutoSwitch: State.enableAutoSwitch}}); } }
    } else {
      if (req.method === 'GET') return sendJson({ ok: true, expressions: listExpressions(charName) });
      if (req.method === 'DELETE') {
        // 删除单个表情（?name=表情名）
        const name = decodeURIComponent(req.url?.match(/[?&]name=([^&]+)/)?.[1] || '');
        if (!name) return sendJson({ error: '缺少表情名' }, 400);
        const safeName = sanitizeFileName(name, 40);
        const dir = path.join(EXPRESSIONS_DIR, charName);
        const file = path.join(dir, safeName);
        if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return sendJson({ error: '表情不存在' }, 404);
        try { fs.unlinkSync(file); return sendJson({ ok: true, deleted: safeName }); }
        catch (e) { return sendJson({ error: String(e) }, 400); }
      }
      if (req.method === 'POST') { const dir=path.join(EXPRESSIONS_DIR,charName); fs.mkdirSync(dir,{recursive:true}); let b=await readBody(req); try { const {name,imageData}=JSON.parse(b); const n=sanitizeFileName(name || '', 30); if(!n||!imageData) return sendJson({error:'缺少数据'},400); const m=imageData.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/); if(!m) return sendJson({error:'格式不支持'},400); const ext=m[1]==='jpeg'?'jpg':m[1]; fs.writeFileSync(path.join(dir,`${n}.${ext}`),Buffer.from(m[2],'base64')); return sendJson({ok:true}); } catch(e){return sendJson({error:String(e)},400);} }
    }
  }
  const expSM = p.match(/^\/api\/expressions\/static\/([^/]+)\/(.+)$/);
  if (expSM) { const charName = sanitizeFileName(decodeURIComponent(expSM[1]), 40); const fileName = sanitizeFileName(decodeURIComponent(expSM[2]), 60); if (!charName || !fileName) { res.writeHead(404); return res.end(); } const f=path.join(EXPRESSIONS_DIR,charName,fileName); if(fs.existsSync(f)){const ext=path.extname(f).toLowerCase(); const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[ext]||'application/octet-stream'; res.writeHead(200,{'content-type':mime,'cache-control':'public, max-age=86400'}); return res.end(fs.readFileSync(f));} res.writeHead(404); return res.end(); }
  // 输出过滤器
  if (p === '/api/regex-rules' && req.method === 'GET') { res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,rules:State.regexRules})); }
  if (p === '/api/regex-rules' && req.method === 'POST') { let b=await readBody(req); try { const {action,rule}=JSON.parse(b); if(action==='save'){const id=rule?.id||'rule_'+Date.now(); const idx=State.regexRules.findIndex(r=>r.id===id); const nr={id,name:String(rule?.name||'').slice(0,40),pattern:rule?.pattern||'',replacement:rule?.replacement||'',flags:rule?.flags||'g',enabled:rule?.enabled!==false}; if(idx>=0)State.regexRules[idx]=nr; else State.regexRules.push(nr); saveRegexRules(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,rule:nr})); } if(action==='delete'){State.regexRules=State.regexRules.filter(r=>r.id!==rule?.id); saveRegexRules(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true})); } if(action==='test'){try{const re=new RegExp(rule?.pattern||'',rule?.flags||'g'); const result=(rule?.testText||'').replace(re,rule?.replacement||''); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,result}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'正则错误：'+e.message}));} } res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'未知操作'})); } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  // 剧情建议
  if (p === '/api/suggestions/generate' && req.method === 'POST') { let b=await readBody(req); try { const {chatId}=JSON.parse(b); const cid=sanitizeId(chatId||''); const f=path.join(DATA_DIR,'chats',`${cid}.json`); if(!fs.existsSync(f)){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'对话不存在'}));} const chat=JSON.parse(fs.readFileSync(f,'utf8')); const recent=(chat.messages||[]).slice(-10).map(m=>`${m.role==='user'?'用户':'AI'}：${String(m.content||'').slice(0,200)}`).join('\n'); const prompt=`你是一位 RP 剧情顾问。基于当前对话上下文，给出 3-5 条后续剧情发展方向建议。\n每条建议包含：\n- title：30 字以内的方向概述\n- detail：100-200 字的具体展开\n- mood：建议的氛围（日常/紧张/温馨/战斗/悬疑）\n\n当前对话：\n${recent}\n\n输出纯 JSON 数组，不要其他文字。`; const result=await auxCall(prompt); try{const sg=JSON.parse(result); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,suggestions:sg}));}catch(e){const m=result.match(/```(?:json)?\s*([\s\S]*?)```/); if(m){try{const sg=JSON.parse(m[1].trim()); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,suggestions:sg}));}catch(e2){}} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'AI 返回格式错误',raw:result.slice(0,500)}));} } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  // 设定触发器（Lorebook）
  if (p === '/api/lorebook' && req.method === 'GET') { res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,entries:State.lorebookEntries,settings:State.lorebookSettings})); }
  if (p === '/api/lorebook' && req.method === 'POST') { let b=await readBody(req); try { const {action,id,entry,settings,testText}=JSON.parse(b); if(action==='save'){const eid=id||'entry_'+Date.now(); State.lorebookEntries[eid]={...State.lorebookEntries[eid],...entry,id:eid}; saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,id:eid}));} if(action==='delete'){delete State.lorebookEntries[id]; saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));} if(action==='settings'){State.lorebookSettings={...State.lorebookSettings,...settings}; saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,settings:State.lorebookSettings}));} if(action==='scan'){const chatId=entry?.chatId||''; const f=path.join(DATA_DIR,'chats',`${sanitizeId(chatId)}.json`); let msgs=[]; if(fs.existsSync(f)){try{msgs=JSON.parse(fs.readFileSync(f,'utf8')).messages||[];}catch(e){}} const result=scanLorebook(msgs,testText||'',State.endpoint.maxContext); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,...result}));} if(action==='import'){try{const imp=JSON.parse(entry?.json||'{}'); if(imp.entries) Object.assign(State.lorebookEntries,imp.entries); saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,count:Object.keys(imp.entries||{}).length}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'导入格式错误'}));}} if(action==='list-worldbook'){try{const customPath=entry?.path?path.resolve(ROOT,String(entry.path).trim()):null; const dir=customPath||path.join(ROOT,'canonical','lore','entries'); if(!fs.existsSync(dir)){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,entries:[],note:'canonical/lore/entries 不存在'}));} const files=fs.readdirSync(dir).filter(f=>f.endsWith('.md')).sort(); const list=[]; for(const f of files){try{const text=fs.readFileSync(path.join(dir,f),'utf8'); const fm=text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if(!fm) continue; const meta={}; for(const line of fm[1].split('\n')){const kv=line.match(/^(\w+):\s*(.+)$/); if(kv){const val=kv[2].trim(); if(val.startsWith('[')){try{meta[kv[1]]=JSON.parse(val);}catch(e){meta[kv[1]]=val.replace(/^\[|\]$/g,'').split(',').map(s=>s.trim().replace(/^"|"$/g,''));}} else meta[kv[1]]=val.replace(/^"|"$/g,'');}} const content=(fm[2]||'').trim().slice(0,3000); if(!meta.name||!content) continue; const key='wb-'+(meta.uid??f.replace(/.md$/,'')); const exists=!!State.lorebookEntries[key]||Object.values(State.lorebookEntries).some(e=>e.name===meta.name&&e.source==='worldbook'); list.push({id:key,name:meta.name,keywords:Array.isArray(meta.keywords)?meta.keywords:(meta.keywords?String(meta.keywords).split(',').map(s=>s.trim()):[meta.name]),constant:meta.constant===true||meta.constant==='true',contentLength:content.length,contentPreview:content.slice(0,80),exists});}catch(e){}} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,total:files.length,entries:list}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:false,error:String(e)}));}} if(action==='import-worldbook'){try{const ids=Array.isArray(entry?.ids)?entry.ids:[]; const customPath=entry?.path?path.resolve(ROOT,String(entry.path).trim()):null; const dir=customPath||path.join(ROOT,'canonical','lore','entries'); if(!fs.existsSync(dir)){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'canonical/lore/entries 不存在'}));} const files=fs.readdirSync(dir).filter(f=>f.endsWith('.md')); let imported=0; for(const f of files){try{const text=fs.readFileSync(path.join(dir,f),'utf8'); const fm=text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/); if(!fm) continue; const meta={}; for(const line of fm[1].split('\n')){const kv=line.match(/^(\w+):\s*(.+)$/); if(kv){const val=kv[2].trim(); if(val.startsWith('[')){try{meta[kv[1]]=JSON.parse(val);}catch(e){meta[kv[1]]=val.replace(/^\[|\]$/g,'').split(',').map(s=>s.trim().replace(/^"|"$/g,''));}} else meta[kv[1]]=val.replace(/^"|"$/g,'');}} const key='wb-'+(meta.uid??f.replace(/.md$/,'')); if(!ids.includes(key)) continue; const content=(fm[2]||'').trim().slice(0,3000); if(!meta.name||!content) continue; State.lorebookEntries[key]={name:String(meta.name).slice(0,40),keywords:(Array.isArray(meta.keywords)?meta.keywords:[meta.name]).map(k=>String(k).slice(0,30)).slice(0,10),content:content,priority:Number(meta.order)||200,enabled:true,constant:meta.constant===true||meta.constant==='true',source:'worldbook'}; imported++;}catch(e){}} saveLorebook(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,imported}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)}));}} if(action==='export'){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,data:{entries:State.lorebookEntries,settings:State.lorebookSettings}}));} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'未知操作'})); } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  // 关系图谱
  if (p === '/api/graph' && req.method === 'GET') { res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,...State.graphData})); }
  if (p === '/api/graph' && req.method === 'POST') { let b=await readBody(req); try { const {action,node,edge}=JSON.parse(b); if(action==='addNode'||action==='updateNode'){const id=node?.id||'node_'+Date.now(); const idx=State.graphData.nodes.findIndex(n=>n.id===id); const nn={id,name:node?.name||id,type:node?.type||'character',description:node?.description||'',tags:node?.tags||[]}; if(idx>=0)State.graphData.nodes[idx]=nn; else State.graphData.nodes.push(nn); saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,node:nn}));} if(action==='addEdge'||action==='updateEdge'){const id=edge?.id||'edge_'+Date.now(); const idx=State.graphData.edges.findIndex(e=>e.id===id); const ne={id,from:edge?.from||'',to:edge?.to||'',label:edge?.label||'',weight:edge?.weight||1,description:edge?.description||''}; if(idx>=0)State.graphData.edges[idx]=ne; else State.graphData.edges.push(ne); saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,edge:ne}));} if(action==='deleteNode'){State.graphData.nodes=State.graphData.nodes.filter(n=>n.id!==node?.id); State.graphData.edges=State.graphData.edges.filter(e=>e.from!==node?.id&&e.to!==node?.id); saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));} if(action==='deleteEdge'){State.graphData.edges=State.graphData.edges.filter(e=>e.id!==edge?.id); saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));} if(action==='import'){try{const imp=JSON.parse(node?.json||'{}'); if(imp.nodes) State.graphData.nodes=imp.nodes; if(imp.edges) State.graphData.edges=imp.edges; saveGraph(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));}catch(e){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'导入格式错误'}));}} if(action==='export'){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,data:State.graphData}));} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'未知操作'})); } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  // 玩家身份
  if (p === '/api/personas' && req.method === 'GET') { res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,personas: State.personas,active:State.activePersona})); }
  if (p === '/api/personas' && req.method === 'POST') { let b=await readBody(req); try { const {action,id,persona}=JSON.parse(b); if(action==='save'){const pid=id||'persona_'+Date.now(); State.personas[pid]={...State.personas[pid],...persona,name:(persona?.name||pid).slice(0,40)}; savePersonas(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,id:pid}));} if(action==='delete'){delete State.personas[id]; if(State.activePersona===id) State.activePersona=''; savePersonas(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true}));} if(action==='activate'){if(!State.personas[id]){res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:'身份不存在'}));} State.activePersona=id; savePersonas(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({ok:true,active:id}));} res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify({error:'未知操作'})); } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  // 剧情记忆配置（注入开关）
  if (p === '/api/story-memory/config' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, config: State.storyMemoryConfig }));
  }
  if (p === '/api/story-memory/config' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const updates = JSON.parse(body);
      State.storyMemoryConfig = { ...State.storyMemoryConfig, ...updates };
      saveStoryMemoryConfig();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, config: State.storyMemoryConfig }));
    } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); }
  }
  // 剧情记忆数据（前端展示用）
  if (p === '/api/story-memory/data' && req.method === 'GET') {
    const chatId = sanitizeId(req.url?.match(/chatId=([^&]+)/)?.[1] || '');
    if (!chatId) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '缺少 chatId' })); }
    const turns = readTurns(chatId);
    // 全部历史场景（按出现顺序保留，含时间/氛围/事件）
    const scenes = turns.filter(t => t.location).map(t => ({ story_time: t.story_time || '', location: t.location, atmosphere: t.atmosphere || '', event: t.event || '' }));
    const latestScene = scenes.length ? scenes[scenes.length - 1] : null;
    const allCharacterIntros = {};
    for (const t of turns) {
      if (t.character_intro && typeof t.character_intro === 'object') {
        for (const [name, intro] of Object.entries(t.character_intro)) {
          if (!allCharacterIntros[name]) allCharacterIntros[name] = intro;
        }
      }
    }
    const allRelationships = [];
    const seenRelKeys = new Set();
    for (const t of turns) {
      if (Array.isArray(t.relationships)) {
        for (const rel of t.relationships) {
          const key = `${rel.from}-${rel.to}`;
          if (!seenRelKeys.has(key)) { seenRelKeys.add(key); allRelationships.push(rel); }
        }
      }
    }
    // 地点详细档案（location_detail，按分组聚合，去重）
    const locationDetails = [];
    const seenLocKeys = new Set();
    for (const t of turns) {
      if (Array.isArray(t.location_detail)) {
        for (const loc of t.location_detail) {
          const key = `${loc.group}|${loc.name}`;
          if (!seenLocKeys.has(key)) { seenLocKeys.add(key); locationDetails.push(loc); }
        }
      }
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, scene: latestScene, scenes, characters: allCharacterIntros, relationships: allRelationships, locationDetails }));
  }
  // 地点档案合入 canonical/lore/地点.txt（带备份）
  // 剧情备忘
  const agendaM = p.match(/^\/api\/agenda(?:\/([^/]+))?$/);
  if (agendaM) { const cid = agendaM[1] ? sanitizeId(decodeURIComponent(agendaM[1])) : null; const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); }; if (cid) { if (req.method === 'GET') return sendJson({ ok: true, ...loadAgenda(cid) }); if (req.method === 'POST') { let b = await readBody(req); try { const { action, item } = JSON.parse(b); const a = loadAgenda(cid); if (action === 'add') { const id = 'agenda_' + Date.now(); a.items.push({ id, content: item?.content || '', createdAt: new Date().toISOString(), status: 'pending', priority: item?.priority || 'normal', source: item?.source || 'manual' }); saveAgenda(cid, a); return sendJson({ ok: true, id }); } if (action === 'complete') { const idx = a.items.findIndex(i => i.id === item?.id); if (idx >= 0) { a.items[idx].status = 'completed'; a.items[idx].completedAt = new Date().toISOString(); saveAgenda(cid, a); } return sendJson({ ok: true }); } if (action === 'delete') { a.items = a.items.filter(i => i.id !== item?.id); saveAgenda(cid, a); return sendJson({ ok: true }); } return sendJson({ error: '未知操作' }); } catch (e) { return sendJson({ error: String(e) }, 400); } } } }
  // 报告系统
  if (p === '/api/report/list' && req.method === 'GET') { const cid = url.searchParams.get('chatId') || ''; res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, reports: listReports(cid) })); }
  // 报告内容读取（M6：前端 loadReportListUI 点击报告使用；filename 白名单校验防穿越）
  const reportReadM = p.match(/^\/api\/report\/([^/]+)\/([^/]+)$/);
  if (reportReadM && req.method === 'GET') {
    const cid = sanitizeId(decodeURIComponent(reportReadM[1]));
    const filename = sanitizeFileName(decodeURIComponent(reportReadM[2]), 80);
    const dir = path.join(REPORTS_DIR, cid);
    const file = path.join(dir, filename);
    try {
      if (!fs.existsSync(file) || path.dirname(file) !== dir) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '报告不存在' }));
      }
      const content = fs.readFileSync(file, 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, content }));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  if (p === '/api/report/overview' && req.method === 'POST') { let b = await readBody(req); try { const { chatId, range } = JSON.parse(b); const cid = sanitizeId(chatId || ''); const f = path.join(DATA_DIR, 'chats', `${cid}.json`); if (!fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '对话不存在' })); } const chat = JSON.parse(fs.readFileSync(f, 'utf8')); const msgs = (chat.messages || []).slice(range === 'last10' ? -10 : range === 'today' ? -50 : -200); const recent = msgs.map(m => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content || '').slice(0, 300)}`).join('\n'); const prompt = `你是一位 RP 回顾分析师。基于以下对话，生成回顾报告。\n\n报告格式：\n# RP 回顾报告\n\n## 关键事件\n- [时间] 事件描述\n\n## 角色发展\n- 角色名：成长/变化\n\n## 互动要点\n- 重要对话/决策\n\n## 未完事项\n- 伏笔/待续\n\n对话内容：\n${recent}\n\n输出 Markdown 格式的报告。`; const result = await auxCall(prompt); const filename = saveReport(cid, 'overview', result); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, content: result, filename })); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); } }
  if (p === '/api/report/audit' && req.method === 'POST') { let b = await readBody(req); try { const { chatId, range } = JSON.parse(b); const cid = sanitizeId(chatId || ''); const f = path.join(DATA_DIR, 'chats', `${cid}.json`); if (!fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '对话不存在' })); } const chat = JSON.parse(fs.readFileSync(f, 'utf8')); const msgs = (chat.messages || []).slice(range === 'last10' ? -10 : range === 'today' ? -50 : -200); const recent = msgs.map(m => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content || '').slice(0, 300)}`).join('\n'); const prompt = `你是一位 RP 质量审查员。基于以下对话，生成自检报告。\n\n评估维度：\n1. 角色一致性（言行是否符合设定）\n2. 时间线连贯性（时间/地点是否矛盾）\n3. 物品/状态一致性（持有物/能力是否合理）\n4. 对话质量（回复长度/风格/情感）\n5. 伏笔追踪（已埋伏笔是否被遗忘）\n\n报告格式：\n# AI 自检报告\n\n## 总评\n- 综合评分：X/10\n\n## 各维度评分\n| 维度 | 评分 | 问题 |\n|---|---|---|\n| 角色一致性 | X/10 | ... |\n\n## 具体问题\n- 问题描述 + 对应消息\n\n## 改进建议\n- 建议内容\n\n对话内容：\n${recent}\n\n输出 Markdown 格式的报告。`; const result = await auxCall(prompt); const filename = saveReport(cid, 'audit', result); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, content: result, filename })); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); } }
  // 回溯分析
  if (p === '/api/analyze/retro' && req.method === 'POST') { let b = await readBody(req); try { const { chatId } = JSON.parse(b); const cid = sanitizeId(chatId || ''); const f = path.join(DATA_DIR, 'chats', `${cid}.json`); if (!fs.existsSync(f)) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '对话不存在' })); } const chat = JSON.parse(fs.readFileSync(f, 'utf8')); const allMsgs = chat.messages || []; const batchSize = 20; const results = []; for (let i = 0; i < allMsgs.length; i += batchSize) { const batch = allMsgs.slice(i, i + batchSize); const batchText = batch.map(m => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.content || '').slice(0, 200)}`).join('\n'); const prompt = `分析以下 RP 对话片段，提取关键信息：\n1. 新出现的角色\n2. 关系变化\n3. 重要事件\n4. 物品/状态变化\n5. 场景变化\n\n对话：\n${batchText}\n\n输出 JSON 格式：{"characters":[],"relationships":[],"events":[],"items":[],"scenes":[]}`; try { const result = await auxCall(prompt); const parsed = JSON.parse(result.replace(/```(?:json)?\s*([\s\S]*?)```/, '$1').trim()); results.push(parsed); } catch (e) {} } const merged = { characters: [], relationships: [], events: [], items: [], scenes: [] }; for (const r of results) { if (r.characters) merged.characters.push(...r.characters); if (r.relationships) merged.relationships.push(...r.relationships); if (r.events) merged.events.push(...r.events); if (r.items) merged.items.push(...r.items); if (r.scenes) merged.scenes.push(...r.scenes); } const report = `# 回溯分析报告\n\n## 角色（${merged.characters.length}）\n${merged.characters.map(c => `- ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n')}\n\n## 关系变化（${merged.relationships.length}）\n${merged.relationships.map(r => `- ${typeof r === 'string' ? r : JSON.stringify(r)}`).join('\n')}\n\n## 重要事件（${merged.events.length}）\n${merged.events.map(e => `- ${typeof e === 'string' ? e : JSON.stringify(e)}`).join('\n')}\n\n## 物品/状态（${merged.items.length}）\n${merged.items.map(i => `- ${typeof i === 'string' ? i : JSON.stringify(i)}`).join('\n')}\n\n## 场景（${merged.scenes.length}）\n${merged.scenes.map(s => `- ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n')}`; const filename = saveReport(cid, 'retro', report); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, content: report, filename, stats: { messages: allMsgs.length, batches: results.length } })); } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); } }
  // 语义回忆：BM25 搜索聊天历史（跨会话或指定会话）
  if (p === '/api/memory/search' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { query, chatId, limit: lim } = JSON.parse(body);
      if (!query || !String(query).trim()) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '缺少查询词' })); }
      const limNum = Number(lim);
      const maxResults = Math.min(Number.isFinite(limNum) ? limNum : 20, 50);
      const qTokens = tokenize(String(query));
      if (!qTokens.length) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: true, results: [], total: 0 })); }
      const MAX_MSGS = 5000;
      const chatFiles = chatId
        ? [path.join(DATA_DIR, 'chats', `${sanitizeId(chatId)}.json`)]
        : (() => { try { return fs.readdirSync(path.join(DATA_DIR, 'chats')).filter(f => f.endsWith('.json')).map(f => path.join(DATA_DIR, 'chats', f)); } catch (e) { return []; } })();
      const allMsgs = [];
      for (const f of chatFiles) {
        if (!fs.existsSync(f)) continue;
        try {
          const chat = JSON.parse(fs.readFileSync(f, 'utf8'));
          const cid = chat.id || path.basename(f, '.json');
          for (const m of (chat.messages || [])) {
            if (allMsgs.length >= MAX_MSGS) break;
            const txt = String(m.content || '');
            if (txt.length < 5) continue;
            allMsgs.push({ chatId: cid, role: m.role || 'unknown', content: txt.slice(0, 1000), seq: m.seq || 0, chatTitle: chat.title || cid });
          }
          if (allMsgs.length >= MAX_MSGS) break;
        } catch (e) { /* 跳过 */ }
      }
      const avgDl = allMsgs.length ? allMsgs.reduce((s, m) => s + tokenize(m.content).length, 0) / allMsgs.length : 1;
      const df = {};
      const msgTokens = allMsgs.map(m => { const t = tokenize(m.content); for (const w of new Set(t)) df[w] = (df[w] || 0) + 1; return t; });
      const N = allMsgs.length;
      const k1 = 1.5, b = 0.75;
      const scored = allMsgs.map((m, i) => {
        const tokens = msgTokens[i]; const dl = tokens.length || 1;
        const tfMap = {}; for (const t of tokens) tfMap[t] = (tfMap[t] || 0) + 1;
        let score = 0;
        for (const qt of qTokens) { const tf = tfMap[qt] || 0; const docFreq = df[qt] || 0; const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1); score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgDl)); }
        return { ...m, score };
      });
      scored.sort((a, b) => b.score - a.score);
      const results = scored.filter(r => r.score > 0.1).slice(0, maxResults);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, results, total: N, queryTokens: qTokens.length }));
    } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); }
  }
  // 卡片交换：PNG tEXt chunk 工具函数（兼容酒馆角色卡格式）
  function pngReadTextChunks(buffer) {
    const chunks = [];
    try {
      const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (!buffer.slice(0, 8).equals(sig)) return chunks;
      let pos = 8;
      while (pos < buffer.length - 12) {
        const len = buffer.readUInt32BE(pos);
        // 防止恶意 PNG：chunk 长度不能超过剩余 buffer
        if (len > buffer.length - pos - 12 || len < 0) break;
        const type = buffer.slice(pos + 4, pos + 8).toString('ascii');
        const data = buffer.slice(pos + 8, pos + 8 + len);
        if (type === 'tEXt') {
          const nullIdx = data.indexOf(0);
          if (nullIdx > 0) chunks.push({ keyword: data.slice(0, nullIdx).toString('ascii'), text: data.slice(nullIdx + 1).toString('utf8') });
        }
        pos += 12 + len;
      }
    } catch (e) {}
    return chunks;
  }
  function pngCreateWithTextChunk(imageBuffer, keyword, text) {
    try {
      const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (!imageBuffer.slice(0, 8).equals(sig)) return null;
      const keywordBuf = Buffer.from(keyword, 'ascii');
      const textBuf = Buffer.from(text, 'utf8');
      const chunkData = Buffer.concat([keywordBuf, Buffer.from([0]), textBuf]);
      const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(chunkData.length, 0);
      const typeBuf = Buffer.from('tEXt', 'ascii');
      const crcData = Buffer.concat([typeBuf, chunkData]);
      const _t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _t[n] = c >>> 0; }
      let crc = 0xFFFFFFFF; for (let i = 0; i < crcData.length; i++) crc = _t[(crc ^ crcData[i]) & 0xFF] ^ (crc >>> 8); crc = (crc ^ 0xFFFFFFFF) >>> 0;
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc, 0);
      const textChunk = Buffer.concat([lenBuf, typeBuf, chunkData, crcBuf]);
      let iendPos = -1, pos = 8;
      while (pos < imageBuffer.length - 12) { const len = imageBuffer.readUInt32BE(pos); if (len > imageBuffer.length - pos - 12 || len < 0) break; const type = imageBuffer.slice(pos + 4, pos + 8).toString('ascii'); if (type === 'IEND') { iendPos = pos; break; } pos += 12 + len; }
      if (iendPos < 0) return null;
      return Buffer.concat([imageBuffer.slice(0, iendPos), textChunk, imageBuffer.slice(iendPos)]);
    } catch (e) { return null; }
  }
  // 卡片交换 API：导出角色卡 PNG
  const cardsExpM = p.match(/^\/api\/cards\/export\/([^/]+)$/);
  if (cardsExpM && req.method === 'GET') {
    try {
      const charName = sanitizeFileName(decodeURIComponent(cardsExpM[1]));
      const profileFile = path.join(NPC_PROFILES_DIR, `${charName}.json`);
      if (!fs.existsSync(profileFile)) { res.writeHead(404); return res.end('角色不存在'); }
      const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
      const charCard = { name: profile.name || charName, description: profile.appearance || '', personality: profile.personality || '', mes_example: '', system_prompt: '', tags: profile.tags || [], creator: 'rabbit-web', character_version: '1.0', extensions: { relationships: profile.relationships || {}, age: profile.age, ageNote: profile.ageNote, firstAppearance: profile.firstAppearance, notes: profile.notes } };
      const charJson = JSON.stringify(charCard);
      const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
      const result = pngCreateWithTextChunk(pngBuffer, 'chara', Buffer.from(charJson).toString('base64'));
      if (!result) { res.writeHead(500); return res.end('PNG 生成失败'); }
      // RFC 5987：filename* 支持中文文件名，filename 用 ASCII 兜底
      res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': `attachment; filename="card.png"; filename*=UTF-8''${encodeURIComponent(charName)}.png` });
      return res.end(result);
    } catch (e) { res.writeHead(500); return res.end('导出失败：' + String(e)); }
  }
  // 卡片交换 API：导入角色卡 PNG
  if (p === '/api/cards/import' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { imageData } = JSON.parse(body);
      if (!imageData) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '缺少图片数据' })); }
      let buf;
      if (typeof imageData === 'string' && imageData.startsWith('data:image/png;base64,')) buf = Buffer.from(imageData.split(',')[1], 'base64');
      else if (typeof imageData === 'string') buf = Buffer.from(imageData, 'base64');
      else buf = Buffer.from(imageData);
      const chunks = pngReadTextChunks(buf);
      const charaChunk = chunks.find(c => c.keyword === 'chara');
      if (!charaChunk) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: 'PNG 中未找到角色卡数据（缺少 chara tEXt chunk）' })); }
      const charData = JSON.parse(Buffer.from(charaChunk.text, 'base64').toString('utf8'));
      const profile = { name: sanitizeFileName(String(charData.name || '未命名').slice(0, 40)), aliases: charData.tags || [], appearance: charData.description || '', personality: charData.personality || '', age: charData.extensions?.age || null, ageNote: charData.extensions?.ageNote || '', relationships: charData.extensions?.relationships || {}, firstAppearance: charData.extensions?.firstAppearance || '导入自酒馆角色卡', lastUpdated: new Date().toISOString(), notes: charData.extensions?.notes || '', tags: charData.tags || [] };
      saveNpcProfile(profile.name, profile);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, profile, source: 'png-import' }));
    } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); }
  }
  // 场景插图：AI 图片生成（硅基流动，OpenAI 兼容 /images/generations）
  // Kolors 免费；Z-Image/Qwen-Image/ERNIE 等按张计费（¥0.10-0.30/张，共用同一 key）
  const SILICON_BASE = 'https://api.siliconflow.cn/v1';
  const SILICON_IMG_MODELS = {
    kolors:  { id: 'Kwai-Kolors/Kolors',               label: 'Kolors（免费）',       price: '免费' },
    zimage:  { id: 'Tongyi-MAI/Z-Image',               label: 'Z-Image（高质量）',     price: '¥0.30/张' },
    zturb:   { id: 'Tongyi-MAI/Z-Image-Turbo',         label: 'Z-Image-Turbo（快速）', price: '¥0.10/张' },
    qwenimg: { id: 'Qwen/Qwen-Image',                  label: 'Qwen-Image（通用）',    price: '¥0.30/张' },
    ernie:   { id: 'baidu/ERNIE-Image-Turbo',          label: 'ERNIE-Image（快速）',   price: '¥0.11/张' }
  };
  function getSiliconImgKey() {
    try {
      const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'models.json');
      if (!fs.existsSync(cfgPath)) return '';
      const arr = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const entry = (Array.isArray(arr) ? arr : []).find((m) => /siliconflow/i.test((m.url || '') + (m.id || '') + (m.name || '')));
      return (entry && entry.apiKey) || '';
    } catch (e) { return ''; }
  }
  if (p === '/api/illustration/generate' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { prompt, style, chatId, sceneryOnly } = JSON.parse(body);
      if (!prompt || !String(prompt).trim()) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '缺少场景描述' })); }
      const illustConfigFile = path.join(DATA_DIR, 'illustration-config.json');
      let config = { engine: 'kolors', apiKey: '', baseURL: SILICON_BASE };
      try { if (fs.existsSync(illustConfigFile)) config = Object.assign({ engine: 'kolors', apiKey: '', baseURL: SILICON_BASE }, JSON.parse(fs.readFileSync(illustConfigFile, 'utf8'))); } catch (e) {}
      const key = config.apiKey || getSiliconImgKey();
      if (!key) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '图片生成功能未配置。请在设置中配置硅基流动 API Key，或确认 ~/.workbuddy/models.json 中存在硅基流动端点。', needConfig: true }));
      }
      const baseURL = (config.baseURL || SILICON_BASE).replace(/\/+$/, '');
      const modelKey = String(config.engine || 'kolors');
      const modelCfg = SILICON_IMG_MODELS[modelKey] || SILICON_IMG_MODELS.kolors;
      const model = typeof modelCfg === 'string' ? modelCfg : modelCfg.id;
      const body_s = { model, prompt: String(prompt).trim(), image_size: '1024x1024', batch_size: 1, num_inference_steps: 24, guidance_scale: 7.5 };
      // 纯场景模式：用 negative_prompt 排除人物，让图片只出场景/环境
      if (sceneryOnly) {
        body_s.negative_prompt = 'person, people, human, character, figure, portrait, man, woman, boy, girl, face, body, crowd, group, silhouette';
      }
      const r = await fetch(`${baseURL}/images/generations`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body_s)
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const errMsg = (data && data.message) || (data && data.error && data.error.message) || `接口错误(${r.status})`;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: errMsg, status: r.status }));
      }
      const img = (data.images && Array.isArray(data.images) && data.images[0]) || null;
      if (!img) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '接口返回了意外的数据结构', status: 502 }));
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, image: img, model, engine: modelKey, label: modelCfg.label || model, price: modelCfg.price || '' }));
    } catch (e) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e), status: 500 })); }
  }
  if (p === '/api/illustration/config' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { engine, apiKey, baseURL } = JSON.parse(body);
      const illustConfigFile = path.join(DATA_DIR, 'illustration-config.json');
      let config = { engine: 'kolors', apiKey: '', baseURL: SILICON_BASE };
      try { if (fs.existsSync(illustConfigFile)) config = Object.assign(config, JSON.parse(fs.readFileSync(illustConfigFile, 'utf8'))); } catch (e) {}
      if (engine) config.engine = String(engine).slice(0, 20);
      if (apiKey) config.apiKey = String(apiKey).slice(0, 200);
      if (baseURL) config.baseURL = String(baseURL).slice(0, 300);
      fs.writeFileSync(illustConfigFile, JSON.stringify(config, null, 2), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, config: { engine: config.engine, configured: !!config.apiKey } }));
    } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); }
  }
  // 提示词优化：把中文场景描述润色成高质量英文生图提示词。
  // 独立用 models.json 里的硅基流动对话端点（生图同款 key 可通用于 chat），不依赖主端点(可能失效的 key)
  function getSiliconChatCfg() {
    try {
      const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'models.json');
      if (!fs.existsSync(cfgPath)) return null;
      const arr = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const entry = (Array.isArray(arr) ? arr : []).find((m) => /siliconflow/i.test((m.url || '') + (m.id || '') + (m.name || '')));
      if (!entry || !entry.apiKey) return null;
      const url = (entry.url || '').replace(/\/+$/, '');
      const chatUrl = /\/chat\/completions$/.test(url) ? url : (url.includes('/chat/completions') ? url : `${url}/chat/completions`);
      return { chatUrl, key: entry.apiKey, model: entry.id || entry.name || 'deepseek-ai/DeepSeek-V4-Flash' };
    } catch (e) { return null; }
  }
  if (p === '/api/illustration/enhance' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { prompt, style } = JSON.parse(body);
      if (!prompt || !String(prompt).trim()) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '缺少场景描述' })); }
      const cfg = getSiliconChatCfg();
      if (!cfg) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '未能从 ~/.workbuddy/models.json 读取硅基流动对话端点，无法优化提示词', status: 503 })); }
      const styleHint = style ? `（风格：${style}）` : '';
      const sys = '你是专业 AI 绘画提示词工程师。请把用户的中文场景描述改写成一段高质量、可直接用于文生图模型的英文提示词。要求：只输出英文提示词正文，不要任何解释、编号、引号或多余文字；用逗号分隔的关键词短语，包含场景环境、光线、氛围、主体、材质/风格关键词；控制在 6-12 个短语内。';
      const callR = await fetch(cfg.chatUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: 'user', content: `${sys}\n\n${prompt}\n${styleHint}` }], max_tokens: 400 }),
        signal: AbortSignal.timeout(60000),
      });
      if (!callR.ok) { const t = await callR.text().catch(()=>''); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: `LLM 调用失败: HTTP ${callR.status} ${t.slice(0,160)}`, status: callR.status })); }
      const dd = await callR.json().catch(() => ({}));
      const enhanced = ((dd.choices && dd.choices[0] && dd.choices[0].message && dd.choices[0].message.content) || '').trim();
      if (!enhanced) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '优化失败，返回为空', status: 502 })); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, enhanced }));
    } catch (e) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e), status: 500 })); }
  }
  // 语音朗读：TTS 配置和合成
  // MiMo 官方 TTS（token-plan 免费，OpenAI 兼容 chat/completions + audio）
  const MIMO_TTS_MODEL = 'mimo-v2.5-tts';
  const MIMO_TTS_BASE = 'https://token-plan-cn.xiaomimimo.com/v1';
  const MIMO_TTS_VOICES = ['mimo_default', 'default_zh', 'default_en', 'Mia', 'Chloe', 'Milo', 'Dean'];
  function getMimoTtsKey() {
    // 复用 WorkBuddy 模型配置里的 MiMo key（tp-...，token-plan 免费）
    try {
      const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'models.json');
      if (!fs.existsSync(cfgPath)) return '';
      const arr = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const entry = (Array.isArray(arr) ? arr : []).find((m) => /mimo/i.test(m.id || m.name || '') && /^tp-/.test(m.apiKey || ''));
      return (entry && entry.apiKey) || '';
    } catch (e) { return ''; }
  }
  const defaultTtsConfig = () => ({ engine: 'mimo', apiKey: '', voice: 'mimo_default', rate: '1.0', baseURL: MIMO_TTS_BASE });
  if (p === '/api/tts/config' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { engine, apiKey, voice, rate, baseURL, model } = JSON.parse(body);
      const ttsConfigFile = path.join(DATA_DIR, 'tts-config.json');
      let config = defaultTtsConfig();
      try { if (fs.existsSync(ttsConfigFile)) config = JSON.parse(fs.readFileSync(ttsConfigFile, 'utf8')); } catch (e) {}
      if (engine) config.engine = String(engine).slice(0, 20);
      if (apiKey) config.apiKey = String(apiKey).slice(0, 200);
      if (voice) config.voice = String(voice).slice(0, 50);
      if (rate) config.rate = String(rate).slice(0, 10);
      if (baseURL) config.baseURL = String(baseURL).slice(0, 300);
      if (model) config.model = String(model).slice(0, 40);
      fs.writeFileSync(ttsConfigFile, JSON.stringify(config, null, 2), 'utf8');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, config: { engine: config.engine, voice: config.voice, rate: config.rate, configured: config.engine !== 'none' } }));
    } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); }
  }
  if (p === '/api/tts/config' && req.method === 'GET') {
    const ttsConfigFile = path.join(DATA_DIR, 'tts-config.json');
    let config = defaultTtsConfig();
    try { if (fs.existsSync(ttsConfigFile)) config = JSON.parse(fs.readFileSync(ttsConfigFile, 'utf8')); } catch (e) {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, config: { engine: config.engine, voice: config.voice, rate: config.rate, configured: config.engine !== 'none' } }));
  }
  if (p === '/api/tts/synthesize' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { text, voice, rate, model, style, referenceAudio, character } = JSON.parse(body);
      if (!text || !String(text).trim()) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '缺少文本' })); }
      const ttsConfigFile = path.join(DATA_DIR, 'tts-config.json');
      let config = defaultTtsConfig();
      try { if (fs.existsSync(ttsConfigFile)) config = JSON.parse(fs.readFileSync(ttsConfigFile, 'utf8')); } catch (e) {}
      const useVoice = voice || config.voice || 'mimo_default';
      const useRate = rate || config.rate || '1.0';
      
      // 角色绑定：如果指定了角色，从 character-voices.json 读取对应的参考音频和语音提示词
      let characterRefAudio = null;
      let characterModel = null;
      let characterStyle = null;
      if (character && !referenceAudio) {
        try {
          const charVoiceFile = path.join(DATA_DIR, 'character-voices.json');
          if (fs.existsSync(charVoiceFile)) {
            const charVoices = JSON.parse(fs.readFileSync(charVoiceFile, 'utf8'));
            const charConfig = charVoices['角色音色映射'][character];
            if (charConfig) {
              // 读取参考音频
              if (charConfig['参考音频']) {
                const refPath = path.join(CHARACTERS_DIR, '参考音频', charConfig['参考音频']);
                if (fs.existsSync(refPath)) {
                  characterRefAudio = { mime: 'audio/mpeg', data: fs.readFileSync(refPath).toString('base64') };
                  characterModel = 'mimo-v2.5-tts-voiceclone';
                  console.log(`[TTS] 角色绑定: ${character} → ${charConfig['参考音频']}`);
                }
              }
              // 读取语音提示词（用于 style 参数）
              if (charConfig['语音提示词']) {
                characterStyle = charConfig['语音提示词'];
                console.log(`[TTS] 角色提示词: ${character} → ${characterStyle.slice(0, 50)}...`);
              }
            }
          }
        } catch (e) { console.error('[TTS] 角色绑定失败:', e.message); }
      }
      
      if (config.engine === 'mimo') {
        // MiMo 官方 TTS：文本放 assistant 消息，audio 参数指定音色（token-plan 免费）
        // 三模型：mimo-v2.5-tts（内置音色）/ -voicedesign（文字设计声线）/ -voiceclone（参考音频克隆）
        const mimoKey = config.apiKey || getMimoTtsKey();
        if (!mimoKey) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '未找到 MiMo API Key。可在 TTS 配置中手动填写，或确认 ~/.workbuddy/models.json 里有 MiMo (tp-) 配置。', needConfig: true }));
        }
        const useModel = String(model || characterModel || config.model || MIMO_TTS_MODEL).slice(0, 40);
        if (!/^mimo-v2\.5-tts/.test(useModel)) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '不支持的 TTS 模型：' + useModel }));
        }
        // 组装 messages：风格/声音描述放 user（voicedesign 必填），朗读文本放 assistant
        // 优先级：请求中的 style > 角色绑定的语音提示词 > 默认提示词
        const styleText = String(style || characterStyle || '').trim();
        const messages = [
          ...(styleText ? [{ role: 'user', content: styleText.slice(0, 800) }] : []),
          ...(useModel === 'mimo-v2.5-tts-voicedesign' && !styleText ? [{ role: 'user', content: '请用自然、生动、清晰的语气朗读下面这段文本。' }] : []),
          { role: 'assistant', content: String(text).trim().slice(0, 2000) },
        ];
        const audioParam = { format: 'mp3' };
        let voiceLabel = useVoice;
        if (useModel === 'mimo-v2.5-tts') {
          audioParam.voice = useVoice;
        } else if (useModel === 'mimo-v2.5-tts-voiceclone') {
          // 参考音频来源：优先使用角色绑定的参考音频，其次使用请求中的 referenceAudio
          const ref = characterRefAudio || (referenceAudio && referenceAudio.data ? referenceAudio : null);
          if (!ref) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ error: '声音克隆需要参考音频（mp3/wav）或指定角色' }));
          }
          const mime = /wav/i.test(ref.mime || '') ? 'audio/wav' : 'audio/mpeg';
          audioParam.voice = `data:${mime};base64,${String(ref.data).slice(0, 14 * 1024 * 1024)}`;
          audioParam.format = 'wav';   // 官方 clone 示例用 wav
          voiceLabel = character ? `${character}的声音` : '克隆音色';
        }
        // voicedesign：不传 audio.voice（由风格描述生成声线）
        const base = (config.baseURL || MIMO_TTS_BASE).replace(/\/+$/, '');
        const audioResp = await fetch(base + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + mimoKey },
          body: JSON.stringify({ model: useModel, messages, audio: audioParam, stream: false }),
        });
        if (!audioResp.ok) {
          const errText = await audioResp.text();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: `MiMo TTS 请求失败（HTTP ${audioResp.status}）：${errText.slice(0, 200)}` }));
        }
        const ar = await audioResp.json();
        const audioData = ar && ar.choices && ar.choices[0] && ar.choices[0].message && ar.choices[0].message.audio && ar.choices[0].message.audio.data;
        if (!audioData) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'MiMo TTS 响应缺少音频数据', raw: JSON.stringify(ar).slice(0, 200) }));
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, audio: audioData, format: audioParam.format, voice: voiceLabel, model: useModel, message: `MiMo TTS 合成成功（${useModel === 'mimo-v2.5-tts' ? voiceLabel : useModel === 'mimo-v2.5-tts-voicedesign' ? '声线设计' : '声音克隆'}）` }));
      }
      if (config.engine === 'none') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '语音合成功能未配置。请在设置中配置 TTS 引擎（支持 MiMo TTS / Edge TTS / OpenAI TTS）。', needConfig: true }));
      }
      // edge/openai 引擎：预留（需接入对应 SDK/API 后启用）
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, status: 'pending', message: `TTS 引擎 ${config.engine} 尚未接入实际合成，当前请使用 MiMo 引擎。`, config: { engine: config.engine, voice: useVoice, rate: useRate } }));
    } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(e) })); }
  }
  // 旁注
  const annotM = p.match(/^\/api\/annotations(?:\/([^/]+))?$/);
  if (annotM) { const cid = annotM[1] ? sanitizeId(decodeURIComponent(annotM[1])) : null; const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); }; if (cid) { if (req.method === 'GET') return sendJson({ ok: true, ...loadAnnotations(cid) }); if (req.method === 'POST') { let b = await readBody(req); try { const { action, note } = JSON.parse(b); const ann = loadAnnotations(cid); if (action === 'add') { const id = 'ann_' + Date.now(); ann.notes.push({ id, position: note?.position || 3, content: note?.content || '', enabled: true, createdAt: new Date().toISOString() }); saveAnnotations(cid, ann); return sendJson({ ok: true, id }); } if (action === 'update') { const idx = ann.notes.findIndex(n => n.id === note?.id); if (idx >= 0) { ann.notes[idx] = { ...ann.notes[idx], ...note }; saveAnnotations(cid, ann); } return sendJson({ ok: true }); } if (action === 'delete') { ann.notes = ann.notes.filter(n => n.id !== note?.id); saveAnnotations(cid, ann); return sendJson({ ok: true }); } return sendJson({ error: '未知操作' }); } catch (e) { return sendJson({ error: String(e) }, 400); } } } }
  // 界面操作：会话常驻设定（📌 每轮注入 system，不被上下文裁剪；按会话隔离）
  // Task15 多槽位：GET 返回 {note:合并文本, slots:{背景,关系,规则,其他}}；POST 支持 slots 对象或旧字符串 note
  if (p === '/api/op/note' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, note, get, slots } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      if (get) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ note: noteText(cid), slots: noteSlots(cid) }));
      }
      // 多槽位保存（新前端）：slots 对象 → 存对象（仅保留已知槽位；全空 = 清空）
      if (slots && typeof slots === 'object') {
        const clean = {};
        let hasAny = false;
        for (const k of NOTE_SLOTS) {
          const v = slots[k];
          if (v != null && typeof v === 'string' && v.trim()) { clean[k] = v.trim().slice(0, 4000); hasAny = true; }
        }
        if (hasAny) State.opState.notes[cid] = clean; else delete State.opState.notes[cid];
        saveOpState();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true, saved: hasAny, note: hasAny ? '会话常驻设定已保存（每轮注入 system）' : '会话常驻设定已清空' }));
      }
      // 旧接口兼容：字符串 note → 视为「其他」槽（读取时按迁移逻辑归位）；与 slots 路径一致截断 4000
      const n = String(note || '').trim().slice(0, 4000);
      if (n) State.opState.notes[cid] = n; else delete State.opState.notes[cid];
      saveOpState();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, saved: !!n, note: n ? '会话常驻设定已保存（每轮注入 system）' : '会话常驻设定已清空' }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // 界面操作：自定义注入槽（⚙️ 前缀 / 后缀，按会话，随 system 注入）
  if (p === '/api/op/inject' && req.method === 'GET') {
    const inj = customInjections(url.searchParams.get('chatId') || '');
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ok: true, ...inj }));
  }
  if (p === '/api/op/inject' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, prefix, suffix } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      const cur = customInjections(chatId || '');
      const next = {
        prefix: String(prefix != null ? prefix : cur.prefix).trim().slice(0, 2000),
        suffix: String(suffix != null ? suffix : cur.suffix).trim().slice(0, 2000),
      };
      if (!State.opState.customInjections) State.opState.customInjections = {};
      if (next.prefix || next.suffix) State.opState.customInjections[cid] = next;
      else delete State.opState.customInjections[cid];
      saveOpState();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, note: next.prefix || next.suffix ? '自定义注入已保存（前缀/后缀随 system 注入，下一轮生效）' : '自定义注入已清空' }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // 情绪追踪：查看（按会话聚合） / 设置 / 清除
  if (p === '/api/emotions' && req.method === 'GET') {
    const emo = buildEmotions(sanitizeId(url.searchParams.get('chatId') || ''));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ emotions: emo }));
  }
  if (p === '/api/op/emotion' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, name, emotion } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      const nm = String(name || '').trim().slice(0, 20);
      if (!nm) throw new Error('缺少角色名');
      setEmotion(cid, nm, String(emotion || '').trim().slice(0, 120));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      const cur = buildEmotions(cid);
      return res.end(JSON.stringify({ ok: true, emotions: cur, note: emotion && String(emotion).trim() ? `已记录 ${nm} 的情绪（已记账，可导出回合记录）` : `已清除 ${nm} 的情绪记录` }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }

  // 历史消息检索（本地关键词，零 API）
  if (p === '/api/history/search' && req.method === 'GET') return handleHistorySearch(url, res);

  // 会话统计：当前模型 + 全部合计 + 每日费用（Task6）
  if (p === '/api/stats' && req.method === 'GET') {
    const cur = summarize(stats.byModel[State.endpoint.model] || emptyBucket());
    const total = Object.values(stats.byModel).reduce((acc, b) => {
      acc.turns += b.turns; acc.calls += b.calls; acc.llmMs += b.llmMs;
      acc.firstTokenSum += b.firstTokenSum; acc.firstTokenN += b.firstTokenN;
      acc.tokensIn += b.tokensIn; acc.tokensOut += b.tokensOut;
      acc.cacheRead += b.cacheRead; acc.cacheMiss += b.cacheMiss;
      return acc;
    }, emptyBucket());
    const t = summarize(total);
    // 每日费用统计（按调用完成日期分桶；价目 PRICE_TABLE，仅估算非账单）
    const daily = Object.entries(stats.daily || {}).map(([date, d]) => {
      let cost = 0;
      const models = [];
      for (const [m, mb] of Object.entries(d.models || {})) {
        const c = estimateCost(mb, m);
        cost += c;
        models.push({ model: m, calls: mb.calls, tokensIn: mb.tokensIn, tokensOut: mb.tokensOut, cacheRead: mb.cacheRead, cacheMiss: mb.cacheMiss, cost: Math.round(c * 10000) / 10000 });
      }
      models.sort((a, b) => b.cost - a.cost);
      return { date, calls: d.calls, tokensIn: d.tokensIn, tokensOut: d.tokensOut, cacheRead: d.cacheRead, cacheMiss: d.cacheMiss, cost: Math.round(cost * 10000) / 10000, models };
    }).sort((a, b) => a.date.localeCompare(b.date)).slice(-30);
    const currentCost = Math.round(estimateCost(stats.byModel[State.endpoint.model] || emptyBucket(), State.endpoint.model) * 10000) / 10000;
    const totalCost = Math.round(Object.entries(stats.byModel).reduce((a, [m, b]) => a + estimateCost(b, m), 0) * 10000) / 10000;
    // 本对话统计（?chatId= 指定会话的完整桶；累计口径见 current/total）
    const qcid = (url.searchParams.get('chatId') || '').trim();
    const cb = qcid ? (stats.byChat[sanitizeId(qcid)] || null) : null;
    const chat = cb ? summarize(cb) : null;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ model: State.endpoint.model, current: cur, total: t, chat, daily, currentCost, totalCost }));
  }

  // 剧情记忆：时间线 / 物品栏 / 导出（按会话 chatId 隔离）
  const chatIdOf = () => sanitizeId(url.searchParams.get('chatId') || '');
  if (p === '/api/timeline' && req.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit') || 20), 100);
    const allTurns = readTurns(chatIdOf());
    const turns = allTurns.slice(-limit).reverse();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ turns, total: allTurns.length }));
  }
  // 调试：查看最近提示词（最近一次 + 本会话历史记录）
  if (p === '/api/prompt/latest' && req.method === 'GET') {
    const cid = sanitizeId(url.searchParams.get('chatId') || '');
    const history = [];
    try {
      const file = path.join(PROMPT_DIR, `${cid}.jsonl`);
      if (fs.existsSync(file)) {
        for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-10)) {
          try { history.push(JSON.parse(l)); } catch (e) { /* 忽略 */ }
        }
      }
    } catch (e) { /* 忽略 */ }
    const latest = State.lastPrompt.chatId === cid ? lastPrompt : (history[history.length - 1] || null);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ latest, history: history.reverse() }));
  }

  // 手动补记一条回合（界面编辑）
  if (p === '/api/timeline/manual' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, story_time, location, atmosphere, characters, costume, event } = JSON.parse(body);
      const rec = await appendManualTurn(sanitizeId(chatId || ''), { story_time, location, atmosphere, characters, costume, event });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(rec ? { ok: true, rec } : { ok: false, error: '写入失败' }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  // 修改单条回合记录（界面编辑，按 id 重写；保留物品/情绪等附属字段）
  if (p === '/api/timeline/update' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, id, story_time, location, atmosphere, characters, costume, event } = JSON.parse(body);
      if (!id) throw new Error('缺少记录 id');
      const rec = await updateTurnRecord(sanitizeId(chatId || ''), String(id), { story_time, location, atmosphere, characters, costume, event });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(rec ? { ok: true, rec } : { ok: false, error: '未找到该记录' }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  // 在指定条目之后插入一条回合记录（界面「＋ 插」补充；afterId 为空/未找到 → 追加末尾）
  if (p === '/api/timeline/insert' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, afterId, story_time, location, atmosphere, characters, costume, event } = JSON.parse(body);
      const rec = await insertTurnRecord(sanitizeId(chatId || ''), String(afterId || ''), { story_time, location, atmosphere, characters, costume, event });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(rec ? { ok: true, rec } : { ok: false, error: '写入失败' }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  // 删除单条回合记录
  if (p === '/api/timeline/delete' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, id } = JSON.parse(body);
      const ok = await deleteTurnRecord(sanitizeId(chatId || ''), String(id || ''));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(ok ? { ok: true, note: '已删除该条记录' } : { ok: false, error: '未找到该记录' }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  // AI 智能补记：把用户一句话（可选）结合最近对话整理成规范时间线字段（走辅助 API 串行队列）
  if (p === '/api/timeline/ai-fill' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, hint } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      // 参考最近对话（当前会话最后 6 条；清洗 base64 图片）
      let recent = [];
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, `${cid}.json`), 'utf8'));
        recent = (c.messages || []).slice(-6).map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${String(m.content || '').replace(/!\[[^\]]*\]\((data:image\/[^)]+)\)/g, '[图片]').replace(/\s+/g, ' ').slice(0, 300)}`).filter((s) => s.length > 4);
      } catch (e) { /* 无对话文件 */ }
      const userText = [
        hint ? `用户描述：${hint}` : '（用户未提供描述，请从最近对话中提取当前场景）',
        recent.length ? `\n\n最近对话（参考）：\n${recent.join('\n')}` : '',
      ].join('');
      const sys = '你是多角色 RP 的回合记录整理助手。根据用户描述和最近对话，输出一条规范的时间线补记记录，只输出纯 JSON（禁止 markdown 代码块、禁止多余文字）：{"story_time":"时间","location":"地点","characters":["在场角色"],"costume":"角色：着装描述","atmosphere":"氛围","event":"事件一句话（≤100字）","items_gain":[{"name":"物品名","holder":"持有者"}],"items_loss":["物品名"],"emotion":{"角色名":"情绪"},"location_detail":"分组| 地点名：2-4句描写"}。字段没有就填空字符串/空数组/空对象；characters 不确定留空数组；items_gain/items_loss 仅当对话中出现物品获得/消耗时填；emotion 仅当角色情绪明确时填；costume 仅当对话明确描述着装时填（格式「角色名：着装」）；location_detail 仅当出现新地点时填（格式「分组名| 地点名：描写」）；时间有明确日期用对话日期，否则给大概时段。';
      const text = await auxCall(sys, userText, 800, { thinking: { type: 'disabled' } });
      const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
      const first = cleaned.indexOf('{');
      const last = cleaned.lastIndexOf('}');
      let fields = null;
      try {
        fields = first >= 0 && last > first ? JSON.parse(cleaned.slice(first, last + 1)) : null;
      } catch (e2) {
        console.error('[ai-fill] JSON 解析失败:', e2.message);
        fields = null;
      }
      if (!fields) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: 'AI 未返回有效 JSON，请重试或手动填写' }));
      }
      const nf = normalizeTurnFields({
        story_time: fields.story_time,
        location: fields.location,
        atmosphere: fields.atmosphere,
        characters: Array.isArray(fields.characters) ? fields.characters.join('、') : fields.characters,
        costume: fields.costume,
        event: fields.event,
        items_gain: fields.items_gain,
        items_loss: fields.items_loss,
        emotion: fields.emotion,
        location_detail: fields.location_detail,
      });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, fields: nf }));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: 'AI 补全失败: ' + String(e.message || e).slice(0, 120) }));
    }
  }
  // 按消息序号清理回合记录（重roll：mode=gte 删 seq>=n；删单条消息：mode=eq 删 seq==n）
  if (p === '/api/timeline/truncate' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, seq, mode } = JSON.parse(body);
      const n = Number(seq);
      if (!Number.isFinite(n) || n <= 0) throw new Error('缺少有效 seq');
      const removed = await truncateTurnsBySeq(sanitizeId(chatId || ''), n, mode === 'eq' ? 'eq' : 'gte');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, removed, note: `已清理 ${removed} 条回合记录` }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  if (p === '/api/inventory' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(buildInventory(chatIdOf())));
  }
  // 手动添加 / 消耗物品（界面编辑，记账）
  if (p === '/api/inventory/manual' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { chatId, action, name, holder } = JSON.parse(body);
      const cid = sanitizeId(chatId || '');
      const nm = String(name || '').trim().slice(0, 40);
      const act = action === 'loss' ? 'loss' : 'gain';
      if (!nm) throw new Error('缺少物品名');
      appendItemRecord(cid, act, nm, String(holder || '').trim().slice(0, 20));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, note: act === 'gain' ? `已添加物品：${nm}` : `已消耗/移除物品：${nm}` }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: String(e) }));
    }
  }
  // 当前着装聚合（界面显示 + 可改：改动走 /api/op/wardrobe）
  if (p === '/api/wardrobe/current' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ wardrobes: buildCurrentWardrobe(chatIdOf()) }));
  }
  if (p === '/api/timeline/export' && req.method === 'GET') {
    const turns = readTurns(chatIdOf());
    const lines = [];
    lines.push(`# 回合记录导出（${new Date().toISOString().slice(0, 10)}）`);
    lines.push('> 供自行归档 / 二次创作；本应用不写任何外部文件。');
    lines.push('');
    for (const t of turns) {
      lines.push(`### 【${t.story_time || '时间未记'} · ${t.location || '地点未记'} · 已发生】`);
      if (t.characters.length) lines.push(`- 在场：${t.characters.join('、')}`);
      if (t.costume && t.costume !== '同上') lines.push(`- 着装：${t.costume}`);
      if (t.atmosphere) lines.push(`- 氛围：${t.atmosphere}`);
      if (t.event) lines.push(`- 事件：${t.event}`);
      if (t.emotion) {
        for (const [en, ev] of Object.entries(t.emotion)) lines.push(`- 情绪：${en} = ${ev}`);
      }
      for (const g of t.items_gain) lines.push(`- 物品获得：${g.name}${g.holder ? ` = ${g.holder}` : ''}`);
      for (const n of t.items_loss) lines.push(`- 物品消耗/丢失：${n}`);
      for (const u of t.updates) lines.push(`- 【更新】${u.entry}：${u.content}`);
      lines.push('');
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(lines.join('\n'));
  }

  if (p === '/api/chat' && req.method === 'POST') {
    const OPENING_PIN_MIN_CHARS = 300;   // 首条消息保底注入 system 的最小长度（开局注入/长提示词；短问候不 pin）
    let body = await readBody(req);
    let payload;
    try { payload = JSON.parse(body); } catch (e) {
      res.writeHead(400); return res.end('bad json');
    }
    if (!State.endpoint.apiKey) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('未找到 API Key（请在 header「API」设置里配置）');
    }
    // 规范化历史：Anthropic 要求 user/assistant 交替、首条为 user
    // 开局提示词保底（2026-08-20）：首条 user 消息若为长文本（≥300 字，如开局注入/长提示词），
    // 移入 system 常驻、不参与历史截断——长对话后设定仍在；历史上限 300 条（v4 1M 窗口，预算由 maxContext 兜底）
    const rawHistory = (payload.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
    const firstMsg = rawHistory[0] || null;
    const pinFirst = !!(firstMsg && firstMsg.role === 'user' && String(firstMsg.content || '').trim().length >= OPENING_PIN_MIN_CHARS);
    const history = rawHistory.slice(pinFirst ? 1 : 0).slice(-300);
    let merged = [];
    for (const m of history) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += '\n' + m.content;
      else merged.push({ role: m.role, content: m.content });
    }
    if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '（开场）' });

    // system：世界设定（用户自填：世界/角色卡/规则 三段）+ 界面操作覆盖 + 当前情绪
    let system = buildSystemPrompt({
      world: payload.worldSetting || '',
      chars: payload.charsSetting || '',
      rules: payload.rulesSetting || '',
      extra: payload.extra || '',
    }, payload.chatId || '');
    const op = opInject(payload.chatId || '');
    if (op) system += '\n\n---\n\n' + op;
    const emo = emotionInject(payload.chatId || '');
    if (emo) system += '\n\n---\n\n' + emo;
    // 剧情记忆注入（场景、角色、关系）
    const storyMemory = buildStoryMemory(payload.chatId || '');
    if (storyMemory) system += '\n\n---\n\n' + storyMemory;
    // 开局提示词保底：首条长消息原文注入 system（每轮都在，不参与 maxContext 裁剪/自动压缩）
    if (pinFirst) {
      system += '\n\n---\n\n## 会话开局提示词（首条消息原文，每轮保底注入；与「会话常驻设定」冲突时以常驻设定为准）\n' + String(firstMsg.content).trim();
    }
    // 调试：记录本轮 system prompt（落盘 data/prompts/）
    await recordPrompt(payload.chatId || '', system, merged.length);

    // 上下文预算裁剪：system + 历史 ≤ maxContext（0 = 不裁剪）；从最旧消息开始丢弃，至少保留 1 条
    if (State.endpoint.maxContext && State.endpoint.maxContext > 0) {
      const est = (s) => Math.ceil((s || '').length * 0.67);   // 中文为主近似 token
      const sysTok = est(system);
      let kept = merged.slice();
      while (kept.length > 1 && (sysTok + kept.reduce((a, m) => a + est(m.content), 0)) > State.endpoint.maxContext) {
        kept.shift();
      }
      if (!kept.length || kept[0].role !== 'user') kept.unshift({ role: 'user', content: '（开场）' });
      merged = kept;
    }

    // 自动压缩总结：历史过长 → 最旧部分压缩为摘要（缓存，不重复调用）
    let summaryNote = null;
    if (State.endpoint.autoSummary !== false && merged.length > 6) {
      const histChars = merged.reduce((a, m) => a + (m.content || '').length, 0);
      const threshold = State.endpoint.autoSummaryThreshold || 12000;
      if (histChars > threshold) {
        const compressCount = Math.max(2, Math.floor(merged.length / 2));   // 压缩最旧一半
        const oldPart = merged.slice(0, compressCount);
        const sumDir = path.join(DATA_DIR, 'summaries');
        const sumFile = path.join(sumDir, `${sanitizeId(payload.chatId)}.json`);
        let cached = null;
        try { cached = JSON.parse(fs.readFileSync(sumFile, 'utf8')); } catch (e) { /* 无缓存 */ }
        if (cached && cached.summary && cached.count >= compressCount) {
          merged = [{ role: 'user', content: `【历史摘要（${cached.count} 条旧消息）】\n${cached.summary}` }, ...merged.slice(compressCount)];
          summaryNote = `已自动压缩 ${compressCount} 条旧消息（缓存摘要）`;
        } else {
          try {
            const summary = await summarizeOldMessages(oldPart);
            merged = [{ role: 'user', content: `【历史摘要（${compressCount} 条旧消息）】\n${summary}` }, ...merged.slice(compressCount)];
            fs.mkdirSync(sumDir, { recursive: true });
            fs.writeFileSync(sumFile, JSON.stringify({ summary, count: compressCount, at: new Date().toISOString() }), 'utf8');
            summaryNote = `已自动压缩 ${compressCount} 条旧消息`;
          } catch (e) { /* 摘要失败则跳过，保持原样 */ }
        }
        // 摘要后保证 user/assistant 交替
        const merged2 = [];
        for (const m of merged) {
          const last = merged2[merged2.length - 1];
          if (last && last.role === m.role) last.content += '\n' + m.content;
          else merged2.push({ ...m });
        }
        merged = merged2;
        if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '（开场）' });
      }
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    let finished = false;
    let abortedByClient = false;
    const llmAbort = new AbortController();
    // 客户端断连（关页面/刷新/切会话）→ 立即中止 LLM 请求，不再烧 token
    res.on('close', () => { finished = true; abortedByClient = true; llmAbort.abort(); });
    // SSE 心跳（Task8）：15s 无事件时发 ping 保活连接，防代理/防火墙/浏览器超时掐断流
    const pingInterval = setInterval(() => {
      if (!finished) res.write('data: {"type":"ping"}\n\n');
    }, 15000);
    let acc = '';
    let firstTokenAt = 0;
    const t0 = Date.now();
    const meta = {};
    const send = (obj) => { if (!finished) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
    if (summaryNote) send({ type: 'summarized', note: summaryNote });
    // 工具桥：联网搜索（独立开关，会话内持久）
    let toolTrace = null;
    const enabledNames = toolsEnabled(payload.chatId);
    if (enabledNames.length) {
      try {
        const lastU = merged[merged.length - 1];
        const direct = (lastU && lastU.role === 'user' ? await bridgeDirectTool(lastU.content) : []).filter((d) => enabledNames.includes(d.name));
        if (direct.length) {
          const parts2 = [];
          for (const d of direct) {
            const out = await executeBridgeTool(d.name, d.input);
            parts2.push('[工具 ' + d.name + ']\n' + out);
            toolTrace = [...(toolTrace || []), { name: d.name, input: d.input, resultHead: out.slice(0, 120) }];
          }
          merged = merged.slice(0, -1).concat([{ role: 'user', content: lastU.content + '\n\n【工具结果】\n' + parts2.join('\n\n') }]);
          send({ type: 'tools', trace: toolTrace.map((t) => t.name + '(' + JSON.stringify(t.input).slice(0, 60) + ')') });
        } else {
          const tr = await runBridgeToolLoop(merged, system, enabledNames);
          merged = tr.messages;
          toolTrace = tr.trace;
          if (toolTrace && toolTrace.length) send({ type: 'tools', trace: toolTrace.map((t) => t.name + '(' + JSON.stringify(t.input).slice(0, 60) + ')') });
        }
      } catch (e) { console.error('[bridge] 工具回合失败:', e.message); }
    }
    // 图片处理（M7 升级：视觉模型 → 图片以多模态格式进 LLM；非视觉模型 → 降级占位符）
    // 视觉模型判定：模型名含 vision（如 deepseek-v4-flash-vision-exp）
    const isVision = /vision/i.test(State.endpoint.model || '');
    const IMG_RE = /!\[[^\]]*\]\((data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+))\)/g;
    merged = merged.map((m) => {
      const text = String(m.content || '');
      if (!isVision) return { ...m, content: text.replace(IMG_RE, '[图片]') };
      // 视觉模型：单条消息内图文混合 → content 数组（openai 格式）；anthropic 走 messages 转换
      if (!IMG_RE.test(text)) return m;
      IMG_RE.lastIndex = 0;
      const parts = [];
      let last = 0, mm;
      while ((mm = IMG_RE.exec(text)) !== null) {
        if (mm.index > last) parts.push({ type: 'text', text: text.slice(last, mm.index) });
        parts.push({ type: 'image_url', image_url: { url: mm[1] } });
        last = mm.index + mm[0].length;
      }
      if (last < text.length) parts.push({ type: 'text', text: text.slice(last) });
      // 仅当整条消息恰为单段文本时才折叠为字符串；含图一律保留数组（单图无文字时 parts=[image_url]，不能取 .text）
      return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
    });
    try {
      await callLLM(merged, system, (text) => {
        if (!firstTokenAt) firstTokenAt = Date.now();
        acc += text;
        send({ type: 'delta', text });
      }, (m) => Object.assign(meta, m), (t) => send({ type: 'thinking', text: t }), llmAbort.signal);
      // 会话统计（按当前模型分桶）
      const b = bucket(State.endpoint.model);
      b.turns += 1;
      b.calls += 1;
      b.llmMs += Date.now() - t0;
      if (firstTokenAt) { b.firstTokenSum += firstTokenAt - t0; b.firstTokenN += 1; }
      const uIn = meta.usageIn || {};
      const uOut = meta.usageOut || {};
      const inTok = uIn.input_tokens || uIn.prompt_tokens || 0;
      const cacheRead = uIn.cache_read_input_tokens || uIn.prompt_cache_hit_tokens || 0;
      // 注意：input_tokens/prompt_tokens 已包含缓存读写与缓存创建部分（DeepSeek/Anthropic 同），
      // 不再叠加 cacheRead/cacheCreate，否则费用与命中率被系统性高估/压低
      b.tokensIn += inTok;
      b.tokensOut += uOut.output_tokens || uOut.completion_tokens || 0;
      b.cacheRead += cacheRead;
      b.cacheMiss += Math.max(0, inTok - cacheRead);
      // 每日费用记账（Task6）：按调用完成日期分桶（含分模型明细），供 /api/stats 每日费用仪表盘
      const nowD = new Date();
      const dk = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}-${String(nowD.getDate()).padStart(2, '0')}`;   // 本地日期（避免 UTC 跨日错记）
      if (!stats.daily) stats.daily = {};
      const dd = stats.daily[dk] = stats.daily[dk] || { calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheMiss: 0, models: {} };
      dd.calls += 1;
      dd.tokensIn += inTok;
      dd.tokensOut += uOut.output_tokens || uOut.completion_tokens || 0;
      dd.cacheRead += cacheRead;
      dd.cacheMiss += Math.max(0, inTok - cacheRead);
      const dm = dd.models[State.endpoint.model] = dd.models[State.endpoint.model] || { calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheMiss: 0 };
      dm.calls += 1;
      dm.tokensIn += inTok;
      dm.tokensOut += uOut.output_tokens || uOut.completion_tokens || 0;
      dm.cacheRead += cacheRead;
      dm.cacheMiss += Math.max(0, inTok - cacheRead);
      // 本对话统计另计（完整桶；累计口径在 /api/stats 的 current/total 汇总）
      const cid = payload.chatId ? sanitizeId(payload.chatId) : '';
      if (cid) {
        let cb = stats.byChat[cid];
        if (!cb || cb.turns == null) cb = stats.byChat[cid] = Object.assign(emptyBucket(), cb || {});
        cb.turns += 1;
        cb.calls += 1;
        cb.llmMs += Date.now() - t0;
        if (firstTokenAt) { cb.firstTokenSum += firstTokenAt - t0; cb.firstTokenN += 1; }
        cb.tokensIn += inTok;
        cb.tokensOut += uOut.output_tokens || uOut.completion_tokens || 0;
        cb.cacheRead += cacheRead;
        cb.cacheMiss += Math.max(0, inTok - cacheRead);
      }
      await saveStats();
      // seq 校验：仅接受正整数，防客户端伪造污染回合记录
      const seqNum = Number(payload.seq);
      await appendTurnRecord(acc, payload.chatId, Number.isFinite(seqNum) && seqNum > 0 ? seqNum : undefined);  // 剧情记忆：按会话自动记账（带消息序号）
      if (toolTrace && toolTrace.length) appendOpRecord(payload.chatId, '工具调用', toolTrace.map((t) => t.name + ':' + String(t.input.query || '').slice(0, 40)).join('；'));
      send({ type: 'done' });
    } catch (e) {
      if (abortedByClient || llmAbort.signal.aborted) {
        // 客户端断连中止：静默收尾（不追加回合记录、不发 error）
      } else {
        // 详细错误只打日志；回传精简文案，防端点错误体回显敏感信息（L4）
        console.error('[chat] LLM 调用失败:', e && e.message || e);
        const brief = String((e && e.message) || e).slice(0, 120);
        send({ type: 'error', error: brief.includes('401') || brief.includes('403') || brief.includes('429') || brief.includes('超时') || brief.includes('timeout') ? brief : 'LLM 调用失败，详见服务器日志' });
      }
    } finally {
      clearInterval(pingInterval);   // 心跳随会话结束停止（Task8）
      finished = true;
      res.end();
    }
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404');
}

// 外层兜底：任何未捕获异常（如 readBody 413）都返回响应，不再让请求挂起
const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (e) {
    if (!res.writableEnded) {
      const code = (e && e.statusCode) || 500;
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: (e && e.message) || '服务器内部错误' }));
    } else {
      console.error('[server] 响应中途异常:', e && e.message || e);
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Moonrabbit: http://127.0.0.1:${PORT}`);
  console.log(`模型: ${State.endpoint.model} | 协议: ${State.endpoint.protocol} | 端点: ${State.endpoint.baseURL} | API Key: ${State.endpoint.apiKey ? '已配置' : '未配置'}`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请关闭占用进程后重试`);
  } else {
    console.error('服务启动失败:', err.message);
  }
  process.exit(1);
});
