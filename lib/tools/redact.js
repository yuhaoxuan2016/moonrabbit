// lib/tools/redact.js —— M-08·redact 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/paths');

const NAME_REDACT_FILE = path.join(DATA_DIR, 'name-redact.json');
let _redactCache = { mtime: 0, rules: null };
function loadNameRedact() {
  try {
    if (!fs.existsSync(NAME_REDACT_FILE)) { _redactCache = { mtime: 0, rules: null }; return null; }
    const mt = fs.statSync(NAME_REDACT_FILE).mtimeMs;
    if (mt === _redactCache.mtime) return _redactCache.rules;
    const cfg = JSON.parse(fs.readFileSync(NAME_REDACT_FILE, 'utf8'));
    let rules = null;
    if (cfg && cfg.enabled === true && cfg.map && typeof cfg.map === 'object') {
      // 长键优先，避免 '原名A' 先替换掉 '原名A·全名' 的前缀
      const list = Object.entries(cfg.map)
        .filter(([k, v]) => k && typeof v === 'string')
        .sort((a, b) => b[0].length - a[0].length);
      if (list.length) rules = list;
    }
    _redactCache = { mtime: mt, rules };
    return rules;
  } catch (e) { console.error('[name-redact] 配置读取失败，按不替换处理:', e.message); return null; }
}

module.exports = { NAME_REDACT_FILE, _redactCache, loadNameRedact };
