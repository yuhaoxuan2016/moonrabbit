// lib/agent/meta.js —— Meta 通道骨架（零侵入）
// ⚠️ 依赖倒置：本模块**不 require server.js**；fs/path/目录由 server.js 经 createMetaStore(io) 注入；
// 分类调用的调用链（auxCall / 队列 / 超时）留在 server.js，本模块只出「提示词 + 解析 + 存取」纯逻辑。
// 🔴 ：Meta 内容**绝不写 data/chats/\***——本模块的写路径只有 io.dir 一个（server.js 传 data/meta）。
// 🔴 ：原文永存——JSONL **append-only**，摘要另起一行（kind:'summary'），原文 raw 一行都不删。
'use strict';

// N3 建议值 a：200 条（Route C 实证 30 回合 ≈ 60 条 → 200 条够 3 个节点）
const META_MAX_ENTRIES = 200;
const CLASSIFY_MAX_TOKENS = 512; // 分类输出很短（一行 JSON），512 足够
const SUMMARY_MAX_CHARS = 400; // 摘要文本上限（另一行存储，不动原文）

// 三类语义与回标 tag（写死；3.8.2 / E3 原文）
const CLS = { canon: 'canon', direction: 'direction', query: 'query' };
const CLS_TAGS = { canon: '[已理解为·设定]', direction: '[临时]', query: '[疑问回答]' };
const TAG_OF = (cls) => CLS_TAGS[cls] || CLS_TAGS.query;

/** 分类器 system：写死三类语义 + 强制 tag + 「查不到就说查不到」 */
function buildClassifyPrompt() {
 return [
 '你是 Moonrabbit 的 **Meta 分类器**。用户会直接对 agent 说一句话，',
 '你只做一件事：判断这句话属于下面哪一类，并给出回标与摘要。**不要扮演角色、不要写剧情、不要回答问题本身。**',
 '',
 '【三类定义（必须严格按此判定）】',
 '- canon ＝ **设定·长期**：用户在给 agent 补世界观/角色设定（例：「她的眼睛是灰蓝色的」）。持久有效。',
 '- direction ＝ **临时指示·仅本轮或本节点**：导演意图，只影响接下来这段怎么演（例：「这段让她先哭后笑」「下章奥托会死」）。',
 '- query ＝ **疑问·不持久**：用户在问 agent 一个设定问题，agent 答完即弃（例：「她的本名是什么？」）。',
 '',
 '【硬纪律】',
 '- **必须输出 tag**——没有回标，用户随口一句就会被当成长期设定，这是必然故障。',
 '- **查不到就说查不到，不得编造**。分类不是让你补设定，只做归类。',
 '- 三种都不像（无意义字符、乱码、纯寒暄）→ 归 query。',
 '',
 '【输出格式】只输出一行 JSON，不要解释、不要代码围栏：',
 '{"cls":"canon|direction|query","tag":"[已理解为·设定]|[临时]|[疑问回答]","summary":"一句话概括，40 字内"}',
 ].join('\n');
}

/** 分类器 user：待分类的用户原话（截断防爆） */
function buildClassifyUser(text) {
 return `【用户原话】\n${String(text == null ? '' : text).slice(0, 1000)}\n\n请输出分类 JSON。`;
}

/** 从 aux 输出里抠出第一个 JSON 对象（容忍代码围栏与前后废话） */
function extractJson(raw) {
 const t = String(raw == null ? '' : raw).trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
 const s = t.indexOf('{');
 const e = t.lastIndexOf('}');
 if (s < 0 || e <= s) return null;
 try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
}

/**
 * 解析分类产物 → 三态（形状照 lib/agent/tools.js L25-27）。
 * @returns {{ok:true,data:{cls,tag,summary},note?:string}} |
 * {{ok:false,data:'',error:string,kind:string}}
 */
function parseClassify(raw) {
 const t = String(raw == null ? '' : raw).trim();
 if (!t) return { ok: false, data: '', error: '分类器无输出', kind: 'empty' };
 const j = extractJson(raw);
 if (!j) return { ok: false, data: '', error: '分类器输出不是 JSON', kind: 'parse' };
 const cls = String(j.cls == null ? '' : j.cls).trim().toLowerCase();
 const summary = String(j.summary == null ? '' : j.summary).trim().slice(0, SUMMARY_MAX_CHARS);
 if (!CLS[cls]) {
 // 类别不可识别 → 按 query 处理（三态之「有结论但降级」，不是失败）
 return { ok: true, data: { cls: 'query', tag: TAG_OF('query'), summary }, note: '无法分类，按 query 处理' };
 }
 return { ok: true, data: { cls, tag: TAG_OF(cls), summary } };
}

/**
 * JSONL 存取（io 注入）：
 * io = { fs, path, dir, sanitizeId?, summarize? }
 * · dir ＝ Meta 目录（server.js 传 path.join(DATA_DIR,'meta')）
 * · summarize(text) → Promise<string> 可选；缺失时 summarizeIfNeeded 只报告不落摘要（不阻断）
 * @returns {{append, list, count, summarizeIfNeeded, fileOf}}
 */
function createMetaStore(io) {
 const fs = io.fs, path = io.path, dir = io.dir;
 const sid = typeof io.sanitizeId === 'function' ? io.sanitizeId : (x) => String(x == null ? '' : x);
 const fileOf = (chatId) => path.join(dir, sid(chatId || '') + '.jsonl');
 try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* 目录建不了 → 后续 append 会报错并被上层记日志 */ }

 /** 追加一行（append-only；无 BOM、LF）。entry.at 缺省补 ISO 时间 */
 function append(chatId, entry) {
 const row = Object.assign({ at: new Date().toISOString() }, entry || {});
 fs.appendFileSync(fileOf(chatId), JSON.stringify(row) + '\n', 'utf8'); // 无 BOM
 return row;
 }

 /** 读全部（坏行跳过、不阻断） */
 function readAll(chatId) {
 const f = fileOf(chatId);
 let raw = '';
 try { raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { return []; } // ENOENT → 空
 const out = [];
 for (const line of raw.split('\n')) {
 if (!line.trim()) continue;
 try { out.push(JSON.parse(line)); } catch (e) { /* 坏行跳过（不阻断整读） */ }
 }
 return out;
 }

 /** 最近 limit 条（默认 50 防爆；limit<=0 视作不限） */
 function list(chatId, limit) {
 const all = readAll(chatId);
 const n = Number(limit);
 if (Number.isFinite(n) && n > 0) return all.slice(-n);
 return all;
 }

 function count(chatId) { return readAll(chatId).length; }

 /**
 * 摘要：条数 > 上限 → 对**最旧的一半**生成摘要，**另追加一行**（kind:'summary'），
 * 原文 raw 一行都不删（append-only）。已覆盖同一区间的不重复摘要。
 * @returns {Promise<{ok:boolean, summarized:boolean, count:number, from?:number, to?:number, reason?:string}>}
 */
 async function summarizeIfNeeded(chatId, opts) {
 const max = Number(opts && opts.maxEntries) > 0 ? Number(opts.maxEntries) : META_MAX_ENTRIES;
 const all = readAll(chatId);
 if (all.length <= max) return { ok: true, summarized: false, count: all.length, reason: `未超上限（${all.length}/${max}）` };
 const half = Math.floor(all.length / 2); // 最旧的一半（行序位置 0 .. half-1）
 const oldest = all.slice(0, half);
 const to = half - 1;
 const lastSum = [...all].reverse().find((r) => r && r.kind === 'summary');
 if (lastSum && Number(lastSum.coversTo) >= to) return { ok: true, summarized: false, count: all.length, reason: '该区间已有摘要' };
 const text = oldest.map((r) => `${r.role === 'user' ? '用户' : 'agent'}：${String(r.raw || r.summary || '').slice(0, 200)}`).join('\n').slice(0, 6000);
 if (typeof io.summarize !== 'function') return { ok: false, summarized: false, count: all.length, reason: '未注入 summarize（只报告不落摘要）' };
 let sum = '';
 try { sum = String(await io.summarize(text) || '').trim().slice(0, SUMMARY_MAX_CHARS); } catch (e) { return { ok: false, summarized: false, count: all.length, reason: '摘要调用失败：' + e.message }; }
 if (!sum) return { ok: false, summarized: false, count: all.length, reason: '摘要产物为空' };
 append(chatId, { role: 'agent', cls: null, kind: 'summary', summary: sum, coversFrom: 0, coversTo: to });
 return { ok: true, summarized: true, count: all.length + 1, from: 0, to };
 }

 return { append, list, count, readAll, summarizeIfNeeded, fileOf };
}

/**
 * · Meta 记账：只进 agentTokens 的 **meta 子桶**，不进 stats.byModel 主模型费用桶。
 * 前端 💰 区读的是 calls/planCalls/checkCalls/retryCalls → 本函数不碰这些键，故 💰 区天然不显示 Meta 开销。
 */
function addMetaUsage(bucket, usage, ms) {
 if (!bucket || typeof bucket !== 'object') return bucket;
 if (!bucket.meta) bucket.meta = { calls: 0, realIn: 0, realOut: 0, realCalls: 0, ms: 0, usageKnown: false };
 const m = bucket.meta;
 m.calls += 1;
 if (Number.isFinite(ms)) m.ms += Math.max(0, ms);
 const u = usage || {};
 const inTok = Number(u.input_tokens != null ? u.input_tokens : u.prompt_tokens) || 0;
 const outTok = Number(u.output_tokens != null ? u.output_tokens : u.completion_tokens) || 0;
 if (inTok || outTok) {
 m.realIn += inTok; m.realOut += outTok; m.realCalls += 1; m.usageKnown = true;
 }
 return bucket;
}

module.exports = {
 META_MAX_ENTRIES, CLASSIFY_MAX_TOKENS, SUMMARY_MAX_CHARS,
 CLS, CLS_TAGS, TAG_OF,
 buildClassifyPrompt, buildClassifyUser, extractJson, parseClassify,
 createMetaStore, addMetaUsage,
};