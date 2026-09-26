// lib/store/reports.js —— M-08·reports 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { sanitizeId } = require('../tools/misc');

const REPORTS_DIR = path.join(DATA_DIR, 'reports');
function listReports(chatId) { try { const d = path.join(REPORTS_DIR, sanitizeId(chatId)); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.md')).map(f => ({ filename: f, ts: f.replace('.md', '') })).sort((a, b) => b.ts.localeCompare(a.ts)) : []; } catch (e) { return []; } }
function saveReport(chatId, type, content) { try { const d = path.join(REPORTS_DIR, sanitizeId(chatId)); fs.mkdirSync(d, { recursive: true }); const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); const fn = `${type}_${ts}.md`; writeFileAtomicSync(path.join(d, fn), content, 'utf8'); const files = fs.readdirSync(d).filter(f => f.endsWith('.md')).sort(); while (files.length > 20) { try { fs.unlinkSync(path.join(d, files.shift())); } catch (e) {} } return fn; } catch (e) { return null; } }

module.exports = { REPORTS_DIR, listReports, saveReport };
