// lib/prompt/pause-check.js —— 暂停场景「输出告警」检测
// 只做告警：生成完成后扫正文/event 的离场表述，命中则 SSE 通知前端打标；不改写、不阻断。
'use strict';
const { noteText } = require('../store/opstate');

const PAUSE_RE = /【暂停场景(?:·严格)?】/;
const LEAVE_RE = /(离开|回去|回家|回吧|走吧|走向门口|朝门口|出门|动身|返程|回程|收尾|准备走)/;

/** 返回 null=通过；命中返回 { reason, location } */
function checkPauseViolation(chatId, content) {
  try {
    if (!PAUSE_RE.test(noteText(chatId || ''))) return null;
    const text = String(content || '');
    if (!text) return null;
    const evM = /<(?:storyevent|horaeevent)>([\s\S]*?)<\/(?:storyevent|horaeevent)>/i.exec(text);
    const tagPart = evM ? evM[1] : '';
    const body = evM ? text.replace(evM[0], '') : text;
    const eventM = /(?:^|[;；\n])\s*(?:event|事件)\s*[:：]\s*([^;；\n]+)/.exec(tagPart);
    const eventTxt = eventM ? eventM[1] : '';
    const locM = /(?:^|[;；\n])\s*(?:location|地点|场景)\s*[:：]\s*([^;；\n]+)/.exec(tagPart);
    const hit = LEAVE_RE.exec(body) || (eventTxt ? LEAVE_RE.exec(eventTxt) : null);
    if (!hit) return null;
    return { reason: '离场表述「' + hit[1] + '」', location: locM ? locM[1].trim() : '' };
  } catch (e) { return null; }
}

module.exports = { checkPauseViolation };
