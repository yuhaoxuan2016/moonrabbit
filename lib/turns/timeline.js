// lib/turns/timeline.js —— M-08·timeline-store 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { ASYNC_IO, writeFileAtomicSync, appendLine, writeQueued } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');
const { sanitizeId, turnsFile } = require('../tools/misc');
const { readTurns } = require('./store');

async function truncateTurnsBySeq(chatId, seq, mode) {
  const file = turnsFile(chatId);
  if (ASYNC_IO) {
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
  if (removed) writeFileAtomicSync(file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  return removed;
}
function buildInventory(chatId) {
  const inv = {};   // 物品名 -> {count, holder, last}
  const recent = []; // 最近 10 条变更
  for (const rec of readTurns(chatId)) {
    for (const g of (Array.isArray(rec.items_gain) ? rec.items_gain : [])) {   /* E-11：损坏数据（非数组）不再 500 */
      if (!g || !g.name) continue;   // 无名条目跳过，不产生垃圾键
      const key = g.name;
      inv[key] = inv[key] || { count: 0, holder: '' };
      inv[key].count += 1;
      if (g.holder) inv[key].holder = g.holder;
      inv[key].last = rec.ts;
      recent.push({ type: 'gain', name: g.name, holder: g.holder || '', ts: rec.ts });
    }
    for (const name of (Array.isArray(rec.items_loss) ? rec.items_loss : [])) {   /* E-11 */
      if (name && inv[name]) {
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
async function appendItemRecord(chatId, action, name, holder) {
  try {
    const rec = { story_time: '', location: '', atmosphere: '', characters: [], costume: '', event: '', items_gain: [], items_loss: [], updates: [], emotion: {} };
    rec.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    rec.ts = new Date().toISOString();
    rec.chatId = sanitizeId(chatId);
    if (action === 'gain') rec.items_gain.push({ name, holder: holder || '' });
    else rec.items_loss.push(name);
    const line = JSON.stringify(rec) + '\n';
    if (ASYNC_IO) { await writeQueued(turnsFile(chatId), () => appendLine(turnsFile(chatId), line)); return; }
    fs.appendFileSync(turnsFile(chatId), line, 'utf8');
  } catch (e) { console.error('[item-record] 失败:', e.message); }
}
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
    if (ASYNC_IO) { await writeQueued(turnsFile(chatId), () => appendLine(turnsFile(chatId), line)); return rec; }
    fs.appendFileSync(turnsFile(chatId), line, 'utf8');
    return rec;
  } catch (e) { console.error('[manual-turn] 失败:', e.message); return null; }
}
async function updateTurnRecord(chatId, id, fields) {
  const file = turnsFile(chatId);
  const rewrite = (lines) => {
    let updated = null;
    const out = lines.map((l) => {
      let o;
      try { o = JSON.parse(l); } catch (e) { return l; }
      if (o.id === id) { updated = { ...o, ...turnEditPatch(fields) }; return JSON.stringify(updated); }
      return l;
    });
    if (!updated) return null;
    return { out, updated };
  };
  if (ASYNC_IO) {
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
  writeFileAtomicSync(file, r.out.join('\n') + '\n', 'utf8');
  return r.updated;
}
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
  if (ASYNC_IO) {
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
  writeFileAtomicSync(file, lines.join('\n') + '\n', 'utf8');
  return rec;
}
async function deleteTurnRecord(chatId, id) {
  const file = turnsFile(chatId);
  if (ASYNC_IO) {
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
  writeFileAtomicSync(file, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
  return true;
}
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
const PROMPT_DIR = path.join(DATA_DIR, 'prompts');
function turnEditPatch(fields) {
  const patch = normalizeTurnFields(fields);
  if (!('items_gain' in (fields || {}))) delete patch.items_gain;
  if (!('items_loss' in (fields || {}))) delete patch.items_loss;
  if (!('emotion' in (fields || {}))) delete patch.emotion;
  if (!('location_detail' in (fields || {}))) delete patch.location_detail;
  return patch;
}

module.exports = { truncateTurnsBySeq, buildInventory, appendItemRecord, normalizeTurnFields, appendManualTurn, updateTurnRecord, insertTurnRecord, deleteTurnRecord, buildCurrentWardrobe, PROMPT_DIR, turnEditPatch };
