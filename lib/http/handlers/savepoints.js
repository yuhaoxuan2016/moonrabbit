// lib/http/handlers/savepoints.js —— 存档点：保存 / 列表 / 恢复。
const fs = require('fs');
const path = require('path');
const { sanitizeId } = require('../../tools/misc');
const { readBody } = require('../respond');
const { writeFileAtomicSync } = require('../../core/io');
const { chatFilePath } = require('../../store/chats');
const { savepointsDirFor, listSavepoints, SAVEPOINTS_DIR } = require('../../store/savepoints');

async function h_api_savepoints_save_9(req, res, url, p) {
  // 存档点：保存当前会话完整副本 / 列表 / 读取恢复
    if (p === '/api/savepoints/save' && req.method === 'POST') {
      let body = await readBody(req);
      const sendJson = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
      try {
        const { chatId, label } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        const src = chatFilePath(cid);   // 读源必须用消毒后的 cid（防路径穿越外带任意 JSON）
        if (!fs.existsSync(src)) { sendJson({ ok: false, error: '会话不存在' }, 404); return true; };
        const chat = JSON.parse(fs.readFileSync(src, 'utf8'));
        const ts = Date.now();
        // 存档 = 会话完整副本（附带存档元信息 savepoint，读档时剥离）
        const snap = { ...chat, savepoint: { ts, label: String(label || '').trim().slice(0, 40), savedAt: new Date().toISOString() } };
        writeFileAtomicSync(path.join(savepointsDirFor(chatId), `${ts}.json`), JSON.stringify(snap, null, 2), 'utf8');
        { sendJson({ ok: true, ts, note: `已存档：${new Date(ts).toLocaleString()}${snap.savepoint.label ? '（' + snap.savepoint.label + '）' : ''}` }); return true; };
      } catch (e) {
        { sendJson({ ok: false, error: String(e) }, 400); return true; };
      }
    }
  return false;
}

async function h_api_savepoints_list_10(req, res, url, p) {
  if (p === '/api/savepoints/list' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      { res.end(JSON.stringify({ ok: true, savepoints: listSavepoints(url.searchParams.get('chatId') || '') })); return true; };
    }
  return false;
}

async function h_api_savepoints_load_11(req, res, url, p) {
  if (p === '/api/savepoints/load' && req.method === 'POST') {
      let body = await readBody(req);
      const sendJson = (obj, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
      try {
        const { chatId, ts } = JSON.parse(body);
        const cid = sanitizeId(chatId || '');
        const file = path.join(SAVEPOINTS_DIR, cid, `${Number(ts)}.json`);
        if (!fs.existsSync(file)) { sendJson({ ok: false, error: '存档点不存在' }, 404); return true; };
        const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
        // 恢复 = 用存档副本覆盖当前会话文件（剥离 savepoint 元信息，保持当前会话 id）
        const { savepoint, ...rest } = snap;
        const chat = { ...rest, id: cid, updatedAt: new Date().toISOString() };
        writeFileAtomicSync(chatFilePath(cid), JSON.stringify(chat), 'utf8');
        { sendJson({ ok: true, note: '已从存档点恢复' }); return true; };
      } catch (e) {
        { sendJson({ ok: false, error: String(e) }, 400); return true; };
      }
    }
  return false;
}
module.exports = { h_api_savepoints_save_9, h_api_savepoints_list_10, h_api_savepoints_load_11 };
