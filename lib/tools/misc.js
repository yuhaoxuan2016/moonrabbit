// lib/tools/misc.js —— 标识/文件名消毒、端点校验、回合文件名与分词。
// 依赖方向：本模块只向下依赖 core/paths（取 TURNS_DIR）。
const path = require('path');
const { TURNS_DIR } = require('../core/paths');

function sanitizeId(id) { return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'default'; }
// ---------- 上游端点校验（2026-09-03 安全修复 C-2：防 SSRF + API Key 外发） ----------
// 背景：baseURL 原本只 trim，任意地址都会被「带着 Key 探测 + 落盘」→ 内网探测与凭证外泄。
// 策略：仅允许 http/https；拒绝本机/内网/云元数据地址。本版无本地检索服务，故不设本地白名单。
function assertSafeEndpoint(raw) {
  const s = String(raw || '').trim();
  let u;
  try { u = new URL(s); } catch (e) { const err = new Error('端点地址格式非法：' + s.slice(0, 80)); err.statusCode = 400; throw err; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const err = new Error('仅支持 http/https 端点，收到：' + u.protocol); err.statusCode = 400; throw err;
  }
  const host0 = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  /* E-4 修复（2026-09-05）：IPv4-mapped IPv6 字面量（http://[::ffff:169.254.169.254]/）的
     hostname 是 ::ffff:a9fe:a9fe，不命中 IPv4 黑名单 → 纵深防御被击穿。还原为 IPv4 再过名单。 */
  let host = host0;
  const v4map = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host0);
  const hexMap = !v4map ? /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host0) : null;
  if (v4map) host = v4map[1];
  else if (hexMap) {
    const hi = parseInt(hexMap[1], 16), lo = parseInt(hexMap[2], 16);
    host = [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255].join('.');
  }
  const blocked = [
    /^localhost$/, /^127\./, /^0\.0\.0\.0$/, /^::1$/, /^fe80:/i, /^f[cd][0-9a-f]{2}:/i,
    /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./,
    /\.local$/, /\.internal$/,
  ];
  /* E-3 修复（2026-09-05）：内置「本地 Ollama」档案（localhost:11434）被自家防护拦死，
     切档静默半成功。显式放行回环地址的 11434 端口（Ollama 默认端口）；其余本机/内网照旧拒绝。 */
  if (u.port === '11434' && /^(localhost|127\.[0-9.]*|0\.0\.0\.0|::1|\[::1\])$/.test(host0)) {
    return u.origin + u.pathname.replace(/\/+$/, '');
  }
  if (blocked.some((re) => re.test(host))) {
    const err = new Error('拒绝内网/本机端点（防 SSRF 与凭证外发）：' + host); err.statusCode = 400; throw err;
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}
// 文件名单消毒：剥离路径分隔符与穿越字符（允许中文等 UTF-8 字符，仅禁止路径穿越），防目录穿越
function sanitizeFileName(name, maxLen = 80) {
  return String(name || '')
    .replace(/[\\/]/g, '_')        // 分隔符 → 下划线
    .replace(/\.\.+/g, '_')         // `..`/`...` 穿越 → 下划线
    .replace(/[\x00-\x1f]/g, '')     // 控制字符
    .replace(/[:*?"<>|]/g, '_')      // Windows 文件系统不允许的字符
    .trim().slice(0, maxLen);
}
function turnsFile(chatId) { return path.join(TURNS_DIR, `${sanitizeId(chatId)}.jsonl`); }
// 分词器（语义回忆用）：中英文分词 + 小写化 + 停用词过滤
function tokenize(text) {
  const STOP_WORDS = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '不', '就', '也', '都', '和', '与', '及', '或', '但', '而', '把', '被', '让', '给', '对', '从', '到', '会', '能', '可以', '要', '想', '说', 'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'my', 'your', 'our', 'i', 'you', 'we', 'me', 'us', 'this', 'that', 'these', 'those', 'and', 'or', 'but', 'if', 'then', 'so', 'for', 'of', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'into', 'about', 'like', 'through', 'after', 'before', 'between', 'without', 'not', 'no', 'very', 'too', 'just', 'also', 'more', 'most', 'other', 'some', 'any', 'all', 'each', 'every', 'both', 'few', 'same', 'own', 'than', 'up', 'out', 'off', 'over', 'again', 'here', 'there', 'when', 'where', 'why', 'how', 'what', 'which', 'who', 'whom']);
  return String(text || '')
    .toLowerCase()
    .replace(/[\u4e00-\u9fff]/g, m => ' ' + m + ' ')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}
module.exports = { sanitizeId, assertSafeEndpoint, sanitizeFileName, turnsFile, tokenize };
