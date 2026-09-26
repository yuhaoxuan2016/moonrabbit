// lib/turns/record.js —— M-08·turns-record 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const { ASYNC_IO, appendLine, writeQueued } = require('../core/io');
const { sanitizeId, turnsFile } = require('../tools/misc');

async function appendOpRecord(chatId, entry, content) {
  try {
    const rec = { story_time: '', location: '', atmosphere: '', characters: [], costume: '', event: '', items_gain: [], items_loss: [], updates: [{ entry, content }] };
    rec.id = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    rec.ts = new Date().toISOString();
    rec.chatId = sanitizeId(chatId);
    const line = JSON.stringify(rec) + '\n';
    if (ASYNC_IO) { await writeQueued(turnsFile(chatId), () => appendLine(turnsFile(chatId), line)); return; }
    fs.appendFileSync(turnsFile(chatId), line, 'utf8');
  } catch (e) { console.error('[op-record] 失败:', e.message); }
}

module.exports = { appendOpRecord };
