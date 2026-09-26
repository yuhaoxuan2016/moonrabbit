// lib/http/handlers/group.js —— M-08·group-handler 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const { writeFileAtomicSync } = require('../../core/io');
const { readBody } = require('../respond');
const { chatFilePath } = require('../../store/chats');

async function h_api_group(req, res, url, p) {
  const m = p.match(/^\/api\/group\/([^/]+)$/);
  if (!m) return false;
  const cid = m[1];
  const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  if (req.method === 'GET') {
    try {
      const d = JSON.parse(fs.readFileSync(chatFilePath(cid), 'utf8'));
      sendJson({ ok: true, groupMode: !!d.groupMode, roster: d.roster || [],
        maxSpeakersPerTurn: d.maxSpeakersPerTurn || 4 });
      return true;
    } catch (e) { sendJson({ ok: false, error: e.message }, 500); return true; }
  }
  if (req.method === 'PUT') {
    try {
      const body = await readBody(req);
      const data = JSON.parse(body);
      const file = chatFilePath(cid);
      const chat = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.groupMode !== undefined) chat.groupMode = !!data.groupMode;
      if (data.roster !== undefined) chat.roster = data.roster;
      if (data.maxSpeakersPerTurn !== undefined) chat.maxSpeakersPerTurn = data.maxSpeakersPerTurn;
      writeFileAtomicSync(file, JSON.stringify(chat, null, 2), 'utf8');
      sendJson({ ok: true });
      return true;
    } catch (e) { sendJson({ ok: false, error: e.message }, 500); return true; }
  }
  return false;
}

module.exports = { h_api_group };
