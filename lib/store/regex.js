// lib/store/regex.js —— M-08·regex 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const path = require('path');
const { writeFileAtomicSync, backupConfig } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');

const REGEX_RULES_FILE = path.join(DATA_DIR, 'regex-rules.json');
function saveRegexRules() { try { backupConfig(REGEX_RULES_FILE); writeFileAtomicSync(REGEX_RULES_FILE, JSON.stringify({ rules: State.regexRules, version: 1 }, null, 2), 'utf8'); } catch (e) { console.error('保存正则规则失败:', e.message); } }

module.exports = { REGEX_RULES_FILE, saveRegexRules };
