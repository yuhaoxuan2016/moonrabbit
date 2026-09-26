// lib/store/annotations.js —— M-08·annotations 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync, backupConfig } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { sanitizeId } = require('../tools/misc');

const ANNOTATIONS_DIR = path.join(DATA_DIR, 'annotations');
function loadAnnotations(chatId) { chatId = sanitizeId(chatId); try { const f = path.join(ANNOTATIONS_DIR, `${chatId}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { notes: [] }; } catch (e) { return { notes: [] }; } }
function saveAnnotations(chatId, data) { chatId = sanitizeId(chatId); try { backupConfig(path.join(ANNOTATIONS_DIR, `${chatId}.json`)); writeFileAtomicSync(path.join(ANNOTATIONS_DIR, `${chatId}.json`), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('保存旁注失败:', chatId, e.message); } }

module.exports = { ANNOTATIONS_DIR, loadAnnotations, saveAnnotations };
