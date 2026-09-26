// lib/store/stats.js —— M-08·stats 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { ASYNC_IO, writeJson, writeFileAtomicSync, writeQueued } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');

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
function saveStats() {
  if (ASYNC_IO) { return writeQueued(STATS_FILE, () => writeJson(STATS_FILE, stats)); }
  try { writeFileAtomicSync(STATS_FILE, JSON.stringify(stats), 'utf8'); } catch (e) { console.error('保存统计数据失败:', e.message); }
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
function bucket(model) {
  if (!stats.byModel[model]) stats.byModel[model] = emptyBucket();
  return stats.byModel[model];
}

module.exports = { STATS_FILE, emptyBucket, loadStats, stats, saveStats, summarize, bucket };
