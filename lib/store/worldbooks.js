// lib/store/worldbooks.js —— M-08·worldbooks 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync, backupConfig } = require('../core/io');
const { WWW, DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');
const { sanitizeId } = require('../tools/misc');

function resolveWorldbookDir(rawPath) {
  const s = String(rawPath || '').trim();
  if (!s) { const e = new Error('请填写世界书目录'); e.statusCode = 400; throw e; }
  const abs = path.isAbsolute(s) ? path.resolve(s) : path.resolve(WWW, s);
  // 允许绝对路径（用户自有资料库），但相对路径不得穿越出 WWW
  if (!path.isAbsolute(s)) {
    const rel = path.relative(WWW, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const e = new Error('拒绝穿越到程序目录之外的相对路径'); e.statusCode = 400; throw e;
    }
  }
  return abs;
}
function saveLorebook() { try { backupConfig(LOREBOOK_FILE); writeFileAtomicSync(LOREBOOK_FILE, JSON.stringify({ entries: State.lorebookEntries, settings: State.lorebookSettings, version: 1 }, null, 2), 'utf8'); } catch (e) { console.error('保存设定触发器失败:', e.message); } }
function scanLorebook(messages, userInput, maxContext) {
  // 整体开关：设定触发器被禁用时直接不注入
  if (State.lorebookSettings.enabled === false) return { entries: [], totalTokens: 0, budget: 0, matched: 0, disabled: true };
  const budget = State.lorebookSettings.tokenBudget === 'auto' ? Math.floor((maxContext || 1048576) * State.lorebookSettings.budgetRatio) : State.lorebookSettings.tokenBudget === 'unlimited' ? Infinity : Number(State.lorebookSettings.tokenBudget) || 10000;
  const recentText = (messages || []).slice(-10).map(m => String(m.content || '')).join('\n') + '\n' + (userInput || '');
  const matched = []; const seen = new Set();
  for (const [id, e] of Object.entries(State.lorebookEntries)) { if (!e.enabled) continue; if (e.constant) { matched.push({ id, ...e }); seen.add(id); } }
  for (const [id, e] of Object.entries(State.lorebookEntries)) { if (!e.enabled || e.constant || seen.has(id)) continue; const kws = e.keywords || []; const hit = (e.matchMode || 'any') === 'any' ? kws.some(k => k.length >= 2 && recentText.includes(k)) : kws.every(k => k.length >= 2 && recentText.includes(k)); if (hit) { matched.push({ id, ...e }); seen.add(id); } }
  matched.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  // 应用 token 预算：常驻条目豁免（始终注入），仅关键词条目受预算截断
  let total = 0; const result = [];
  const constantEntries = matched.filter(e => e.constant);
  const keywordEntries = matched.filter(e => !e.constant);
  for (const e of constantEntries) { const t = Math.ceil(String(e.content || '').length * 0.67); result.push(e); total += t; }
  for (const e of keywordEntries) { const t = Math.ceil(String(e.content || '').length * 0.67); if (total + t > budget) break; total += t; result.push(e); }
  return { entries: result, totalTokens: total, budget, matched: matched.length };
}
const WORLDBOOKS_DIR = path.join(DATA_DIR, 'worldbooks');
function saveWorldbook(bookId) {
  const wb = State.worldbooks[bookId];
  if (!wb) return false;
  try {
    fs.mkdirSync(WORLDBOOKS_DIR, { recursive: true });
    writeFileAtomicSync(path.join(WORLDBOOKS_DIR, bookId + '.json'),
      JSON.stringify({ book: wb.book, settings: wb.settings, entries: wb.entries }, null, 2), 'utf8');
    return true;
  } catch (e) { console.error('世界书保存失败: ' + e.message); return false; }
}
function activeBookIds(chatId) {
  const cid = sanitizeId(chatId || '');
  const rec = (State.opState.worldbooks && State.opState.worldbooks[cid]) || null;
  return Array.isArray(rec && rec.active) ? rec.active.slice() : [];
}
function offBookIds(chatId) {
  const cid = sanitizeId(chatId || '');
  const rec = (State.opState.worldbooks && State.opState.worldbooks[cid]) || null;
  return Array.isArray(rec && rec.off) ? rec.off.slice() : [];
}
function scanWorldbooks(messages, userInput, maxContext, chatId, opts) {
  // 整体开关（设置里「启用注入」）：关闭后设定触发器与世界书都不注入
  if (State.lorebookSettings.enabled === false) return { entries: [], totalTokens: 0, budget: 0, matched: 0, disabled: true };
  const skipGlobal = !!(opts && opts.skipGlobal) || !!(opts && opts.skipLegacy);
  const budget = State.lorebookSettings.tokenBudget === 'auto'
    ? Math.floor((maxContext || 1048576) * (State.lorebookSettings.budgetRatio || 0.1))
    : State.lorebookSettings.tokenBudget === 'unlimited' ? Infinity : Number(State.lorebookSettings.tokenBudget) || 10000;
  const actives = activeBookIds(chatId);
  const offs = offBookIds(chatId);
  const pool = [];
  if (!skipGlobal) {
    for (const [id, e] of Object.entries(State.lorebookEntries || {})) {
      if (e && e.enabled !== false) pool.push({ id, ...e, book: '全局设定触发器' });
    }
  }
  for (const [bookId, wb] of Object.entries(State.worldbooks || {})) {
    if (wb.settings && wb.settings.enabled === false) continue;
    const isGlobal = wb.book.scope === 'global';
    if (isGlobal && skipGlobal) continue;
    if (offs.includes(bookId)) continue;   // 本会话已停用（对 global / chat 书都生效）
    if (!isGlobal && !actives.includes(bookId)) continue;
    for (const [eid, e] of Object.entries(wb.entries || {})) {
      if (e && e.enabled !== false) pool.push({ id: bookId + ':' + eid, ...e, book: wb.book.name || bookId, bookId });
    }
  }
  const recentText = (messages || []).slice(-10).map(m => String(m.content || '')).join('\n') + '\n' + (userInput || '');
  const matched = [];
  for (const e of pool) {
    if (e.constant) { matched.push(e); continue; }
    const kws = e.keywords || [];
    const mode = e.matchMode || 'any';
    const allMode = (mode === 'every' || mode === 'all');
    const hit = allMode
      ? (kws.length > 0 && kws.every(kw => String(kw).length >= 2 && recentText.includes(kw)))
      : kws.some(kw => String(kw).length >= 2 && recentText.includes(kw));
    if (hit) matched.push(e);
  }
  matched.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  let tokens = 0;
  const result = [];
  for (const e of matched.filter(x => x.constant)) {
    result.push(e); tokens += Math.ceil(String(e.content || '').length * 0.67);
  }
  for (const e of matched.filter(x => !x.constant)) {
    const t = Math.ceil(String(e.content || '').length * 0.67);
    if (tokens + t > budget) break;
    tokens += t; result.push(e);
  }
  return { entries: result, totalTokens: tokens, budget, matched: matched.length };
}
function saveGraph() { try { backupConfig(GRAPH_FILE); writeFileAtomicSync(GRAPH_FILE, JSON.stringify(State.graphData, null, 2), 'utf8'); } catch (e) { console.error('保存关系图谱失败:', e.message); } }
function savePersonas() { try { backupConfig(PERSONAS_FILE); writeFileAtomicSync(PERSONAS_FILE, JSON.stringify({ personas: State.personas, active: State.activePersona }, null, 2), 'utf8'); } catch (e) { console.error('保存玩家身份失败:', e.message); } }
function loadPersonas() { try { const r = JSON.parse(fs.readFileSync(PERSONAS_FILE, 'utf8')); State.personas = r.personas || {}; State.activePersona = r.active || ''; } catch (e) { State.personas = {}; State.activePersona = ''; } }
const PERSONAS_FILE = path.join(DATA_DIR, 'personas.json');
const LOREBOOK_FILE = path.join(DATA_DIR, 'lorebook.json');
const GRAPH_FILE = path.join(DATA_DIR, 'graph.json');

module.exports = { resolveWorldbookDir, saveLorebook, scanLorebook, WORLDBOOKS_DIR, saveWorldbook, activeBookIds, offBookIds, scanWorldbooks, saveGraph, savePersonas, loadPersonas, PERSONAS_FILE, LOREBOOK_FILE, GRAPH_FILE };
