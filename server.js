#!/usr/bin/env node

// ===== 全局可变状态收口 =====
const { State } = require('./lib/core/state');
// server.js —— Moonrabbit 后端（多角色 RP / 互动小说界面，零依赖，纯 Node 内置模块）
// 用法：node server.js  （或双击 start.bat）
// 打开 http://127.0.0.1:3081
const http = require('http');
const fs = require('fs');
const path = require('path');

const { DATA_DIR, TURNS_DIR } = require('./lib/core/paths');
const { API_KEY } = require('./lib/core/io');
const { sanitizeId } = require('./lib/tools/misc');
const { readBody } = require('./lib/http/respond');
const { h_route_0, h_favicon_ico_1, h_logo_png_2, h_share_card_png_3, h_style_css_4, h_app_js_5 } = require('./lib/http/handlers/static');
const { loadAgenda, saveAgenda } = require('./lib/store/bookmarks');
const { h_api_savepoints_save_9, h_api_savepoints_list_10, h_api_savepoints_load_11 } = require('./lib/http/handlers/savepoints');
const { h_api_bookmarks } = require('./lib/http/handlers/bookmarks');
// 接线须早于同文件的顶层立即求值引用：op.json 的启动读取块（下方）就用 OP_FILE，
// 故本行必须留在文件头，不能随块就近插入。
const { OP_FILE } = require('./lib/store/opstate');
const { DEFAULT_EMOTION_MAP, EMOTIONS_FILE } = require('./lib/store/emotions');
const { ANNOTATIONS_DIR } = require('./lib/store/annotations');
const { REPORTS_DIR } = require('./lib/store/reports');
const { loadStoryMemoryConfig } = require('./lib/store/storymemory');
const { loadPersonas } = require('./lib/store/worldbooks');
const { PROMPT_DIR } = require('./lib/turns/timeline');   // M-08·timeline-store 域（ROUTES 表按同名引用，表体零改动）
const { AVATAR_CUSTOM_FILE, NPC_PROFILES_DIR, SCENES_DIR, EXPRESSIONS_DIR } = require('./lib/store/avatars');   // M-08·avatars-store 域（ROUTES 表按同名引用，表体零改动）
const { MODEL_FILE, PRESET_FILE, BUILTIN_PRESETS, normPreset, applyPreset } = require('./lib/store/config');
const { h_api_agent } = require('./lib/http/handlers/agent');   // M-08·agent-handlers 域（ROUTES 表按同名引用，表体零改动）
const { loadChatProfiles, loadExpressionConfig, loadRegexRules, loadLorebook, loadWorldbooks, loadGraph, loadProfiles, loadKeyMemo, loadVecConfig, loadSettings, normalizeToolsState } = require('./lib/store/loaders');   // M-08·loaders 域（ROUTES 表按同名引用，表体零改动）
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

// 读取辅助端点实际生效配置（未启用或无配置 → 用主端点）

State.endpoint.apiKey = State.endpoint.apiKey || API_KEY;

// ---------- system prompt 组装（世界设定 / 角色卡 / 规则 由用户自填，三段分别注入） ----------

// ---------- 最后打开的会话（服务端记忆 · 桌面壳 WebView2 里 localStorage 可能不落盘 · 2026-09-18） ----------

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TURNS_DIR, { recursive: true });

// ---------- 名称替换规则（可选，2026-09-03） ----------
// 不预设任何真名表；用户如需「记账时把某些名字替换掉」，自建
// data/name-redact.json = { "enabled": true, "map": { "原名": "替换名" } }。
// 文件不存在 / enabled!==true / map 为空 → 返回 null＝完全不替换。
// 带 mtime 缓存：记账会对每个字段调用，避免每次读盘。

// ---------- 世界书导入目录解析（2026-09-03 修复 M-2） ----------
// 原代码引用未定义的 ROOT（声明数=0）→ list/import-worldbook 必抛 ReferenceError 且以 200 返回。
// 不应默认指向特定仓库的内部资产路径，
// 故改为：必须由用户显式传入目录；仅允许绝对路径或相对 WWW 的路径，并禁止穿越到 WWW 之外。

// ---------- 对话配置档系统（简化版：prefix + firstMsg，无 flags） ----------

State.chatProfiles = {};

loadChatProfiles();

// ---------- 变量模板（{{user}} {{char}} {{time}} 等自动替换） ----------

// ---------- NPC 档案（独立追踪） ----------
// ---------- 角色头像（2026-09-06 S5：图存 data/自定义头像/，映射存 avatar-custom.json） ----------

State.avatarCustom = {};
try { State.avatarCustom = JSON.parse(fs.readFileSync(AVATAR_CUSTOM_FILE, 'utf8')); } catch (e) { State.avatarCustom = {}; }

fs.mkdirSync(NPC_PROFILES_DIR, { recursive: true });

// ---------- 场景档案（地点固定物理特征） ----------

fs.mkdirSync(SCENES_DIR, { recursive: true });

// ---------- 表情系统 ----------

fs.mkdirSync(EXPRESSIONS_DIR, { recursive: true });

State.emotionMap = { ...DEFAULT_EMOTION_MAP };
State.enableAutoSwitch = true;

loadExpressionConfig();

// ---------- 输出过滤器 ----------

State.regexRules = [];

loadRegexRules();

// ---------- 设定触发器（Lorebook） ----------

State.lorebookEntries = {};
State.lorebookSettings = { enabled: true, tokenBudget: 'auto', maxBudget: 10000, budgetRatio: 0.1 };

loadLorebook();

// ---------- 世界书（多本 · 按会话作用域） ----------
// 与上方「设定触发器」并存：世界书是更结构化的一套（多本／每本一文件／可按会话启用或停用／书级总开关）。
// 注入时两者合并为一条扫描链——设定触发器的扁平条目作为最前面的「全局」层入池，再叠 scope=global 的书，
// 再叠本会话启用的书。本版不预置任何书：data/worldbooks/ 为空（或不存在）时本段完全不产生注入。

State.worldbooks = {};   // {bookId: {book, settings, entries}}

// 会话启用的书 id 列表

// 会话「停用」的书 id 列表（用于 scope=global 的按会话反向覆盖）

// 合并扫描：设定触发器扁平条目（全局层）+ scope=global 的书 + 本会话启用的书 − 本会话停用的书

loadWorldbooks();

// ---------- 关系图谱 ----------

State.graphData = { nodes: [], edges: [], version: 1 };

loadGraph();

// ---------- 玩家身份（Persona） ----------

State.personas = {};
State.activePersona = '';

loadPersonas();

// ---------- 报告系统 ----------

fs.mkdirSync(REPORTS_DIR, { recursive: true });

// ---------- 旁注（位置感知注入） ----------

fs.mkdirSync(ANNOTATIONS_DIR, { recursive: true });

// ---------- 调试：最近提示词记录（查看每轮发给 AI 的 system prompt） ----------

fs.mkdirSync(PROMPT_DIR, { recursive: true });
State.lastPrompt = { chatId: '', ts: '', system: '', historyCount: 0, tools: [] };

// 端点配置持久化（覆盖启动时的默认值；含自定义 API 设置 + 辅助 API）

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

// DeepSeek 定价（官方，每 1M token）——仅估算用，非账单依据

// ---------- API 采样预设（命名预设：保存/切换/删除；参数随预设保存） ----------

State.presets = JSON.parse(JSON.stringify(BUILTIN_PRESETS));
State.activePreset = 'DeepSeek 默认（官方参数）';
// 当前生效采样参数（null = 不传，用 API 默认）
State.samplers = { temperature: null, top_p: null, top_k: null, presence_penalty: null, frequency_penalty: null };

try {
  const pj = JSON.parse(fs.readFileSync(PRESET_FILE, 'utf8'));
  if (pj.custom && typeof pj.custom === 'object') for (const [k, v] of Object.entries(pj.custom)) State.presets[k] = normPreset(v || {});
  if (pj.active && State.presets[pj.active]) State.activePreset = pj.active;
} catch (e) { /* 首次使用 */ }
applyPreset(State.activePreset);

// ---------- 配置档案（Profile：端点 + 模型 + 参数整套配置一键切换） ----------

State.profiles = {};
State.activeProfile = '';

loadProfiles();

// ---------- Key 按端点自动记忆（keyMemo.json：端点 baseURL → API Key） ----------
// 目标：切换配置档案不再每次重填 Key。第一次在某端点保存 Key 后自动记忆，
// 之后切到该端点的档案自动带上对应 Key；全新端点首次切换沿用当前 Key
// （在 API 设置里填一次即自动记忆）。Key 只存本地 data/（不入 git，与 model.json
// 同样处理）；档案本身仍不存 Key（安全约定保留）。

State.keyMemo = { by: {}, auxBy: {} };   // by: 主端点 baseURL→key；auxBy: 辅助端点 baseURL→key

loadKeyMemo();

// 解析 AI 回复中的 <storyevent>/<items>/【更新】标签 → 结构化回合记录

// 按消息序号截断/删除回合记录（重roll = 删 seq>=n；删单条 = 删 seq==n）
// 只删带 seq 的记录（手动补记/操作记录无 seq，不受影响）

// 剧情记忆配置（注入开关）

State.storyMemoryConfig = { scene: true, character: true, relationship: true, expression: false, wardrobe: true, inventory: true };

loadStoryMemoryConfig();

// ---------- 向量语义检索配置（批E · 2026-09-18）----------
// 本版实现（保持可移植）：embedding 端点不写死，baseURL/model 均可在
// 「🔍 语义」面板配置（便于接任意 OpenAI 兼容 embedding 服务或本地端点）；
// autoInject 默认关闭，未配置 Key 时所有路径明确降级。
State.vecConfig = {
  apiKey: '',                                                   // 留空则复用辅助 API 的 Key / 环境变量
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', // OpenAI 兼容 embedding 端点（可改）
  model: 'qwen3.7-text-embedding',
  autoInject: false,
  injectTopK: 4,
  minScore: 0.35,
};

loadVecConfig();

// ---------- 向量语义检索核心（纯 Node 内置模块 · 零 npm 依赖）----------
// 索引三类内容：事件时间线 / 对话原文 / 历史摘要；落盘 data/vec/{chatId}.json。

// 清掉回合标签（storyevent/items/thinking 等），只留正文——标签是给引擎看的，不该进语义索引

// 取 embedding 用的 API Key：优先独立配置，其次辅助 API，最后环境变量

// 批量算 embedding（失败抛错，由调用方决定降级）

// 余弦相似度（embedding 已归一化时等价于点积，这里仍完整算以防未归一化）

// 收集待索引的分块：事件时间线 / 对话原文 / 历史摘要

// 建索引：算 embedding 并落盘（返回统计）

// 语义检索：算 query 向量 → 与索引逐条算余弦 → 取 topK

// 构建剧情记忆注入（场景、角色、关系）

// 聚合物品栏：从头遍历回合记录，gain/loss 累积

// ---------- 请求体读取（统一上限，防异常数据撑爆内存；超限抛 413 错误） ----------

// 多模态消息协议适配：视觉模型时把 content 数组（openai 格式 image_url 块）转成 anthropic 图片块；
// 非视觉模型/纯文本消息原样返回。图片块形如 {type:'image_url', image_url:{url:'data:image/png;base64,...'}}

// ---------- LLM 调用（Anthropic / OpenAI 双协议，流式；onThinking 回调思考链） ----------
// 移除 U+FFFD（乱码替换符）与孤立代理项：网络/解码偶发的乱码字节会以 U+FFFD 进入流，
// 若不清理会被存档成「方块」，且随 PUT 往返持续存在。此函数在写入/展示前兜底清理。

/* E-6 修复（2026-09-05）：主对话 fetch 连接阶段无超时（M-8 只盖生图/TTS 等 9 处）——
   baseURL 指向黑洞地址时无限挂起。连接 30s 未返回响应头即中止；响应开始后不再计时
   （流式时长由 IDLE/TOTAL 超时管理），signal（客户端断连）经 AbortSignal.any 保留。 */

// ---------- 辅助 API 调用（后台任务走独立端点，串行队列防 429；失败按 fallback 决定是否回退主端点） ----------
// 统一完成一次非流式调用（openai/anthropic 双协议），返回文本

// 后台任务统一入口：优先辅助端点（串行队列），未启用/失败时按 AUX.fallback 回退主端点

// 自动压缩总结：把最旧一批消息压成剧情摘要（300 字内），走辅助 API（独立端点 + 串行队列；未配置时回退主端点）

// 端点探测（max_tokens:1），返回实际生效的模型名

// ---------- 会话统计（按模型分桶） ----------

// ---------- 会话管理（新对话 / 归档 / 恢复） ----------

// ---------- 界面操作状态（视角 / 当日着装覆盖，会话内持久，注入 system + 记账） ----------

State.opState = { views: {}, wardrobes: {}, expands: {}, tools: {}, notes: {}, customInjections: {} };   // views/wardrobes/expands/tools/notes/customInjections: {chatId: ...}
// 2026-08-30 事故教训：此前 catch 统一静默（注释「首次」），JSON.parse 失败时 State.opState 保持空默认值，
// 随后任意 saveOpState() 会把空状态写盘 → 覆盖真实数据。现在区分：文件不存在=首次；存在但解析失败=异常（备份留档）。
try {
  const opRaw = fs.readFileSync(OP_FILE, 'utf8').replace(/^\uFEFF/, '').replace(/[\u200B\u200C\u2060]/g, '');   // 剥 BOM/零宽
  if (opRaw.trim()) {
    const parsed = JSON.parse(opRaw);
    if (parsed && typeof parsed === 'object') State.opState = Object.assign(State.opState, parsed);
    else throw new Error('op.json 顶层非对象');
  }
} catch (e) {
  if (fs.existsSync(OP_FILE)) {
    try { fs.copyFileSync(OP_FILE, OP_FILE + '.corrupt_' + Date.now()); } catch (e2) { /* 忽略 */ }
    console.error('[op.json] 读取/解析失败（已备份损坏文件，空状态启动；数据待人工核对）:', e.message);
  }
  /* 首次启动：文件不存在 → 空状态 */
}

// ===== agent 助手（未经测试 · 实验性）：开关 / 存储 / 只读工具 / prompt 挂点 =====
// 🔴 开关关掉时：agentAugmentSystem 原样返回入参（prompt 逐字节不变）；本段不读写任何文件。
// 🔴 本段只读用户自己的数据（回合记录 / 设定条目 / 向量索引），不联网、不写对话文件。
const agentModeLib = require('./lib/agent/mode');

State.settings = loadSettings();
{ const norm = agentModeLib.normalizeAgentModeTable(State.opState.agentMode); State.opState.agentMode = norm.table; }

/** 禁忌库（data/taboos.json）：add() 一律 pending；只有 confirm(id) 能置 active（唯一入库路径） */

/** Meta 通道（data/meta/<chatId>.jsonl，append-only；绝不写 data/chats/*） */

/** 注入清单旁路（只记「类别 + 条数」，不记条目名） */

/** 读用户自建的设定条目（read_setting 工具的数据源）：设定触发器 / 世界书，只读内存态 */

/** 只读工具集（4 具）；依赖一律在此注入，模块本身不 require server.js */

/** 认知包（T-021 三段式）——从 Meta 历史里取；未采纳的 canon 只进候选、不进可知段 */

/** agent token 记账桶（懒创建：开关关着不在 stats.json 里留字段） */

/** 计划轮（T-004）：开关开时先拟一份本轮计划；失败/超时静默回落（不影响正常对话） */

/** 打回重试（T-010）：带完整 messages 的非流式主端点调用；失败返回 '' 由调用方回落原稿 */

/** 生成后自检（T-011）：只报不写；失败静默 */

/**
 * prompt 侧挂点（开关关 → 原样返回，逐字节不变）。
 * 组装顺序：禁忌（全局+角色级）→ 认知包可知段 → 原 system。
 * @param {string} system 已拼好的 system
 * @param {string} chatId
 */

// ---------- 会话常驻设定多槽位（Task15：背景 / 关系 / 规则 / 其他） ----------
// opState.notes[chatId] 兼容两种形态：
//   ① 旧字符串（向后兼容）→ 视为「其他」槽
//   ② 对象 {背景, 关系, 规则, 其他} → 各槽独立

// 归一化为槽位对象（字符串迁移为「其他」）

// 合并文本（供注入 / 兼容旧读取）

// 注入文本（带槽位标题，每轮注入 system）

// 自定义注入槽（⚙️ 前缀 / 后缀，按会话；随 system 注入：前缀置顶、后缀置底）

// 记一条操作回合记录（reuse 回合记录 jsonl 结构；updates 行供导出）

// ---------- 剧情记忆手动编辑（时间线 / 物品栏 / 换装，界面可改） ----------
// 手动记一条物品变更回合（gain/loss），复用物品栏聚合

// 手动补记字段归一化（时间线 补记/修改/插入 共用）

// 修改单条回合记录（按 id 重写 jsonl；保留 id/ts/chatId）
// ⭐ E-2 修复（2026-09-05）：旧版 {...o, ...normalizeTurnFields(fields)} 全量 spread——
//   编辑表单只发 6 个文本字段，normalize 把 items_gain/items_loss 归一成 []、emotion 成 {}、
//   location_detail 成 ''（array→'' 类型翻转），用户编辑任一条目即把 AI 记的物品/情绪/位置
//   详情全部清空。现在：编辑请求**未提供**的附属字段一律保留原值。

// 在指定条目之后插入一条回合记录（afterId 未找到/为空 → 追加末尾）

// 删除单条回合记录（按 id 重写 jsonl）

// 聚合当前着装：扫描回合记录（costume 字段 + updates「衣柜」）+ 手动换装覆盖（opState.wardrobes），取每个角色最新

// ---------- 情绪追踪（按会话记录各角色当前情绪，注入 system 保持情绪连续） ----------

State.emotions = {};   // {chatId: {角色名: 情绪描述}}
try { State.emotions = JSON.parse(fs.readFileSync(EMOTIONS_FILE, 'utf8')); } catch (e) { /* 首次 */ }

// 从回合记录聚合各角色最新情绪：优先显式 emotion 字段，回退 updates 中「情绪」条目

// 情绪注入段（放在界面操作覆盖之后，帮助 AI 保持情绪连续）

// 设置/清除某个角色的情绪（手动，记账；清空该角色时传空字符串）

// 界面操作注入段（作为持续生效的覆盖指令）

// ---------- 工具桥：对话内工具（仅联网搜索；通用工具集可扩展） ----------

// 工具定义按端点协议转换：openai → { type:'function', function:{name,description,parameters} }；anthropic → { name, description, input_schema }
// （修复：deepseek openai 端点拒绝 anthropic 工具格式，报 tools[0]: missing field `type`）

normalizeToolsState();

// 会话列表元数据缓存（P-1 阶段 2 · 异步路径）：仿 loadHistIndex 的 mtime 索引模式——
// 以「文件名+mtimeMs+size」为签名，未变不重新 parse；返回全量元数据（含 hidden），
// 正常列表/归档列表各按 hidden 过滤（排序在过滤前完成，与 readChats 的排序语义逐项一致）。
State.chatMetaCache = { sig: '', metas: [] };

// ---------- 历史消息检索（本地关键词，零 API） ----------
// 索引缓存：目录文件 mtime 变化时重建；数据量小（KB 级）直接全量载入内存
State.histIndexCache = { mtimes: '', chats: [] };

// 关键词拆分：空格 / 中英文逗号 / 顿号分隔；AND 语义（全部词命中才算）

// 关键词高亮辅助：返回 [{from,to}] 命中区间（content 内，可叠加）

// 生成命中片段：以第一个命中位置为中心，前后各截 60 字符

// 路由处理：GET /api/history/search?q=词&chatId=可选&limit=20

// ---------- 静态服务 ----------

// 顶层兜底（M6）：async handler 内任何未捕获异常（如 readBody 413 抛出）不崩溃进程
process.on('unhandledRejection', (err) => {
  console.error('[server] 未捕获的异步异常（已兜底，请求可能超时）:', err && err.message || err);
});

// ===== 分区：路由处理（阶段 5 路由表化机械搬运，函数体逐字保留） =====
// handler 由原 handleRequest if 链逐块搬出；块内顶层 return 机械改写为
// 「执行原表达式 + return true」（响应行为不变），块尾 return false = 原链 fall-through。
// 卡片交换：PNG tEXt chunk 工具函数（兼容酒馆角色卡格式）

// 场景插图：AI 图片生成（OpenAI 兼容 /images/generations；端点可配）
  // Kolors 免费；Z-Image/Qwen-Image/ERNIE 等按张计费（¥0.10-0.30/张，共用同一 key）
  // 生图端点/模型/Key 一律由用户在「🎨 插图 → 配置」里填（本版不内置任何厂商端点，也不读本机任何配置文件）

// 提示词优化：把中文场景描述润色成高质量英文生图提示词。
  // 独立用本机模型配置里可用的对话端点（生图同款 key 可通用于 chat），不依赖主端点(可能失效的 key)

// 语音朗读：TTS 配置和合成
  // TTS（OpenAI 兼容 chat/completions + audio；引擎键名沿用 mimo，可换成任意兼容端点）


// TTS 端点/Key 一律由用户在「🔊 朗读 → 配置」里填（不内置厂商端点、不读本机任何配置文件）

// ---------- 角色头像（2026-09-06 S5） ----------

async function h_route_39(req, res, url, p) {
  // 剧情备忘（agenda）：GET/POST /api/agenda/:chatId
    // 剧情备忘
    const agendaM = p.match(/^\/api\/agenda(?:\/([^/]+))?$/);
  if (agendaM) { const cid = agendaM[1] ? sanitizeId(decodeURIComponent(agendaM[1])) : null; const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); }; if (cid) { if (req.method === 'GET') { sendJson({ ok: true, ...loadAgenda(cid) }); return true; }; if (req.method === 'POST') { let b = await readBody(req); try { const { action, item } = JSON.parse(b); const a = loadAgenda(cid); if (action === 'add') { const id = 'agenda_' + Date.now(); a.items.push({ id, content: item?.content || '', createdAt: new Date().toISOString(), status: 'pending', priority: item?.priority || 'normal', source: item?.source || 'manual' }); saveAgenda(cid, a); return sendJson({ ok: true, id }); } if (action === 'complete') { const idx = a.items.findIndex(i => i.id === item?.id); if (idx >= 0) { a.items[idx].status = 'completed'; a.items[idx].completedAt = new Date().toISOString(); saveAgenda(cid, a); } return sendJson({ ok: true }); } if (action === 'delete') { a.items = a.items.filter(i => i.id !== item?.id); saveAgenda(cid, a); return sendJson({ ok: true }); } return sendJson({ error: '未知操作' }); } catch (e) { return sendJson({ error: String(e) }, 400); } } } }
  return false;
}

// ===== 向量检索 API（批E · 2026-09-18）=====

// 消息书签 API（2026-09-02 NEW-2）

// ---------- 分支同步：把 fromChatId 的回合记录（seq <= upToSeq）复制到 toChatId ----------
//   用途：「⤵ 从这条消息分叉」出的新会话应继承分叉点之前的剧情记忆（时间线/物品栏/情绪等都从 turns 读）。
//   2026-09-18  h_api_fork_turns（本版 turns 结构相同，无需改字段）。

// ---------- 最后打开的会话：只读端点（前端在 localStorage 取不到时回落到这里） ----------

// ---------- 群聊模式：每角色独立调用模型、看得到前序角色输出（真实反应链） ----------
// 新角色由回合记账的 characters[] 自动纳入 roster，无需手工配置。
// 单脑模式路径完全不受影响：仅当会话显式开启 groupMode 才走群聊分支。

// ── 群聊配置 API：GET 读 / PUT 写（按会话落在 chat json 内）──────────────────

// 声明式保序路由表：数组顺序 = 匹配优先级（与原 if 链顺序严格一致）
// ---------- agent 助手端点（开关 / Meta 通道 / 禁忌库）----------
// 开关：纯配置态；Meta：只落 data/meta/，绝不写 data/chats/*；禁忌：create 一律 pending，只有 confirm 能生效。

const { h_api_illustration_generate_48, h_api_illustration_config_49, h_api_illustration_enhance_50 } = require('./lib/http/handlers/illustration');   // M-08·illustration 域（ROUTES 表按同名引用，表体零改动）
const { h_api_tts_config_51, h_api_tts_config_52, h_api_tts_synthesize_53, h_route_54 } = require('./lib/http/handlers/tts');   // M-08·tts 域（ROUTES 表按同名引用，表体零改动）
const { h_api_group } = require('./lib/http/handlers/group');   // M-08·group-handler 域（ROUTES 表按同名引用，表体零改动）
const { h_api_stats_61, h_api_emotions_58, h_api_regex_rules_27, h_api_regex_rules_28, h_api_suggestions_generate_29 } = require('./lib/http/handlers/stats');   // M-08·stats-handlers 域（ROUTES 表按同名引用，表体零改动）
const { h_api_op_view_12, h_api_op_wardrobe_13, h_api_op_expand_14, h_api_op_tools_15, h_api_op_note_55, h_api_op_inject_56, h_api_op_inject_57, h_api_op_emotion_59, h_api_op_attach_pending_75 } = require('./lib/http/handlers/op');   // M-08·op-handlers 域（ROUTES 表按同名引用，表体零改动）
const { h_api_story_memory_config_36, h_api_story_memory_config_37, h_api_story_memory_data_38, h_api_story_memory_summary, h_api_report_list_40, h_route_41, h_api_report_overview_42, h_api_report_audit_43, h_api_analyze_retro_44, h_api_memory_search_45, h_api_history_search_60 } = require('./lib/http/handlers/memory');   // M-08·memory-handlers 域（ROUTES 表按同名引用，表体零改动）
const { h_api_vec_status, h_api_vec_build, h_api_vec_search, h_api_vec_config } = require('./lib/http/handlers/vec');   // M-08·vec-handlers 域（ROUTES 表按同名引用，表体零改动）
const { h_api_lorebook_30, h_api_lorebook_31, h_api_worldbooks_get, h_api_worldbooks_post, h_api_graph_32, h_api_graph_33, h_api_personas_34, h_api_personas_35 } = require('./lib/http/handlers/worldbooks');   // M-08·worldbooks-handlers 域（ROUTES 表按同名引用，表体零改动）
const { h_api_timeline_62, h_api_prompt_latest_63, h_api_timeline_manual_64, h_api_timeline_update_65, h_api_timeline_insert_66, h_api_timeline_delete_67, h_api_timeline_ai_fill_68, h_api_timeline_truncate_69, h_api_timeline_export_73, h_api_inventory_70, h_api_inventory_manual_71, h_api_wardrobe_current_72 } = require('./lib/http/handlers/timeline');   // M-08·timeline-handlers 域（ROUTES 表按同名引用，表体零改动）
const { h_route_avatars, h_route_22, h_route_23, h_api_expressions_config_24, h_route_25, h_route_26, h_route_46, h_api_cards_import_47 } = require('./lib/http/handlers/avatars');   // M-08·avatars-handlers 域（ROUTES 表按同名引用，表体零改动）
const { h_api_model_6, h_api_model_7, h_route_8, h_api_presets_16, h_api_presets_17, h_api_profiles_18, h_api_profiles_19, h_api_chat_profiles_20, h_api_chat_profiles_21 } = require('./lib/http/handlers/config');   // M-08·config-handlers 域（ROUTES 表按同名引用，表体零改动）
const { h_api_chat_74, h_api_fork_turns, h_api_last_chat } = require('./lib/http/handlers/chats');   // M-08·chats-handlers 域（ROUTES 表按同名引用，表体零改动）
const ROUTES = [
  { test: (p, req) => (p === '/' || p === '/index.html'), handler: h_route_0 },
  { test: (p, req) => (/^\/api\/bookmarks(?:\/([^/]+))?$/).test(p), handler: h_api_bookmarks },
  { test: (p, req) => (p === '/favicon.ico' || p === '/favicon.png'), handler: h_favicon_ico_1 },
  { test: (p, req) => (p === '/logo.png'), handler: h_logo_png_2 },
  { test: (p, req) => (p === '/share-card.png' || p === '/placeholder.png' || p === '/placeholder-share.png'), handler: h_share_card_png_3 },
  { test: (p, req) => (p === '/style.css'), handler: h_style_css_4 },
  { test: (p, req) => (p === '/app.js' || /^\/app\/[\w.-]+\.js$/.test(p)), handler: h_app_js_5 },
  { test: (p, req) => (p === '/api/model' && req.method === 'GET'), handler: h_api_model_6 },
  { test: (p, req) => (p === '/api/model' && req.method === 'POST'), handler: h_api_model_7 },
  { test: (p, req) => (/^\/api\/chats(?:\/([^/]+))?$/).test(p), handler: h_route_8 },
  { test: (p, req) => (p === '/api/savepoints/save' && req.method === 'POST'), handler: h_api_savepoints_save_9 },
  { test: (p, req) => (p === '/api/savepoints/list' && req.method === 'GET'), handler: h_api_savepoints_list_10 },
  { test: (p, req) => (p === '/api/savepoints/load' && req.method === 'POST'), handler: h_api_savepoints_load_11 },
  { test: (p, req) => (p === '/api/op/view' && req.method === 'POST'), handler: h_api_op_view_12 },
  { test: (p, req) => (p === '/api/op/wardrobe' && req.method === 'POST'), handler: h_api_op_wardrobe_13 },
  { test: (p, req) => (p === '/api/op/expand' && req.method === 'POST'), handler: h_api_op_expand_14 },
  { test: (p, req) => (p === '/api/op/tools' && req.method === 'POST'), handler: h_api_op_tools_15 },
  { test: (p, req) => (p === '/api/presets' && req.method === 'GET'), handler: h_api_presets_16 },
  { test: (p, req) => (p === '/api/presets' && req.method === 'POST'), handler: h_api_presets_17 },
  { test: (p, req) => (p === '/api/profiles' && req.method === 'GET'), handler: h_api_profiles_18 },
  { test: (p, req) => (p === '/api/profiles' && req.method === 'POST'), handler: h_api_profiles_19 },
  { test: (p, req) => (p === '/api/chat-profiles' && req.method === 'GET'), handler: h_api_chat_profiles_20 },
  { test: (p, req) => (p === '/api/chat-profiles' && req.method === 'POST'), handler: h_api_chat_profiles_21 },
  { test: (p, req) => (/^\/api\/npc-profiles(?:\/([^/]+))?$/).test(p), handler: h_route_22 },
  { test: (p, req) => (p === "/api/avatar/upload" && req.method === "POST") || (p === "/api/avatar/generate" && req.method === "POST") || (p === "/api/avatar/remove" && req.method === "POST") || (p === "/api/avatar/list" && req.method === "GET") || (/^\/avatars\/([^/]+)$/.test(p)), handler: h_route_avatars },
  { test: (p, req) => (/^\/api\/scenes(?:\/([^/]+))?$/).test(p), handler: h_route_23 },
  { test: (p, req) => (p === '/api/expressions/config' && req.method === 'POST'), handler: h_api_expressions_config_24 },
  { test: (p, req) => (/^\/api\/expressions(?:\/([^/]+))?$/).test(p), handler: h_route_25 },
  { test: (p, req) => (/^\/api\/expressions\/static\/([^/]+)\/(.+)$/).test(p), handler: h_route_26 },
  { test: (p, req) => (p === '/api/regex-rules' && req.method === 'GET'), handler: h_api_regex_rules_27 },
  { test: (p, req) => (p === '/api/regex-rules' && req.method === 'POST'), handler: h_api_regex_rules_28 },
  { test: (p, req) => (p === '/api/suggestions/generate' && req.method === 'POST'), handler: h_api_suggestions_generate_29 },
  { test: (p, req) => (p === '/api/lorebook' && req.method === 'GET'), handler: h_api_lorebook_30 },
  { test: (p, req) => (p === '/api/lorebook' && req.method === 'POST'), handler: h_api_lorebook_31 },
  { test: (p, req) => (p === '/api/worldbooks' && req.method === 'GET'), handler: h_api_worldbooks_get },
  { test: (p, req) => (p === '/api/worldbooks' && req.method === 'POST'), handler: h_api_worldbooks_post },
  { test: (p, req) => (p === '/api/graph' && req.method === 'GET'), handler: h_api_graph_32 },
  { test: (p, req) => (p === '/api/graph' && req.method === 'POST'), handler: h_api_graph_33 },
  { test: (p, req) => (p === '/api/personas' && req.method === 'GET'), handler: h_api_personas_34 },
  { test: (p, req) => (p === '/api/personas' && req.method === 'POST'), handler: h_api_personas_35 },
  { test: (p, req) => (p === '/api/story-memory/config' && req.method === 'GET'), handler: h_api_story_memory_config_36 },
  { test: (p, req) => (p === '/api/story-memory/config' && req.method === 'POST'), handler: h_api_story_memory_config_37 },
  { test: (p, req) => (p === '/api/story-memory/data' && req.method === 'GET'), handler: h_api_story_memory_data_38 },
  { test: (p, req) => (/^\/api\/agenda(?:\/([^/]+))?$/).test(p), handler: h_route_39 },
  { test: (p, req) => (p === '/api/report/list' && req.method === 'GET'), handler: h_api_report_list_40 },
  { test: (p, req) => (/^\/api\/report\/([^/]+)\/([^/]+)$/).test(p) && (req.method === 'GET'), handler: h_route_41 },
  { test: (p, req) => (p === '/api/report/overview' && req.method === 'POST'), handler: h_api_report_overview_42 },
  { test: (p, req) => (p === '/api/report/audit' && req.method === 'POST'), handler: h_api_report_audit_43 },
  { test: (p, req) => (p === '/api/analyze/retro' && req.method === 'POST'), handler: h_api_analyze_retro_44 },
  { test: (p, req) => (p === '/api/memory/search' && req.method === 'POST'), handler: h_api_memory_search_45 },
  { test: (p, req) => (p === '/api/story-memory/summary' && req.method === 'GET'), handler: h_api_story_memory_summary },
  { test: (p, req) => (p === '/api/vec/status' && req.method === 'GET'), handler: h_api_vec_status },
  { test: (p, req) => (p === '/api/vec/build' && req.method === 'POST'), handler: h_api_vec_build },
  { test: (p, req) => (p === '/api/vec/search' && req.method === 'POST'), handler: h_api_vec_search },
  { test: (p, req) => (p === '/api/vec/config' && req.method === 'POST'), handler: h_api_vec_config },
  { test: (p, req) => (p === '/api/agent-mode' && req.method === 'GET'), handler: h_api_agent },
  { test: (p, req) => (p === '/api/agent-mode' && req.method === 'POST'), handler: h_api_agent },
  { test: (p, req) => (p === '/api/meta' && req.method === 'GET'), handler: h_api_agent },
  { test: (p, req) => (p === '/api/meta' && req.method === 'POST'), handler: h_api_agent },
  { test: (p, req) => (p === '/api/taboos' && req.method === 'GET'), handler: h_api_agent },
  { test: (p, req) => (p === '/api/taboos' && req.method === 'POST'), handler: h_api_agent },
  { test: (p, req) => (/^\/api\/cards\/export\/([^/]+)$/).test(p) && (req.method === 'GET'), handler: h_route_46 },
  { test: (p, req) => (p === '/api/cards/import' && req.method === 'POST'), handler: h_api_cards_import_47 },
  { test: (p, req) => (p === '/api/illustration/generate' && req.method === 'POST'), handler: h_api_illustration_generate_48 },
  { test: (p, req) => (p === '/api/illustration/config' && req.method === 'POST'), handler: h_api_illustration_config_49 },
  { test: (p, req) => (p === '/api/illustration/enhance' && req.method === 'POST'), handler: h_api_illustration_enhance_50 },
  { test: (p, req) => (p === '/api/tts/config' && req.method === 'POST'), handler: h_api_tts_config_51 },
  { test: (p, req) => (p === '/api/tts/config' && req.method === 'GET'), handler: h_api_tts_config_52 },
  { test: (p, req) => (p === '/api/tts/synthesize' && req.method === 'POST'), handler: h_api_tts_synthesize_53 },
  { test: (p, req) => (/^\/api\/annotations(?:\/([^/]+))?$/).test(p), handler: h_route_54 },
  { test: (p, req) => (p === '/api/fork/turns' && req.method === 'POST'), handler: h_api_fork_turns },
  { test: (p, req) => (p === '/api/last-chat' && req.method === 'GET'), handler: h_api_last_chat },
  { test: (p, req) => (p === '/api/op/note' && req.method === 'POST'), handler: h_api_op_note_55 },
  { test: (p, req) => (p === '/api/op/inject' && req.method === 'GET'), handler: h_api_op_inject_56 },
  { test: (p, req) => (p === '/api/op/inject' && req.method === 'POST'), handler: h_api_op_inject_57 },
  { test: (p, req) => (p === '/api/emotions' && req.method === 'GET'), handler: h_api_emotions_58 },
  { test: (p, req) => (p === '/api/op/emotion' && req.method === 'POST'), handler: h_api_op_emotion_59 },
  { test: (p, req) => (p === '/api/history/search' && req.method === 'GET'), handler: h_api_history_search_60 },
  { test: (p, req) => (p === '/api/stats' && req.method === 'GET'), handler: h_api_stats_61 },
  { test: (p, req) => (p === '/api/timeline' && req.method === 'GET'), handler: h_api_timeline_62 },
  { test: (p, req) => (p === '/api/prompt/latest' && req.method === 'GET'), handler: h_api_prompt_latest_63 },
  { test: (p, req) => (p === '/api/timeline/manual' && req.method === 'POST'), handler: h_api_timeline_manual_64 },
  { test: (p, req) => (p === '/api/timeline/update' && req.method === 'POST'), handler: h_api_timeline_update_65 },
  { test: (p, req) => (p === '/api/timeline/insert' && req.method === 'POST'), handler: h_api_timeline_insert_66 },
  { test: (p, req) => (p === '/api/timeline/delete' && req.method === 'POST'), handler: h_api_timeline_delete_67 },
  { test: (p, req) => (p === '/api/timeline/ai-fill' && req.method === 'POST'), handler: h_api_timeline_ai_fill_68 },
  { test: (p, req) => (p === '/api/timeline/truncate' && req.method === 'POST'), handler: h_api_timeline_truncate_69 },
  { test: (p, req) => (p === '/api/inventory' && req.method === 'GET'), handler: h_api_inventory_70 },
  { test: (p, req) => (p === '/api/inventory/manual' && req.method === 'POST'), handler: h_api_inventory_manual_71 },
  { test: (p, req) => (p === '/api/wardrobe/current' && req.method === 'GET'), handler: h_api_wardrobe_current_72 },
  { test: (p, req) => (p === '/api/timeline/export' && req.method === 'GET'), handler: h_api_timeline_export_73 },
  { test: (p, req) => p.startsWith('/api/group/') && p.split('/').length === 4 && (req.method === 'GET' || req.method === 'PUT'), handler: h_api_group },
  { test: (p, req) => (p === '/api/chat' && req.method === 'POST'), handler: h_api_chat_74 },
  { test: (p, req) => (p === '/api/op/attach-pending' && req.method === 'GET'), handler: h_api_op_attach_pending_75 },
  { test: (p, req) => (p === '/api/op/attach-pending' && req.method === 'POST'), handler: h_api_op_attach_pending_75 },
];
// ===== 路由处理分区结束 =====

// ---------- CSRF 闸门（2026-09-03 安全修复 C-3） ----------
// 背景：原本无任何 Origin/Referer 校验，且不验 content-type。`text/plain` 属浏览器「简单请求」
// （无需 CORS 预检），恶意网页用 <form enctype="text/plain"> 即可静默驱动本地服务
// （改端点偷 Key、删会话）。仅绑定 127.0.0.1 不构成防护。
// 设计要点：
//  1) 只校验写方法（GET/HEAD/OPTIONS 放行，不影响页面与轮询）；
//  2) 同源 Origin 放行；无 Origin 放行（curl/脚本，浏览器跨站必带 Origin）；
//  3) content-type 只在「确实带 body」时才要求 JSON —— 实测前端有 5 处无 body 的
//     POST/DELETE（DELETE /api/chats/:id、/api/npc-profiles/:name 等），
//     若无条件强制 JSON 会把它们全部打断。
function csrfGuard(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  const origin = req.headers.origin;
  if (origin) {
    const allowed = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
    if (!allowed.has(origin)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'CSRF 拒绝：不允许的 Origin' }));
      return false;
    }
  }
  const hasBody = req.headers['content-length'] && Number(req.headers['content-length']) > 0;
  const chunked = String(req.headers['transfer-encoding'] || '').includes('chunked');
  if (hasBody || chunked) {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json/i.test(ct)) {
      res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '写请求需 content-type: application/json' }));
      return false;
    }
  }
  return true;
}

async function handleRequest(req, res) {
  if (!csrfGuard(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  for (const r of ROUTES) {
    if (r.test(p, req)) {
      await r.handler(req, res, url, p);
      return;
    }
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
