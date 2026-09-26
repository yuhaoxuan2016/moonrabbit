// lib/vec/index.js —— M-08·vec 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync, backupConfig } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');
const { chatFilePath } = require('../store/chats');
const { sanitizeId } = require('../tools/misc');
const { readTurns } = require('../turns/store');

const VEC_CONFIG_FILE = path.join(DATA_DIR, 'vec-config.json');
function saveVecConfig() {
  try { backupConfig(VEC_CONFIG_FILE); writeFileAtomicSync(VEC_CONFIG_FILE, JSON.stringify(State.vecConfig, null, 2), 'utf8'); } catch (e) { console.error('保存向量配置失败:', e.message); }
}
const VEC_DIR = path.join(DATA_DIR, 'vec');
const VEC_BATCH = 20;            // 单次批量上限
const VEC_EMBED_DIM = 1024;      // 固定维度保持索引稳定
function vecModel() { return (State.vecConfig && State.vecConfig.model) || 'qwen3.7-text-embedding'; }
function vecApiKey() {
  if (State.vecConfig && State.vecConfig.apiKey) return State.vecConfig.apiKey;
  if (State.aux && State.aux.apiKey) return State.aux.apiKey;
  return process.env.DASHSCOPE_API_KEY || '';
}
function vecBase() { return String((State.vecConfig && State.vecConfig.baseURL) || '').trim().replace(/\/+$/, ''); }
function vecFilePath(chatId) { return path.join(VEC_DIR, `${sanitizeId(chatId || '')}.json`); }
function vecSummaryFilePath(chatId) { return path.join(DATA_DIR, 'summaries', `${sanitizeId(chatId || '')}.json`); }
function vecStripTags(s) {
  return String(s || '')
    .replace(/<(?:storyevent|horaeevent|items|horae)>[\s\S]*?<\/(?:storyevent|horaeevent|items|horae)>/gi, '')
    .replace(/<\/?(?:think|thinking)>/gi, '')
    .trim();
}
async function vecEmbed(texts) {
  const key = vecApiKey();
  if (!key) throw new Error('未配置 embedding API Key（可在「🔍 语义」面板填写，或配置辅助 API / 环境变量）');
  const base = vecBase();
  if (!base) throw new Error('未配置 embedding 端点地址（可在「🔍 语义」面板设置）');
  const out = [];
  for (let i = 0; i < texts.length; i += VEC_BATCH) {
    const batch = texts.slice(i, i + VEC_BATCH);
    const resp = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: vecModel(), input: batch, dimensions: VEC_EMBED_DIM }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`embedding 请求失败 HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const sorted = (data.data || []).slice().sort((a, b) => a.index - b.index);
    for (const d of sorted) out.push(d.embedding);
  }
  return out;
}
function vecCosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function vecCollectChunks(chatId) {
  const chunks = [];
  // ① 事件时间线（turn 记录的 event，带时间地点人物，语义完整）
  try {
    for (const t of readTurns(chatId)) {
      if (!t.event) continue;
      const time = t.story_time || '';
      const loc = t.location ? ` @ ${t.location}` : '';
      const chars = Array.isArray(t.characters) && t.characters.length ? `（${t.characters.join('、')}）` : '';
      chunks.push({ kind: 'event', seq: t.seq ?? null, text: `${time}${loc}${chars} ${t.event}`.trim() });
    }
  } catch (e) { /* 忽略 */ }
  // ② 对话原文（按消息切分；过长的截断到 1200 字，避免单块过大稀释语义）
  try {
    const file = chatFilePath(chatId);
    if (fs.existsSync(file)) {
      const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const m of (chat.messages || [])) {
        const body = vecStripTags(String(m.content || '')).trim();
        if (body.length < 10) continue;   // 太短的（「嗯」「好」）没有检索价值
        chunks.push({ kind: 'msg', seq: m.seq ?? null, role: m.role, text: body.slice(0, 1200) });
      }
    }
  } catch (e) { /* 忽略 */ }
  // ③ 历史摘要（自动压缩产生的累积摘要，回忆早期剧情时有用）
  try {
    const sf = vecSummaryFilePath(chatId);
    if (fs.existsSync(sf)) {
      const sm = JSON.parse(fs.readFileSync(sf, 'utf8'));
      const sum = String(sm.summary || '').trim();
      if (sum) {
        // 摘要通常较长 → 按段落切块，保证每块语义独立可召回
        for (const seg of sum.split(/\n{2,}/)) {
          const s = seg.trim();
          if (s.length >= 20) chunks.push({ kind: 'summary', seq: null, text: s.slice(0, 1200) });
        }
      }
    }
  } catch (e) { /* 忽略 */ }
  return chunks;
}
async function vecBuildIndex(chatId) {
  const chunks = vecCollectChunks(chatId);
  if (!chunks.length) return { ok: false, error: '没有可索引的内容（先聊几轮或确认该会话有数据）' };
  const embeddings = await vecEmbed(chunks.map(c => c.text));
  if (embeddings.length !== chunks.length) return { ok: false, error: `embedding 数量不匹配（${embeddings.length}/${chunks.length}）` };
  const index = {
    version: 1,
    model: vecModel(),
    dim: VEC_EMBED_DIM,
    at: new Date().toISOString(),
    items: chunks.map((c, i) => ({ ...c, vec: embeddings[i] })),
  };
  if (!fs.existsSync(VEC_DIR)) fs.mkdirSync(VEC_DIR, { recursive: true });
  writeFileAtomicSync(vecFilePath(chatId), JSON.stringify(index), 'utf8');
  const byKind = {};
  for (const c of chunks) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
  return { ok: true, total: chunks.length, byKind, at: index.at };
}
function vecLoadIndex(chatId) {
  try {
    const f = vecFilePath(chatId);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { return null; }
}
async function vecSearch(chatId, query, topK = 6, kinds = null) {
  const index = vecLoadIndex(chatId);
  if (!index || !Array.isArray(index.items) || !index.items.length) {
    return { ok: false, error: '该会话尚未建立向量索引（先点「建立/重建索引」）' };
  }
  const [qvec] = await vecEmbed([String(query || '').slice(0, 2000)]);
  if (!qvec) return { ok: false, error: 'query embedding 失败' };
  const pool = kinds && kinds.length ? index.items.filter(it => kinds.includes(it.kind)) : index.items;
  const scored = pool.map(it => ({ kind: it.kind, seq: it.seq, role: it.role, text: it.text, score: vecCosine(qvec, it.vec) }));
  scored.sort((a, b) => b.score - a.score);
  return { ok: true, hits: scored.slice(0, Math.max(1, Math.min(topK, 30))), total: pool.length, at: index.at };
}

module.exports = { VEC_CONFIG_FILE, saveVecConfig, VEC_DIR, VEC_BATCH, VEC_EMBED_DIM, vecModel, vecApiKey, vecBase, vecFilePath, vecSummaryFilePath, vecStripTags, vecEmbed, vecCosine, vecCollectChunks, vecBuildIndex, vecLoadIndex, vecSearch };
