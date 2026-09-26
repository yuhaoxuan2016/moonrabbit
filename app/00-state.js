// app/00-state.js —— 全局状态与常量（按序加载的第一个模块）
// F-01 自 app.js 整体搬迁，零逻辑改动。
'use strict';

const els = {
  messages: document.getElementById('messages'),
  typing: document.getElementById('typing'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  expandBtn: document.getElementById('expand-btn'),
  opNote: document.getElementById('op-note'),
  toolChips: Array.from(document.querySelectorAll('.tool-chip[data-tool]')),
  manAttachBtn: document.getElementById('man-attach-btn'),
  manAttachBox: document.getElementById('man-attach-box'),
  manAttachInput: document.getElementById('man-attach-input'),
  manAttachOk: document.getElementById('man-attach-ok'),
  manAttachCancel: document.getElementById('man-attach-cancel'),
  manAttachNote: document.getElementById('man-attach-note'),
  noteAttachBtn: document.getElementById('note-attach-btn'),
  noteAttachBox: document.getElementById('note-attach-box'),
  noteAttachInput: document.getElementById('note-attach-input'),
  noteAttachOk: document.getElementById('note-attach-ok'),
  noteAttachCancel: document.getElementById('note-attach-cancel'),
  noteAttachNote: document.getElementById('note-attach-note'),
};


// ===== 前端状态收口 =====
const App = {};  // 原 let 全局变量统一收口，详见 AGENTS.md 变更日志
App.pendingContext = '';   // 手动附加资料 → 下一条消息附带（不进对话历史）

// 通用模式：不注入任何内置设定，世界设定由用户自填
const GENERIC = true;
const WORLD_KEY = 'genericWorldSetting';
const CHARS_KEY = 'genericCharsSetting';
const RULES_KEY = 'genericRulesSetting';
const worldInput = document.getElementById('world-setting');
const charsInput = document.getElementById('chars-setting');
const rulesInput = document.getElementById('rules-setting');
const worldNote = document.getElementById('world-note');
