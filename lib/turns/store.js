// lib/turns/store.js —— M-08·turns-store 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const { turnsFile } = require('../tools/misc');

function readTurns(chatId) {
  try {
    const file = turnsFile(chatId);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

module.exports = { readTurns };
