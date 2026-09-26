// lib/store/bookmarks.js —— 按会话存的消息书签与剧情备忘（同型：chatId -> 单个 JSON）。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/paths');
const { sanitizeId } = require('../tools/misc');
const { writeFileAtomicSync, backupConfig } = require('../core/io');

// ---------- 消息书签（2026-09-02 NEW-2）----------
const BOOKMARKS_DIR = path.join(DATA_DIR, 'bookmarks');
fs.mkdirSync(BOOKMARKS_DIR, { recursive: true });
function loadBookmarks(chatId) {
  chatId = sanitizeId(chatId);
  try { const f = path.join(BOOKMARKS_DIR, `${chatId}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { marks: [] }; } catch (e) { return { marks: [] }; }
}
function saveBookmarks(chatId, data) {
  chatId = sanitizeId(chatId);
  try { writeFileAtomicSync(path.join(BOOKMARKS_DIR, `${chatId}.json`), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('保存书签失败:', chatId, e.message); }
}

// ---------- 剧情备忘（Agenda） ----------
const AGENDA_DIR = path.join(DATA_DIR, 'agenda');
fs.mkdirSync(AGENDA_DIR, { recursive: true });
function loadAgenda(chatId) { chatId = sanitizeId(chatId); try { const f = path.join(AGENDA_DIR, `${chatId}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { items: [] }; } catch (e) { return { items: [] }; } }
function saveAgenda(chatId, data) { chatId = sanitizeId(chatId); try { backupConfig(path.join(AGENDA_DIR, `${chatId}.json`)); writeFileAtomicSync(path.join(AGENDA_DIR, `${chatId}.json`), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('保存剧情备忘失败:', chatId, e.message); } }
module.exports = { loadBookmarks, saveBookmarks, loadAgenda, saveAgenda, BOOKMARKS_DIR, AGENDA_DIR };
