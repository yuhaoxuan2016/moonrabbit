// lib/store/emotions.js —— M-08·emotions-store 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const path = require('path');
const { writeFileAtomicSync } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');
const { sanitizeId } = require('../tools/misc');
const { appendOpRecord } = require('../turns/record');
const { readTurns } = require('../turns/store');

const DEFAULT_EMOTION_MAP = { '开心': '开心', '高兴': '开心', '快乐': '开心', '悲伤': '悲伤', '难过': '悲伤', '生气': '生气', '愤怒': '生气', '惊讶': '惊讶', '害羞': '害羞', '脸红': '害羞', '默认': '默认' };
const EMOTIONS_FILE = path.join(DATA_DIR, 'emotions.json');
function saveEmotions() {
  try { writeFileAtomicSync(EMOTIONS_FILE, JSON.stringify(State.emotions), 'utf8'); } catch (e) { /* 忽略 */ }
}
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
function emotionInject(chatId) {
  const cid = sanitizeId(chatId || '');
  if (!cid) return '';
  const emo = buildEmotions(cid);
  const names = Object.keys(emo);
  if (!names.length) return '';
  const lines = names.map((n) => `- ${n}：${emo[n]}`);
  return `## 当前情绪（界面追踪，冲突时以此为准）\n${lines.join('\n')}`;
}
function setEmotion(chatId, name, emo) {
  const cid = sanitizeId(chatId || '');
  if (!State.emotions[cid]) State.emotions[cid] = {};
  if (emo && emo.trim()) State.emotions[cid][name] = emo.trim();
  else delete State.emotions[cid][name];
  saveEmotions();
  appendOpRecord(cid, '情绪', `${name}：${emo.trim() || '（清除）'}`);
}

module.exports = { DEFAULT_EMOTION_MAP, EMOTIONS_FILE, saveEmotions, buildEmotions, emotionInject, setEmotion };
