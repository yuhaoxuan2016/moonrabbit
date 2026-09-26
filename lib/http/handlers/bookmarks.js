// lib/http/handlers/bookmarks.js —— 消息书签：读取与 toggle/delete。
const { sanitizeId } = require('../../tools/misc');
const { readBody } = require('../respond');
const { loadBookmarks, saveBookmarks } = require('../../store/bookmarks');

async function h_api_bookmarks(req, res, url, p) {
  const m = p.match(/^\/api\/bookmarks(?:\/([^/]+))?$/);
  if (!m) return false;
  const chatId = m[1] ? sanitizeId(decodeURIComponent(m[1])) : null;
  const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
  if (!chatId) { sendJson({ error: '缺少 chatId' }, 400); return true; }
  if (req.method === 'GET') { sendJson({ ok: true, ...loadBookmarks(chatId) }); return true; }
  if (req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { action, mark } = JSON.parse(body || '{}');
      const bm = loadBookmarks(chatId);
      if (action === 'toggle') {
        const seq = Number(mark?.seq);
        if (!Number.isFinite(seq)) { sendJson({ error: '缺少 seq' }, 400); return true; }
        const idx = bm.marks.findIndex(x => Number(x.seq) === seq);
        if (idx >= 0) {
          bm.marks.splice(idx, 1);
          saveBookmarks(chatId, bm);
          sendJson({ ok: true, marked: false, total: bm.marks.length });
        } else {
          bm.marks.push({
            id: 'bm_' + Date.now(),
            seq,
            label: String(mark?.label || '').slice(0, 60),
            role: mark?.role === 'user' ? 'user' : 'assistant',
            createdAt: new Date().toISOString(),
          });
          bm.marks.sort((a, b) => Number(a.seq) - Number(b.seq));
          saveBookmarks(chatId, bm);
          sendJson({ ok: true, marked: true, total: bm.marks.length });
        }
        return true;
      }
      if (action === 'delete') {
        bm.marks = bm.marks.filter(x => x.id !== mark?.id);
        saveBookmarks(chatId, bm);
        sendJson({ ok: true }); return true;
      }
      sendJson({ error: '未知操作（支持 toggle/delete）' }, 400); return true;
    } catch (e) { sendJson({ error: String(e && e.message || e) }, 400); return true; }
  }
  return false;
}
module.exports = { h_api_bookmarks };
