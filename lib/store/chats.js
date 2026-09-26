// lib/store/chats.js —— 会话文件路径（id 一律经消毒，防路径穿越）。
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../core/paths');
const { sanitizeId } = require('../tools/misc');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });

// 会话文件路径：id 一律经 sanitizeId 消毒（2026-09-03 安全修复 C-1：防路径穿越，源头加固避免调用方漏用）
function chatFilePath(id) { return path.join(CHATS_DIR, `${sanitizeId(id)}.json`); }
module.exports = { CHATS_DIR, chatFilePath };
