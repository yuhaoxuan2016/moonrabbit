// lib/store/savepoints.js —— 存档点目录与列表（data/savepoints/{chatId}/{ts}.json）。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/paths');
const { sanitizeId } = require('../tools/misc');
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
module.exports = { savepointsDirFor, listSavepoints, SAVEPOINTS_DIR };
