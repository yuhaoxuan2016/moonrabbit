// lib/prompt/vars.js —— M-08·prompt-vars 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const { State } = require('../core/state');
const { sanitizeId } = require('../tools/misc');

function applyVariables(text, context) {
  const now = new Date();
  return String(text || '')
    .replace(/\{\{user\}\}/g, context.user || '')
    .replace(/\{\{char\}\}/g, context.char || '')
    .replace(/\{\{time\}\}/g, now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))
    .replace(/\{\{date\}\}/g, now.toISOString().slice(0, 10))
    .replace(/\{\{chatId\}\}/g, context.chatId || '')
    .replace(/\{\{turnCount\}\}/g, String(context.turnCount || 0))
    .replace(/\{\{lastMessage\}\}/g, (context.lastMessage || '').slice(0, 100));
}
function toolsEnabled(chatId) { return (State.opState.tools && State.opState.tools[sanitizeId(chatId)]) || []; }

module.exports = { applyVariables, toolsEnabled };
