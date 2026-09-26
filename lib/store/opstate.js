// lib/store/opstate.js —— M-08·opstate 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { ASYNC_IO, writeJson, writeFileAtomicSync, writeQueued } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');
const { sanitizeId } = require('../tools/misc');

const OP_FILE = path.join(DATA_DIR, 'op.json');
function saveOpState() {
  // 二次保险（2026-08-30 事故教训）：内存态为空但盘上已有真实数据 → 写盘前留档现场并告警
  try {
    const snapshot = JSON.stringify(State.opState);
    const diskRaw = fs.existsSync(OP_FILE) ? fs.readFileSync(OP_FILE, 'utf8') : '';
    if (diskRaw.trim()) {
      let diskNotes = 0, memNotes = 0;
      try {
        const d = JSON.parse(diskRaw);
        diskNotes = d && d.notes ? Object.keys(d.notes).length : 0;
      } catch (e) { /* 盘上损坏 → 不比对 */ }
      try {
        const m = State.opState && State.opState.notes ? State.opState.notes : {};
        memNotes = Object.keys(m).length;
      } catch (e) { /* 忽略 */ }
      if (diskNotes > 0 && memNotes === 0 && diskRaw.length > snapshot.length) {
        fs.copyFileSync(OP_FILE, OP_FILE + '.preoverwrite_' + Date.now());
        console.error('[op.json] 警告：盘上有 ' + diskNotes + ' 个会话速记但内存为空——已留档 .preoverwrite_*，本次仍按内存写盘');
      }
    }
    if (ASYNC_IO) { return writeQueued(OP_FILE, () => writeJson(OP_FILE, State.opState)); }
    writeFileAtomicSync(OP_FILE, snapshot, 'utf8');
  } catch (e) { console.error('保存操作状态失败:', e.message); }
}
const NOTE_SLOTS = ['背景', '关系', '规则', '其他'];
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
function noteText(chatId) {
  const slots = noteSlots(chatId);
  return NOTE_SLOTS.map((k) => slots[k] || '').filter(Boolean).join('\n');
}
function noteInjectText(chatId) {
  const slots = noteSlots(chatId);
  const names = Object.keys(slots);
  if (!names.length) return '';
  return names.map((k) => `【${k}】\n${slots[k]}`).join('\n\n');
}
function customInjections(chatId) {
  const cid = sanitizeId(chatId || '');
  const inj = (State.opState.customInjections && State.opState.customInjections[cid]) || {};
  return { prefix: String(inj.prefix || '').trim(), suffix: String(inj.suffix || '').trim() };
}

module.exports = { OP_FILE, saveOpState, NOTE_SLOTS, noteSlots, noteText, noteInjectText, customInjections };
