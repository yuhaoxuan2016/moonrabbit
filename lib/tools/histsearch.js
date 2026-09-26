// lib/tools/histsearch.js —— M-08·histsearch 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { State } = require('../core/state');
const { CHATS_DIR } = require('../store/chats');
const { sanitizeId } = require('./misc');

function handleHistorySearch(url, res) {
  const q = url.searchParams.get('q') || '';
  const rawChatId = (url.searchParams.get('chatId') || '').trim();
  const onlyChatId = rawChatId ? sanitizeId(rawChatId) : '';   // 空 = 搜索全部会话
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 100);
  const kws = splitKeywords(q);
  if (!kws.length) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: '缺少关键词 q' }));
  }
  const chats = loadHistIndex().filter((c) => !onlyChatId || c.id === onlyChatId);
  const results = [];
  for (const chat of chats) {
    for (const m of chat.messages) {
      const low = m.content.toLowerCase();
      let hits = 0, all = true;
      for (const k of kws) {
        const n = low.split(k).length - 1;
        if (n === 0) { all = false; break; }
        hits += n;
      }
      if (!all) continue;
      const ranges = keywordRanges(m.content, kws);
      const score = hits * 3 + kws.length * 5 + (m.content.length < 300 ? 8 : 0);
      results.push({
        chatId: chat.id, chatTitle: chat.title, seq: m.seq, role: m.role,
        score, hits, snippet: makeSnippet(m.content, ranges), ranges, content: m.content,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, limit);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  return res.end(JSON.stringify({ query: q, kws, total: results.length, results: top }));
}
function loadHistIndex() {
  try {
    const files = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith('.json')).sort();
    const sig = files.map((f) => {
      try { return `${f}:${fs.statSync(path.join(CHATS_DIR, f)).mtimeMs}`; } catch (e) { return `${f}:gone`; }
    }).join('|');
    if (sig === State.histIndexCache.mtimes) return State.histIndexCache.chats;
    const chats = files.map((f) => {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf8'));
        const messages = (c.messages || []).map((m, i) => ({
          seq: m.seq || (i + 1), role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || ''),
        })).filter((m) => m.content);
        const profileId = c.chatProfile || 'main';
        const profile = State.chatProfiles[profileId] || State.chatProfiles.main || {};
        return { id: c.id, title: c.title || '未命名', updatedAt: c.updatedAt || '', messages, chatProfile: profileId, profileLabel: profile.label || profileId, profileColor: profile.color || '#639922' };
      } catch (e) { return null; }
    }).filter(Boolean);
    State.histIndexCache = { mtimes: sig, chats };
    return chats;
  } catch (e) { return []; }
}
function splitKeywords(q) {
  return String(q || '').split(/[\s,，、;；]+/).map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0);
}
function keywordRanges(content, kws) {
  const low = content.toLowerCase();
  const ranges = [];
  for (const k of kws) {
    let idx = 0;
    while (idx < low.length) {
      const at = low.indexOf(k, idx);
      if (at < 0) break;
      ranges.push({ from: at, to: at + k.length });
      idx = at + k.length;
    }
  }
  return ranges.sort((a, b) => a.from - b.from);
}
function makeSnippet(content, ranges) {
  if (!ranges.length) return content.slice(0, 160);
  const c = ranges[0].from;
  const start = Math.max(0, c - 60);
  const end = Math.min(content.length, c + 160);
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '');
}

module.exports = { handleHistorySearch, loadHistIndex, splitKeywords, keywordRanges, makeSnippet };
