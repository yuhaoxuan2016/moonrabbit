// lib/core/paths.js —— 项目路径常量。
// WWW＝入口文件所在目录：本模块在 lib/core/ 下，故上溯两级（等价于入口文件里的 __dirname）。
const path = require('path');

const WWW = path.resolve(__dirname, '..', '..');
// ---------- 回合记账数据层（按会话隔离） ----------
const DATA_DIR = path.join(WWW, 'data');
const TURNS_DIR = path.join(DATA_DIR, 'turns');

module.exports = { WWW, DATA_DIR, TURNS_DIR };
