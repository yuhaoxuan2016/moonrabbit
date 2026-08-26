// app.js —— Moonrabbit 前端逻辑（多角色 RP / 互动小说界面）
'use strict';

// 移除 U+FFFD（乱码替换符）与孤立代理项：防止流式拼接时把偶发乱码字节存成「方块」
function sanitizeText(s) {
  return String(s ?? '')
    .replace(/\uFFFD+/g, '')
    .replace(/[\u200B\u200C\u2060\uFEFF]/g, '')
    .replace(/[\uD800-\uDFFF]/g, (m, i, str) => {
      const c = m.charCodeAt(0);
      if (c >= 0xD800 && c <= 0xDBFF) return /[\uDC00-\uDFFF]/.test(str[i + 1] || '') ? m : '';
      return /[\uD800-\uDBFF]/.test(str[i - 1] || '') ? m : '';
    });
}

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

// 通用模式：不注入任何预设真值源，世界设定由用户自填
const GENERIC = true;
const WORLD_KEY = 'genericWorldSetting';
const CHARS_KEY = 'genericCharsSetting';
const RULES_KEY = 'genericRulesSetting';
const worldInput = document.getElementById('world-setting');
const charsInput = document.getElementById('chars-setting');
const rulesInput = document.getElementById('rules-setting');
const worldNote = document.getElementById('world-note');
{
  const title = document.querySelector('.subtitle');
  if (title) title.textContent = '通用 RP 界面 · 设定自填';
  els.input.placeholder = '开始输入你的剧情……';
  // 三个设定区分别持久化（世界设定 / 角色卡 / 规则）
  const setters = [
    [worldInput, WORLD_KEY],
    [charsInput, CHARS_KEY],
    [rulesInput, RULES_KEY],
  ];
  for (const [input, key] of setters) {
    try { input.value = localStorage.getItem(key) || ''; } catch (e) { /* ignore */ }
    let saveTimer = null;
    input.addEventListener('input', () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try {
          localStorage.setItem(key, input.value);
          worldNote.classList.remove('hidden');
          setTimeout(() => worldNote.classList.add('hidden'), 1500);
        } catch (e) { /* ignore */ }
      }, 600);
    });
  }
}
// 组装三段设定文本（供发送时注入 system）
function collectSettings() {
  const world = (worldInput.value || '').trim();
  const chars = (charsInput.value || '').trim();
  const rules = (rulesInput.value || '').trim();
  return { world, chars, rules };
}

// 角色配色：任意角色名按哈希取色（稳定、无需名单）
const CHAR_PALETTE = ['#a78bfa', '#f87171', '#60a5fa', '#f5c97b', '#f9a8d4', '#7fe0a9', '#fb923c', '#c084fc', '#67e8f9', '#5eead4', '#f0abfc', '#fda4af', '#fde68a', '#818cf8', '#d1d5db', '#fbbf24'];
function nameColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return CHAR_PALETTE[h % CHAR_PALETTE.length];
}

App.history = [];          // [{role, content, seq}]
App.msgSeq = 0;            // 消息序号（重roll/删除定位用）
App.streaming = false;

// ---------- 渲染 ----------
// 无立绘：一律首字徽章（通用版无任何角色图片素材）
function avatarHtml(name) {
  const ch = String(name || '?').slice(0, 1).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<span class="avatar-badge" style="background:${nameColor(name)}">${ch}</span>`;
}

function parseSegments(text) {
  const segs = [];
  let cur = null;
  const lines = text.split('\n');
  const push = () => { if (cur && cur.text.trim()) segs.push(cur); cur = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m1 = /^([\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z][\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z·]{0,10})[：:]\s*(.*)$/.exec(line);
    const m2 = /^([\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z][\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z·]{0,10})[（(](.+)[）)]$/.exec(line);
    if (m1) {
      push();
      segs.push({ char: m1[1], text: m1[2], actionOnly: false });
    } else if (m2) {
      push();
      segs.push({ char: m2[1], text: m2[2], actionOnly: true });
    } else {
      if (!cur) { cur = { char: null, text: '' }; }
      cur.text += (cur.text ? '\n' : '') + line;
    }
  }
  push();
  return segs.filter((s) => s.text.trim());
}

// XSS 防护：转义 HTML 特殊字符（含引号，可安全用于属性上下文）
function safeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeHtml(s) {
  return safeHtml(s);
}

function highlightText(text) {
  return escapeHtml(text);
}

// Markdown 渲染：图片 → 代码块 / 行内代码 / 引用 / 无序列表
// 图片（Task17）先占位保护：base64 data URL 含 / + = 等字符，转义会破坏 img 标签，故最后还原
function renderMarkdown(text) {
  const images = [];
  let s = String(text || '').replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, src) => {
    images.push(`<img src="${String(src).replace(/"/g, '%22')}" alt="${String(alt).replace(/"/g, '&quot;')}" loading="lazy" onclick="window.open(this.src,'_blank')" title="点击查看原图">`);
    return `\u0005${images.length - 1}\u0006`;
  });
  s = escapeHtml(s);
  // 1) 代码块 ```...``` → <pre><code>（先占位保护，避免后续规则命中块内内容）
  const codeBlocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => {
    codeBlocks.push(`<pre><code>${code.trim()}</code></pre>`);
    return `\u0003${codeBlocks.length - 1}\u0004`;
  });
  // 2) 行内代码 `...` → <code>...</code>
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // 3) 引用 > text → <blockquote>；无序列表 - text → <ul><li>（转义后 > 为 &gt;）
  s = s.split('\n').map((line) => {
    const bq = /^&gt;\s?(.*)$/.exec(line);
    if (bq) return `<blockquote>${bq[1]}</blockquote>`;
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) return `<ul><li>${ul[1]}</li></ul>`;
    return line;
  }).join('\n');
  // 4) 还原代码块
  s = s.replace(/\u0003(\d+)\u0004/g, (m, i) => codeBlocks[Number(i)]);
  // 5) 还原图片
  s = s.replace(/\u0005(\d+)\u0006/g, (m, i) => images[Number(i)]);
  return s;
}

// ---------- 消息容器与操作（重roll / 删除） ----------
const rerollVersions = {};   // 版本历史：{ 锚点userSeq: [ {content, ts}, ... ] }（旧→新累积，支持多次重roll 回溯）
function makeWrap(role, seq) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap';
  wrap.dataset.seq = seq;
  const bar = document.createElement('div');
  bar.className = 'msg-actions';
  if (seq !== undefined && seq !== null) {
    if (role === 'assistant') {
      const rb = document.createElement('button');
      rb.className = 'ma-btn';
      rb.textContent = '↻';
      rb.title = '重roll：重写该回复（其后的消息一并截断）';
      rb.addEventListener('click', () => reroll(seq));
      bar.appendChild(rb);
      // 朗读该条消息（单条收听）
      const ttsBtn = document.createElement('button');
      ttsBtn.className = 'ma-btn';
      ttsBtn.textContent = '🔊';
      ttsBtn.title = '朗读该条回复';
      ttsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = (wrap.querySelector('.bubble')?.textContent || '').trim();
        if (!t) { alert('该消息无文本可朗读'); return; }
        openTts(t);
      });
      bar.appendChild(ttsBtn);
      // 用该条消息生成场景插图（预填场景描述）
      const illBtn = document.createElement('button');
      illBtn.className = 'ma-btn';
      illBtn.textContent = '🎨';
      illBtn.title = '用该条回复生成场景插图';
      illBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const t = (wrap.querySelector('.bubble')?.textContent || '').trim();
        if (!t) { alert('该消息无文本可配图'); return; }
        openIllustration(t.slice(0, 300));
      });
      bar.appendChild(illBtn);
    }
    const eb = document.createElement('button');
    eb.className = 'ma-btn';
    eb.textContent = '✏️';
    eb.title = '编辑该消息内容';
    eb.addEventListener('click', () => editMsg(seq));
    bar.appendChild(eb);
    const tb = document.createElement('button');
    tb.className = 'ma-btn del';
    tb.textContent = '✂️';
    tb.title = '截断：删除该消息及其后所有消息（把剧情拉回正轨）';
    tb.addEventListener('click', () => truncateTo(seq));
    bar.appendChild(tb);
    const db = document.createElement('button');
    db.className = 'ma-btn del';
    db.textContent = '✕';
    db.title = '删除该消息';
    db.addEventListener('click', () => deleteMsg(seq));
    bar.appendChild(db);
  }
  wrap.appendChild(bar);
  els.messages.appendChild(wrap);
  return wrap;
}

function reroll(seq) {
  if (App.streaming) return;
  const idx = App.history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  // 记录旧版进版本链（锚点 = 该回复之前最近一条 user 消息的 seq；多次重roll 累积）
  const oldMsg = App.history[idx];
  let anchorSeq = seq;
  for (let i = idx - 1; i >= 0; i--) { if (App.history[i].role === 'user') { anchorSeq = App.history[i].seq; break; } }
  if (oldMsg && oldMsg.role === 'assistant') {
    (rerollVersions[anchorSeq] = rerollVersions[anchorSeq] || []).push({ content: oldMsg.content, ts: Date.now() });
  }
  App.history = App.history.slice(0, idx);          // 截断：该条及其后全部作废（旧文本不进 AI 上下文）
  // 同步清理回合记录：删除 seq >= n 的记账（旧回复的账本不残留）
  fetch('/api/timeline/truncate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: App.chatId, seq, mode: 'gte' }),
  }).catch(() => {});
  // 旧气泡保留为「旧版本」样式（仅对比用，可删除/可恢复；不参与后续上下文）
  const wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  if (wrap) {
    let node = wrap.nextSibling;
    while (node) { const next = node.nextSibling; node.remove(); node = next; }   // 其后气泡删除
    wrap.classList.add('alt-version');
    const bar = wrap.querySelector('.msg-actions');
    if (bar) {
      bar.innerHTML = '';
      const tag = document.createElement('span');
      tag.className = 'alt-tag';
      tag.textContent = '旧版本';
      tag.title = '重roll 前的回复（不进上下文，仅对比/可恢复）';
      bar.appendChild(tag);
      const verIdx = (rerollVersions[anchorSeq] || []).length - 1;   // 本版本在链中的下标
      const rst = document.createElement('button');
      rst.className = 'ma-btn';
      rst.textContent = '↩ 恢复此版';
      rst.title = '放弃新回复，恢复这一版（可再切回其它版本）';
      rst.addEventListener('click', () => restoreVersion(anchorSeq, verIdx, seq));
      bar.appendChild(rst);
      const del = document.createElement('button');
      del.className = 'ma-btn del';
      del.textContent = '✕ 删旧版';
      del.title = '删除旧版本（仅移除对比气泡，不影响对话）';
      del.addEventListener('click', () => { wrap.remove(); });
      bar.appendChild(del);
    }
  }
  generate();
}

// 恢复旧版本：移除当前最新 assistant 回复 → 旧版文本放回原位 → 旧气泡恢复为正常样式
function restoreVersion(anchorSeq, verIdx, oldSeq) {
  if (App.streaming) return;
  const versions = rerollVersions[anchorSeq];
  if (!versions || !versions[verIdx]) return;
  const content = versions[verIdx].content;
  // 1) 从 history 移除锚点之后的所有消息（当前链）
  const anchorIdx = App.history.findIndex((m) => m.seq === anchorSeq);
  if (anchorIdx < 0) return;
  App.history = App.history.slice(0, anchorIdx + 1);
  // 1.5) 清理锚点后的回合记录（重roll 后新回复的账本不残留）
  fetch('/api/timeline/truncate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: App.chatId, seq: anchorSeq + 1, mode: 'gte' }),
  }).catch(() => {});
  // 2) 旧版放回原位（新 seq，避免与已存消息冲突）
  const newSeq = ++App.msgSeq;
  App.history.push({ role: 'assistant', content, seq: newSeq });
  saveChat();
  // 3) DOM：删除旧版本气泡（本版转正），并移除其后所有气泡
  const oldWrap = els.messages.querySelector(`.msg-wrap[data-seq="${oldSeq}"]`);
  if (oldWrap) {
    oldWrap.classList.remove('alt-version');
    const bar = oldWrap.querySelector('.msg-actions');
    if (bar) {
      bar.innerHTML = '';
      const rb = document.createElement('button');
      rb.className = 'ma-btn';
      rb.textContent = '↻';
      rb.title = '重roll：重写该回复（其后的消息一并截断）';
      rb.addEventListener('click', () => reroll(newSeq));
      bar.appendChild(rb);
      const db = document.createElement('button');
      db.className = 'ma-btn del';
      db.textContent = '✕';
      db.title = '删除该消息';
      db.addEventListener('click', () => deleteMsg(newSeq));
      bar.appendChild(db);
    }
    let node = oldWrap.nextSibling;
    while (node) { const next = node.nextSibling; node.remove(); node = next; }
    // 重建气泡内容（显示旧版文本；走 renderMarkdown 以支持图片渲染）
    const bub = oldWrap.querySelector('.bubble');
    if (bub) { bub.innerHTML = renderMarkdown(stripTurnTags(content)); }
  }
  // 4) 其余旧版本气泡保留（可再切回）
}

function deleteMsg(seq) {
  if (App.streaming) return;
  const idx = App.history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  const removed = App.history[idx];
  App.history.splice(idx, 1);
  // 删除的是 AI 回复 → 同步清理其回合记录（eq 只删该条）
  if (removed && removed.role === 'assistant') {
    fetch('/api/timeline/truncate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, seq, mode: 'eq' }),
    }).catch(() => {});
  }
  const wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  if (wrap) wrap.remove();
  saveChat();
}

// ---------- 对话编辑（✏️ 编辑消息 / ✂️ 截断至此） ----------
function editMsg(seq) {
  if (App.streaming) return;
  const idx = App.history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  const wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  if (!wrap) return;
  if (wrap.querySelector('.edit-box')) return;   // 已在编辑中
  const ta = document.createElement('textarea');
  ta.className = 'edit-box';
  ta.value = stripTurnTags(App.history[idx].content);
  const btnRow = document.createElement('div');
  btnRow.className = 'edit-actions';
  const ok = document.createElement('button');
  ok.className = 'ma-btn';
  ok.textContent = '保存';
  ok.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) return;
    App.history[idx].content = text;
    saveChat();
    rebuildMsgWrap(wrap, App.history[idx].role, text, seq);
  });
  const cancel = document.createElement('button');
  cancel.className = 'ma-btn del';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => rebuildMsgWrap(wrap, App.history[idx].role, App.history[idx].content, seq));
  btnRow.appendChild(ok);
  btnRow.appendChild(cancel);
  // 清空操作栏以外内容 → 换成编辑器
  const bar = wrap.querySelector('.msg-actions');
  let node = wrap.firstChild;
  while (node) { const next = node.nextSibling; if (node !== bar) node.remove(); node = next; }
  wrap.appendChild(ta);
  wrap.appendChild(btnRow);
  ta.focus();
}

function truncateTo(seq) {
  if (App.streaming) return;
  const idx = App.history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  if (!confirm(`截断：删除该消息及其后所有消息（${App.history.length} → ${idx} 条）？\n用于把剧情拉回正轨；旧内容在 data 子仓检查点可找回。`)) return;
  App.history = App.history.slice(0, idx);
  fetch('/api/timeline/truncate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: App.chatId, seq, mode: 'gte' }),
  }).catch(() => {});
  const wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  if (wrap) {
    let node = wrap;
    while (node) { const next = node.nextSibling; node.remove(); node = next; }
  }
  saveChat();
}

// 重建单个消息气泡（编辑保存/取消后，结构简化为单段）
function rebuildMsgWrap(wrap, role, content, seq) {
  const bar = wrap.querySelector('.msg-actions');
  let node = wrap.firstChild;
  while (node) { const next = node.nextSibling; if (node !== bar) node.remove(); node = next; }
  const row = document.createElement('div');
  const body = document.createElement('div');
  body.style.flex = '1';
  const bub = document.createElement('div');
  bub.className = 'bubble';
  bub.innerHTML = renderMarkdown(content);
  body.appendChild(bub);
  if (role === 'user') {
    row.className = 'msg user';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.borderColor = '#60a5fa';
    av.innerHTML = avatarHtml('你');
    const nm = document.createElement('div');
    nm.className = 'char-name';
    nm.textContent = '你';
    body.insertBefore(nm, bub);
    row.appendChild(av);
  } else {
    row.className = 'msg narrator';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.textContent = '旁';
    row.appendChild(av);
  }
  row.appendChild(body);
  wrap.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;
}

// 记账标签剥离（仅显示层）：<storyevent>/<items>/【更新】不显示在气泡里；原文仍在 history/存档中
function stripTurnTags(text) {
  let result = String(text || '')
    .replace(/<(?:storyevent|horaeevent)>[\s\S]*?<\/(?:storyevent|horaeevent)>/gi, '')
    .replace(/<(?:items|horae)>[\s\S]*?<\/(?:items|horae)>/gi, '')
    .replace(/^【更新】[^\n]*$/gm, '');
  for (const rule of App.regexRulesCache) { if (!rule.enabled) continue; try { result = result.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replacement || ''); } catch (e) { /* 跳过 */ } }
  return result;
}
App.regexRulesCache = [];
async function loadRegexRules() { try { const r = await fetch('/api/regex-rules'); const d = await r.json(); if (d.ok) App.regexRulesCache = d.rules || []; } catch (e) { /* 忽略 */ } }
loadRegexRules();

function renderAssistant(content, seq) {
  const wrap = makeWrap('assistant', seq);
  const segs = parseSegments(stripTurnTags(content));
  for (const seg of segs) {
    const row = document.createElement('div');
    row.className = 'msg' + (seg.char ? '' : ' narrator');
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.borderColor = seg.char ? nameColor(seg.char) : '';
    if (seg.char) av.innerHTML = avatarHtml(seg.char);
    else av.textContent = '旁';
    const body = document.createElement('div');
    body.style.flex = '1';
    if (seg.char) {
      const nm = document.createElement('div');
      nm.className = 'char-name';
      nm.style.color = nameColor(seg.char);
      nm.textContent = seg.char;
      body.appendChild(nm);
    }
    const bub = document.createElement('div');
    bub.className = 'bubble';
    const contentNode = document.createElement('span');
    contentNode.innerHTML = renderMarkdown(seg.text.trim());
    if (seg.actionOnly) { contentNode.className = 'action'; contentNode.innerHTML = `（${renderMarkdown(seg.text.trim())}）`; }
    bub.appendChild(contentNode);
    body.appendChild(bub);
    row.appendChild(av);
    row.appendChild(body);
    wrap.appendChild(row);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap;
}

function renderUser(content, seq) {
  const wrap = makeWrap('user', seq);
  const row = document.createElement('div');
  row.className = 'msg user';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.style.borderColor = '#60a5fa';
  av.innerHTML = avatarHtml('你');
  const body = document.createElement('div');
  body.style.flex = '1';
  const nm = document.createElement('div');
  nm.className = 'char-name';
  nm.textContent = '你';
  body.appendChild(nm);
  const bub = document.createElement('div');
  bub.className = 'bubble';
  bub.innerHTML = renderMarkdown(content);
  body.appendChild(bub);
  row.appendChild(av);
  row.appendChild(body);
  wrap.appendChild(row);
  els.messages.scrollTop = els.messages.scrollHeight;
  return wrap;
}

// ---------- 流式对话 ----------
async function send() {
  const content = els.input.value.trim();
  if (!content || App.streaming) return;
  // 发送即取消自动保存防抖（防 3s 后以发送前旧快照 PUT 覆盖新数据）
  clearTimeout(App.autoSaveTimer);
  // 高峰时段强提醒：官方直连渠道 + 高峰时间 + 发送前确认（可设置关闭）
  if (App.peakEligible && App.prefs.peakConfirm !== false && isPeakHours(new Date())) {
    if (!confirm('⚠️ 当前为工作日高峰时段（9:00-12:00 / 14:00-18:00）\nAPI 费率较高、可能限流变卡；周末全天为低谷价。\n\n继续发送吗？')) {
      return;
    }
  }
  els.input.value = '';
  const seq = ++App.msgSeq;
  renderUser(content, seq);
  App.history.push({ role: 'user', content, seq });
  saveChat();
  await generate();
}

async function generate() {
  App.streaming = true;
  els.send.disabled = true;
  els.typing.classList.remove('hidden');
  const extra = App.pendingContext;
  App.pendingContext = '';
  els.manAttachNote.classList.add('hidden');
  const seq = ++App.msgSeq;

  let acc = '';
  let thinkAcc = '';
  const tempWrap = makeWrap('assistant', seq);
  const tempRow = document.createElement('div');
  tempRow.className = 'msg narrator';
  tempRow.innerHTML = '<div class="avatar">…</div><div class="bubble"></div>';
  tempWrap.appendChild(tempRow);
  const tempBub = tempRow.querySelector('.bubble');

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: App.history,
        chatId: App.chatId,
        seq,                       // 当前消息序号（回合记录关联，重roll/删除时清理用）
        worldSetting: collectSettings().world,
        charsSetting: collectSettings().chars,
        rulesSetting: collectSettings().rules,
        extra,                     // 手动附加资料（临时注入 system，不进对话历史）
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err.slice(0, 300));
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        let ev;
        try { ev = JSON.parse(data); } catch (e) { continue; }
        if (ev.type === 'delta') {
          acc += sanitizeText(ev.text);
          tempBub.textContent = stripTurnTags(acc);
          els.messages.scrollTop = els.messages.scrollHeight;
        } else if (ev.type === 'thinking') {
          thinkAcc += sanitizeText(ev.text);
        } else if (ev.type === 'tools') {
          renderThinking(`🔧 ${(ev.trace || []).join('；')}`);
        } else if (ev.type === 'summarized') {
          renderThinking(`💾 ${ev.note}`);
        } else if (ev.type === 'ping') {
          // SSE 心跳（Task8）：仅保活连接，无需处理
        } else if (ev.type === 'error') {
          throw new Error(ev.error || 'LLM 错误');
        } else if (ev.type === 'done') {
          break;
        }
      }
    }
    tempWrap.remove();
    if (thinkAcc.trim() && App.prefs.showThinking !== false) {
      renderThinking(thinkAcc.trim());
    }
    if (acc.trim()) {
      renderAssistant(acc.trim(), seq);
      // 思考记录一并存进 history（刷新/切会话后恢复显示）
      App.history.push({ role: 'assistant', content: acc.trim(), seq, thinking: thinkAcc.trim() || undefined });
    }
  } catch (e) {
    tempWrap.remove();
    renderAssistant(`（叙事者提示：${e.message}）`, seq);
  } finally {
    App.streaming = false;
    els.send.disabled = false;
    els.typing.classList.add('hidden');
    els.input.focus();
    saveChat();       // 会话自动保存（归档）
    loadTimeline();   // 剧情记忆：刷新时间线/物品栏/换装/情绪/地点（AI 回答后全量刷新）
    loadInventory();
    loadCurrentWardrobe();
    loadEmotions();
    loadLocationsUI();
    loadStats();      // 会话统计
  }
}

// 思考链折叠块
function renderThinking(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap';
  const row = document.createElement('div');
  row.className = 'msg narrator';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = '💭';
  const body = document.createElement('div');
  body.style.flex = '1';
  const det = document.createElement('details');
  det.className = 'thinking';
  const sum = document.createElement('summary');
  sum.textContent = '💭 思考过程';
  const content = document.createElement('div');
  content.textContent = text;
  det.appendChild(sum);
  det.appendChild(content);
  body.appendChild(det);
  row.appendChild(av);
  row.appendChild(body);
  wrap.appendChild(row);
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
}

// ---------- 会话管理（新对话 / 归档 / 恢复） ----------
const CUR_CHAT_KEY = 'currentChatId';
App.chatId = null;
App.currentChatProfileId = 'main';   // 当前会话绑定的配置档（按对话过滤显示用）
App.chatTitle = '';

async function saveChat() {
  if (!App.chatId) return;
  const firstUser = App.history.find((m) => m.role === 'user');
  const title = App.chatTitle || (firstUser ? firstUser.content.slice(0, 24) : '新对话');
  // 失败自动重试 1 次（500ms 后）；仍失败 → 状态栏提示（不静默丢数据）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch('/api/chats/' + App.chatId, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, messages: App.history }),
      });
      if (r.ok) { App.chatTitle = title; return; }
    } catch (e) { /* 网络异常 → 重试 */ }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 500));
  }
  const sb = document.getElementById('stats-bar');
  if (sb) {
    const old = sb.textContent;
    sb.textContent = '⚠️ 对话保存失败（将重试）';
    setTimeout(() => { if (sb.textContent.includes('保存失败')) sb.textContent = old; }, 4000);
  }
  // 后台再补一次（异步、尽力而为）
  setTimeout(() => {
    fetch('/api/chats/' + App.chatId, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, messages: App.history }),
    }).catch(() => {});
  }, 3000);
}

// ---------- 会话导出（JSON 完整备份 / Markdown 可读版；随手备份） ----------
function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
function exportChat(md) {
  if (!App.chatId || !App.history.length) { alert('当前会话为空，无内容可导出'); return; }
  const firstUser = App.history.find((m) => m.role === 'user');
  const title = App.chatTitle || (firstUser ? firstUser.content.slice(0, 24) : '新对话');
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  if (!md) {
    downloadBlob(`${safeTitle}.json`, JSON.stringify({ id: App.chatId, title, exportedAt: new Date().toISOString(), messages: App.history }, null, 2), 'application/json');
  } else {
    const lines = [`# ${title}`, '', `> 导出时间：${new Date().toLocaleString()}`, ''];
    for (const m of App.history) {
      const who = m.role === 'user' ? '你' : 'AI';
      lines.push(`## ${who}`, '', String(m.content || ''), '');
    }
    downloadBlob(`${safeTitle}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
  }
}
document.getElementById('export-btn').addEventListener('click', () => exportChat(false));
document.getElementById('export-md-btn').addEventListener('click', () => exportChat(true));

// ---------- 会话导入（📥 JSON 完整备份恢复：解析 → 校验 {id,title,messages} → 新建会话写入） ----------
const importFileInput = document.createElement('input');
importFileInput.type = 'file';
importFileInput.accept = '.json,application/json';
importFileInput.style.display = 'none';
document.body.appendChild(importFileInput);
document.getElementById('import-btn').addEventListener('click', () => importFileInput.click());
importFileInput.addEventListener('change', async () => {
  const file = importFileInput.files && importFileInput.files[0];
  importFileInput.value = '';   // 允许连续选择同一文件
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object') throw new Error('文件不是有效的 JSON 对象');
    if (!Array.isArray(data.messages)) throw new Error('缺少 messages 数组（需为导出格式：{id, title, messages}）');
    const messages = data.messages
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
      .map((m) => ({ role: m.role, content: String(m.content || ''), ...(m.thinking ? { thinking: m.thinking } : {}) }));
    if (!messages.length) throw new Error('会话中没有可导入的消息');
    const title = String(data.title || '导入会话').slice(0, 40);
    if (!confirm(`导入会话「${title}」？共 ${messages.length} 条消息（将创建为新的会话）。`)) return;
    // 创建新会话（服务端生成新 id）→ 写入标题与消息 → 打开
    const { id } = await (await fetch('/api/chats', { method: 'POST' })).json();
    const r = await fetch('/api/chats/' + id, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, messages }),
    });
    if (!r.ok) throw new Error('写入失败（HTTP ' + r.status + '）');
    await openChat(id);
  } catch (e) {
    alert('导入失败：' + e.message);
  }
});

// ---------- 存档点（💾 存档 / ↩ 读档，按会话；服务端存 data/savepoints/{chatId}/{ts}.json 完整副本） ----------
document.getElementById('savepoint-btn').addEventListener('click', async () => {
  if (!App.chatId) { alert('还没有会话，无法存档'); return; }
  if (!App.history.length) { alert('当前会话为空，无需存档'); return; }
  await saveChat();   // 先把最新对话落盘，再存副本
  const label = (prompt('存档备注（可留空）：', '') || '').trim().slice(0, 40);
  try {
    const r = await (await fetch('/api/savepoints/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, label }),
    })).json();
    if (!r.ok) throw new Error(r.error || '存档失败');
    alert('✅ ' + r.note);
  } catch (e) { alert('存档失败：' + e.message); }
});
document.getElementById('loadpoint-btn').addEventListener('click', async () => {
  if (!App.chatId) { alert('还没有会话，无法读档'); return; }
  try {
    const { ok, savepoints } = await (await fetch(`/api/savepoints/list?chatId=${encodeURIComponent(App.chatId)}`)).json();
    if (!ok || !savepoints || !savepoints.length) { alert('本会话还没有存档点'); return; }
    const choice = prompt(
      '选择要读取的存档点（输入序号，Enter 取消）：\n\n' +
      savepoints.map((s, i) => `${i + 1}. ${s.label || '（无备注）'} · ${new Date(s.ts).toLocaleString()} · ${s.count} 条消息`).join('\n'),
      '1'
    );
    const idx = Number(choice);
    if (!choice || !Number.isFinite(idx)) return;
    const sp = savepoints[idx - 1];
    if (!sp) { alert('序号无效'); return; }
    if (!confirm(`读取存档点「${sp.label || '（无备注）'}」（${new Date(sp.ts).toLocaleString()}，${sp.count} 条消息）？\n当前会话内容将被存档副本覆盖（可先导出备份）。`)) return;
    const r = await (await fetch('/api/savepoints/load', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, ts: sp.ts }),
    })).json();
    if (!r.ok) throw new Error(r.error || '读档失败');
    // 清空本地状态再重新打开（避免 openChat 先把旧 history 存回覆盖存档）
    const prevHistory = App.history.slice();   // 备份：openChat 失败时恢复，防空 history 覆盖存档
    App.history = [];
    els.messages.innerHTML = '';
    App.msgSeq = 0;
    await openChat(App.chatId);
    if (!App.history.length && prevHistory.length) App.history = prevHistory;   // GET 失败 → 恢复旧状态
  } catch (e) { alert('读档失败：' + e.message); }
});

async function loadChatList() {
  const box = document.getElementById('chat-list');
  try {
    const { chats } = await (await fetch('/api/chats')).json();
    box.innerHTML = '';
    if (!chats.length) { box.textContent = '（暂无历史会话）'; return; }
    for (const c of chats) {
      const d = document.createElement('div');
      d.className = 'chat-item' + (c.id === App.chatId ? ' active' : '');
      const time = (c.updatedAt || '').slice(5, 16).replace('T', ' ');
      const profileDot = c.profileColor ? `<span class="ci-profile-dot" style="background:${c.profileColor}" title="${c.profileLabel||'默认'}"></span>` : '';
      d.innerHTML = `${profileDot}<span class="ci-pin${c.pinned ? ' on' : ''}" title="${c.pinned ? '取消置顶' : '置顶'}">📌</span><span class="ci-title"></span><span class="ci-rename" title="重命名">✏️</span><span class="ci-time">${time}</span><span class="ci-archive" title="归档">📦</span><span class="ci-del" title="删除">×</span>`;
      d.querySelector('.ci-title').textContent = c.title;
      d.querySelector('.ci-title').addEventListener('click', () => openChat(c.id));
      d.querySelector('.ci-pin').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await fetch('/api/chats/' + c.id, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pinned: !c.pinned }),
          });
        } catch (err) { /* 忽略 */ }
        loadChatList();
      });
      d.querySelector('.ci-rename').addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = (prompt('新的会话名称：', c.title) || '').trim().slice(0, 40);
        if (!name || name === c.title) return;
        try {
          const r = await fetch('/api/chats/' + c.id, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: name }),
          });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          if (c.id === App.chatId) App.chatTitle = name;   // 当前会话标题同步，后续 saveChat 沿用
        } catch (err) { alert('重命名失败：' + err.message); }
        loadChatList();
      });
      d.querySelector('.ci-archive').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`归档会话「${c.title}」？\n归档后会话将隐藏，可在侧栏底部「已归档」中恢复。`)) return;
        await fetch('/api/chats/' + c.id, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hidden: true }),
        });
        if (c.id === App.chatId) { App.chatId = null; localStorage.removeItem(CUR_CHAT_KEY); }
        loadChatList();
      });
      d.querySelector('.ci-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除会话「${c.title}」？`)) return;
        await fetch('/api/chats/' + c.id, { method: 'DELETE' });
        if (c.id === App.chatId) { App.chatId = null; localStorage.removeItem(CUR_CHAT_KEY); }
        loadChatList();
      });
      box.appendChild(d);
    }
  } catch (e) { box.textContent = '会话列表读取失败'; }

  // 已归档会话分组（折叠）
  try {
    const { chats: archived } = await (await fetch('/api/chats?archived=true')).json();
    if (archived && archived.length > 0) {
      const section = document.createElement('div');
      section.className = 'archived-section';
      section.innerHTML = `
        <div class="archived-header" style="cursor:pointer;padding:8px 4px;color:var(--muted,#888);font-size:12px;display:flex;align-items:center;gap:4px;border-top:1px solid var(--border,#333);margin-top:8px">
          <span class="archived-arrow" style="transition:transform .2s">▶</span>
          <span>已归档 (${archived.length})</span>
        </div>
        <div class="archived-list" style="display:none;max-height:300px;overflow-y:auto"></div>
      `;
      const header = section.querySelector('.archived-header');
      const list = section.querySelector('.archived-list');
      const arrow = section.querySelector('.archived-arrow');

      header.addEventListener('click', () => {
        const open = list.style.display === 'none';
        list.style.display = open ? 'block' : 'none';
        arrow.style.transform = open ? 'rotate(90deg)' : '';
      });

      for (const c of archived) {
        const d = document.createElement('div');
        d.className = 'chat-item archived';
        d.style.opacity = '0.6';
        const time = (c.updatedAt || '').slice(5, 16).replace('T', ' ');
        d.innerHTML = `<span class="ci-title" style="cursor:pointer"></span><span class="ci-time">${time}</span><span class="ci-restore" title="恢复" style="cursor:pointer;font-size:14px;margin-left:auto">♻️</span>`;
        d.querySelector('.ci-title').textContent = c.title;
        d.querySelector('.ci-restore').addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch('/api/chats/unarchive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: c.id }) });
          loadChatList();
        });
        list.appendChild(d);
      }
      box.appendChild(section);
    }
  } catch (e) { /* 忽略归档加载错误 */ }
}

// ---------- 对话配置档选择器 ----------
App.chatProfilesCache = {};
async function loadChatProfiles() { try { const r = await fetch('/api/chat-profiles'); const d = await r.json(); if (d.ok) App.chatProfilesCache = d.profiles || {}; } catch (e) { /* 忽略 */ } }
function showChatProfilePicker() {
  return new Promise((resolve) => {
    const profiles = App.chatProfilesCache;
    const ids = Object.keys(profiles);
    if (!ids.length) { resolve('main'); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">选择对话配置档</div><div id="cp-list" style="display:flex;flex-direction:column;gap:8px"></div><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="cp-cancel" class="btn-sm" style="padding:6px 16px">取消</button></div></div>`;
    document.body.appendChild(overlay);
    const list = overlay.querySelector('#cp-list');
    // 当前会话的配置档置顶（按对话过滤显示）
    const sortedIds = [App.currentChatProfileId, ...ids.filter(i => i !== App.currentChatProfileId)];
    for (const id of sortedIds) {
      const p = profiles[id];
      if (!p) continue;
      const isCurrent = id === App.currentChatProfileId;
      const btn = document.createElement('button');
      btn.className = 'btn-sm';
      btn.style.cssText = `padding:10px 16px;text-align:left;border-left:4px solid ${p.color||'#639922'};background:var(--bg2,#f5f5f5);border-radius:6px;cursor:pointer;${isCurrent?'border:1px solid var(--accent,#a78bfa);background:var(--bg3,#2a2f45)':''}`;
      btn.innerHTML = `<div style="font-weight:500">${p.label||id}${isCurrent?' <span style="color:var(--accent,#a78bfa);font-size:11px">← 当前会话使用</span>':''}</div>${p.prefix?'<div style="font-size:12px;color:var(--text-secondary,#888);margin-top:2px">'+p.prefix.slice(0,50)+'...</div>':''}`;
      btn.onclick = () => { overlay.remove(); resolve(id); };
      list.appendChild(btn);
    }
    overlay.querySelector('#cp-cancel').onclick = () => { overlay.remove(); resolve(null); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } };
  });
}

async function newChat() {
  if (App.history.length) await saveChat();   // 旧对话自动归档
  App.pendingContext = '';   // 清空上一会话的附加资料
  await loadChatProfiles();
  const profileId = await showChatProfilePicker();
  if (!profileId) return;
  const profile = App.chatProfilesCache[profileId] || {};
  try {
    const { id } = await (await fetch('/api/chats', { method: 'POST' })).json();
    App.chatId = id;
    App.chatTitle = '';
    await fetch('/api/chat-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply', id: profileId, profile: { chatId: id } }) });
    App.currentChatProfileId = profileId;
    localStorage.setItem(CUR_CHAT_KEY, id);
    els.messages.innerHTML = '';
    App.history = [];
    // 通用版无 canonical 目录，firstMsg 模板加载不适用（已移除 /api/file 调用）
    renderAssistant('（新对话开始。在右侧「世界设定」里填写你的世界观/角色/规则（可选），然后直接开始对话。多角色场景按「角色名：台词」分段显示头像。）');
    loadChatList();
    loadChatProfileManage();   // 配置档按会话刷新（新会话标记跟随）
    loadTimeline();   // 剧情记忆按会话隔离，切会话后刷新
    loadInventory();
    loadSessionNote();   // 会话常驻设定按会话加载（新会话为空）
    loadAgendaUI();      // 剧情备忘按会话加载（M8/M10）
    loadReportListUI();  // 报告列表按会话加载（M8/M10）
    loadAnnotationsUI(); // 旁注按会话加载（M8/M10）
    toggleSidebar(false);   // 移动端：新建会话后收起抽屉
  } catch (e) { /* 忽略 */ }
}

async function openChat(id) {
  if (App.history.length) await saveChat();
  App.pendingContext = '';   // 清空上一会话的附加资料
  try {
    const c = await (await fetch('/api/chats/' + id)).json();
    if (c.error) return;
    App.chatId = c.id;
    App.chatTitle = c.title;
    App.currentChatProfileId = c.chatProfile || 'main';
    localStorage.setItem(CUR_CHAT_KEY, id);
    els.messages.innerHTML = '';
    App.history = Array.isArray(c.messages) ? c.messages : [];
    // 恢复旧会话：无 seq 的补发（兼容历史数据）
    for (const m of App.history) {
      if (!m.seq) m.seq = ++App.msgSeq;
      else App.msgSeq = Math.max(App.msgSeq, m.seq);
      if (m.role === 'user') renderUser(m.content, m.seq);
      else if (m.role === 'assistant') {
        // 先渲染思考块（与实时生成顺序一致：思考在回复内容上方）
        if (m.thinking && App.prefs.showThinking !== false) renderThinking(m.thinking);
        renderAssistant(m.content, m.seq);
      }
    }
    loadChatList();
    loadChatProfileManage();   // 配置档按会话刷新（切换对话后「← 当前会话」标记跟随）
    loadTimeline();   // 剧情记忆按会话隔离，切会话后刷新
    loadInventory();
    loadCurrentWardrobe();
    loadSessionNote();   // 会话常驻设定按会话加载
    loadInjections();    // 自定义注入槽按会话刷新（API 弹窗开着时同步显示当前会话值）
    loadStats();   // 统计栏按对话口径刷新（缓存命中）
    loadAgendaUI();      // 剧情备忘按会话加载（M8/M10）
    loadReportListUI();  // 报告列表按会话加载（M8/M10）
    loadAnnotationsUI(); // 旁注按会话加载（M8/M10）
    toggleSidebar(false);   // 移动端：切换会话后收起抽屉
  } catch (e) { /* 忽略 */ }
}

document.getElementById('new-chat-btn').addEventListener('click', newChat);

// ---------- API 设置弹窗（自定义端点） ----------
const apiBtn = document.getElementById('api-btn');
const apiModal = document.getElementById('api-modal');
const apiProtocol = document.getElementById('api-protocol');
const apiBase = document.getElementById('api-base');
const apiKey = document.getElementById('api-key');
const apiNow = document.getElementById('api-now');
const apiMsg = document.getElementById('api-msg');

apiBtn.addEventListener('click', async () => {
  apiMsg.className = 'api-msg';
  apiMsg.textContent = '';
  try {
    const c = await (await fetch('/api/model')).json();
    apiProtocol.value = c.protocol || 'anthropic';
    apiBase.value = c.baseURL || '';
    apiKey.value = '';
    apiKey.placeholder = `留空 = 沿用当前 Key（${c.apiKeyMasked || '未配置'}）`;
    document.getElementById('api-maxtokens').value = c.maxTokens || 8192;
    document.getElementById('api-thinking').value = (c.thinking === 'enabled' ? 'high' : (c.thinking || 'auto'));
    document.getElementById('api-budget').value = c.thinkingBudget || 2048;
    document.getElementById('api-context').value = c.maxContext ?? 64000;
    document.getElementById('api-autosummary').value = String(c.autoSummary !== false);
    document.getElementById('api-sumthreshold').value = c.autoSummaryThreshold || 12000;
    // 辅助 API（后台任务独立端点）
    const ax = c.aux || {};
    document.getElementById('api-aux-enabled').value = String(!!ax.enabled);
    document.getElementById('api-aux-protocol').value = ax.protocol || 'anthropic';
    document.getElementById('api-aux-base').value = ax.baseURL || '';
    const auxKey = document.getElementById('api-aux-key');
    auxKey.value = '';
    auxKey.placeholder = `留空 = 沿用当前 Key（${ax.apiKeyMasked || '未配置'}）`;
    document.getElementById('api-aux-model').value = ax.model || '';
    document.getElementById('api-aux-fallback').value = String(!!ax.fallback);
    apiNow.textContent = `当前：${c.protocol === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'} · ${c.baseURL} · ${c.model}${c.apiKeyMasked ? ' · Key ' + c.apiKeyMasked : ''} · max_tokens ${c.maxTokens} · thinking ${c.thinking} · context ${c.maxContext ?? 64000}`;
    await loadPresets();
    await loadProfiles();
    loadInjections();   // 自定义注入槽（按当前会话加载）
  } catch (e) { /* 忽略 */ }
  apiModal.classList.remove('hidden');
});
document.getElementById('api-cancel').addEventListener('click', () => apiModal.classList.add('hidden'));
document.getElementById('api-save').addEventListener('click', async () => {
  const btn = document.getElementById('api-save');
  btn.disabled = true;
  btn.textContent = '探测中…';
  apiMsg.className = 'api-msg';
  apiMsg.textContent = '';
  try {
    const r = await (await fetch('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: apiProtocol.value,
        baseURL: apiBase.value.trim(),
        apiKey: apiKey.value.trim(),
        maxTokens: Number(document.getElementById('api-maxtokens').value) || 8192,
        thinking: document.getElementById('api-thinking').value,
        thinkingBudget: Number(document.getElementById('api-budget').value) || 2048,
        maxContext: Number(document.getElementById('api-context').value) || 0,
        autoSummary: document.getElementById('api-autosummary').value === 'true',
        autoSummaryThreshold: Number(document.getElementById('api-sumthreshold').value) || 12000,
        // 辅助 API（后台任务独立端点）
        aux: {
          enabled: document.getElementById('api-aux-enabled').value === 'true',
          protocol: document.getElementById('api-aux-protocol').value,
          baseURL: document.getElementById('api-aux-base').value.trim(),
          apiKey: document.getElementById('api-aux-key').value.trim(),
          model: document.getElementById('api-aux-model').value.trim(),
          fallback: document.getElementById('api-aux-fallback').value === 'true',
        },
      }),
    })).json();
    if (r.ok) {
      apiMsg.className = 'api-msg ok';
      apiMsg.textContent = r.mapped
        ? `✓ 已保存并探测成功。「${r.requested}」被端点映射为 ${r.model}（已自动更正）。`
        : `✓ 已保存并探测成功。当前模型：${r.model}。`;
      loadModel();
      loadStats();
      setTimeout(() => apiModal.classList.add('hidden'), 1200);
    } else {
      apiMsg.className = 'api-msg err';
      apiMsg.textContent = '✗ 保存失败：' + (r.error || '未知错误');
    }
  } catch (e) {
    apiMsg.className = 'api-msg err';
    apiMsg.textContent = '✗ 保存失败：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '保存并探测';
  }
});

// ---------- 自定义注入槽（⚙️ 前缀 / 后缀，按会话，随 system 注入） ----------
async function loadInjections() {
  try {
    const r = await (await fetch('/api/op/inject?chatId=' + encodeURIComponent(App.chatId || ''))).json();
    if (r.ok) {
      document.getElementById('inject-prefix').value = r.prefix || '';
      document.getElementById('inject-suffix').value = r.suffix || '';
    }
  } catch (e) { /* 忽略 */ }
}
document.getElementById('inject-save').addEventListener('click', async () => {
  const note = document.getElementById('inject-note');
  try {
    const r = await (await fetch('/api/op/inject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chatId: App.chatId,
        prefix: document.getElementById('inject-prefix').value,
        suffix: document.getElementById('inject-suffix').value,
      }),
    })).json();
    if (r.ok) {
      note.textContent = '已保存（下一轮生效）';
      note.classList.remove('hidden');
      setTimeout(() => note.classList.add('hidden'), 3000);
    } else {
      alert('保存失败：' + (r.error || '未知错误'));
    }
  } catch (e) { alert('保存失败：' + e.message); }
});

// ---------- API 采样预设（命名预设） ----------
const presetSelect = document.getElementById('preset-select');
async function loadPresets() {
  try {
    const r = await (await fetch('/api/presets')).json();
    if (!r.ok || !r.presets) return;
    presetSelect.innerHTML = '';
    for (const n of Object.keys(r.presets)) {
      const o = document.createElement('option');
      o.value = n; o.textContent = n;
      presetSelect.appendChild(o);
    }
    if (r.active) presetSelect.value = r.active;
    const p = r.presets[r.active] || {};
    const set = (id, v, dft) => { const el = document.getElementById(id); if (el) el.value = (v != null ? v : dft); };
    set('preset-temp', p.temperature, 1.0);
    set('preset-topp', p.top_p, 1.0);
    set('preset-topk', p.top_k, 0);
    set('preset-presence', p.presence_penalty, 0);
    set('preset-freq', p.frequency_penalty, 0);
    if (p.maxTokens != null) document.getElementById('api-maxtokens').value = p.maxTokens;
    if (p.maxContext != null) document.getElementById('api-context').value = p.maxContext;
  } catch (e) { /* 服务未就绪 */ }
}
function readPresetInputs() {
  const num = (id, dft) => Number(document.getElementById(id).value) || dft;
  return {
    temperature: num('preset-temp', 1.0),
    top_p: num('preset-topp', 1.0),
    top_k: Math.round(num('preset-topk', 0)),
    presence_penalty: num('preset-presence', 0),
    frequency_penalty: num('preset-freq', 0),
    maxTokens: num('api-maxtokens', 8192),
    maxContext: num('api-context', 0),
  };
}
async function presetPost(body) {
  try {
    const r = await (await fetch('/api/presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    if (r.error) { apiMsg.className = 'api-msg err'; apiMsg.textContent = '✗ ' + r.error; return; }
    apiMsg.className = 'api-msg ok';
    apiMsg.textContent = '✓ ' + (r.note || '已应用');
    await loadPresets();
  } catch (e) {
    apiMsg.className = 'api-msg err';
    apiMsg.textContent = '✗ ' + e.message;
  }
}
document.getElementById('preset-apply').addEventListener('click', () => presetPost({ action: 'apply', name: presetSelect.value }));
document.getElementById('preset-save').addEventListener('click', () => {
  const name = (prompt('预设名称（与现有同名 = 覆盖）：', presetSelect.value) || '').trim();
  if (!name) return;
  presetPost({ action: 'save', name, preset: readPresetInputs() });
});
document.getElementById('preset-del').addEventListener('click', () => {
  if (!presetSelect.value) return;
  if (!confirm('删除预设「' + presetSelect.value + '」？')) return;
  presetPost({ action: 'delete', name: presetSelect.value });
});

// ---------- 配置档案（Profile：端点 + 模型 + 参数整套一键切换） ----------
const profileInput = document.getElementById('profile-input');
const profileSelect = document.getElementById('profile-select');
App.profileData = {};

async function loadProfiles() {
  try {
    const r = await (await fetch('/api/profiles')).json();
    if (!r.ok) return;
    App.profileData = r.profiles || {};
    profileInput.innerHTML = '<option value="">— 配置档案 —</option>';
    for (const name of Object.keys(App.profileData)) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name + (App.profileData[name].builtin ? ' ⭐' : '');
      o.title = App.profileData[name].keyReady
        ? '该端点 Key 已记忆，切换自动带上'
        : '该端点 Key 未记忆（首次切换沿用当前 Key，在 API 设置填一次即自动记住）';
      profileInput.appendChild(o);
    }
    if (r.active) profileInput.value = r.active;
    profileInput.title = r.active ? `当前档案：${r.active}（选择即切换整套配置）` : '配置档案（端点 + 模型 + 参数整套切换）';
    profileSelect.innerHTML = '';
    for (const name of Object.keys(App.profileData)) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name + (App.profileData[name].builtin ? ' ⭐' : '');
      o.title = App.profileData[name].keyReady
        ? '该端点 Key 已记忆，切换自动带上'
        : '该端点 Key 未记忆（首次切换沿用当前 Key，在 API 设置填一次即自动记住）';
      profileSelect.appendChild(o);
    }
    if (r.active) profileSelect.value = r.active;
  } catch (e) { /* 忽略 */ }
}
profileInput.addEventListener('change', async () => {
  const name = profileInput.value;
  if (!name) return;
  try {
    const r = await (await fetch('/api/profiles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'apply', name }),
    })).json();
    if (r.ok) {
      profileInput.title = r.keySource === 'memo'
        ? `当前档案：${name}（已自动带上该端点 Key：${r.apiKeyMasked || '已配置'}）`
        : `当前档案：${name}（该端点 Key 未记忆，暂沿用当前 Key，API 设置填一次即自动记住）`;
      ensureModelOption(modelInput, r.model);
      modelInput.value = r.model;
      modelInput.title = `当前模型：${r.model}（档案「${name}」已切换）`;
      App.peakEligible = r.peakEligible !== false;
      updatePeakBanner();
      loadStats();
      if (r.preset) { await loadPresets(); }
    } else {
      alert('档案切换失败：' + (r.error || '未知错误'));
      loadProfiles();
    }
  } catch (e) { alert('档案切换失败：' + e.message); loadProfiles(); }
});
document.getElementById('profile-apply').addEventListener('click', async () => {
  const name = profileSelect.value;
  if (!name) return;
  try {
    const r = await (await fetch('/api/profiles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'apply', name }),
    })).json();
    if (r.ok) {
      apiProtocol.value = r.protocol || 'anthropic';
      apiBase.value = r.baseURL || '';
      document.getElementById('api-maxtokens').value = r.maxTokens || 8192;
      document.getElementById('api-thinking').value = (r.thinking === 'enabled' ? 'high' : (r.thinking || 'auto'));
      document.getElementById('api-context').value = r.maxContext ?? 64000;
      ensureModelOption(modelInput, r.model);
      modelInput.value = r.model;
      profileInput.value = name;
      profileInput.title = `当前档案：${name}`;
      App.peakEligible = r.peakEligible !== false;
      updatePeakBanner();
      await loadPresets();
      loadStats();
      apiMsg.className = 'api-msg ok';
      apiMsg.textContent = (r.note || '已切换') + ' · '
        + (r.keySource === 'memo'
          ? '已自动带上该端点 Key（' + (r.apiKeyMasked || '已配置') + '），无需重填'
          : '该端点 Key 未记忆，暂沿用当前 Key——在 API 设置填一次即自动记住');
    } else {
      apiMsg.className = 'api-msg err';
      apiMsg.textContent = r.error || '切换失败';
    }
  } catch (e) { apiMsg.className = 'api-msg err'; apiMsg.textContent = e.message; }
});
document.getElementById('profile-save').addEventListener('click', async () => {
  const name = (prompt('配置档案名称（与现有同名 = 覆盖）：', profileSelect.value || '') || '').trim();
  if (!name) return;
  try {
    const r = await (await fetch('/api/profiles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', name }),
    })).json();
    if (r.ok) {
      await loadProfiles();
      profileSelect.value = name;
      profileInput.value = name;
      apiMsg.className = 'api-msg ok';
      apiMsg.textContent = r.note || '已保存';
    } else {
      apiMsg.className = 'api-msg err';
      apiMsg.textContent = r.error || '保存失败';
    }
  } catch (e) { apiMsg.className = 'api-msg err'; apiMsg.textContent = e.message; }
});
document.getElementById('profile-del').addEventListener('click', async () => {
  const name = profileSelect.value;
  if (!name) return;
  if (!confirm('删除配置档案「' + name + '」？')) return;
  try {
    const r = await (await fetch('/api/profiles', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'delete', name }),
    })).json();
    if (r.ok) {
      await loadProfiles();
      apiMsg.className = 'api-msg ok';
      apiMsg.textContent = r.note || '已删除';
    } else {
      apiMsg.className = 'api-msg err';
      apiMsg.textContent = r.error || '删除失败';
    }
  } catch (e) { apiMsg.className = 'api-msg err'; apiMsg.textContent = e.message; }
});

// ---------- 模型查看 / 切换（select 下拉 + 自定义） ----------
const modelInput = document.getElementById('model-input');
function ensureModelOption(sel, model) {
  const exists = [...sel.options].some((o) => o.value === model);
  if (!exists && model !== '__custom__') {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model + '（自定义）';
    sel.insertBefore(opt, sel.querySelector('[value="__custom__"]'));
  }
}
async function loadModel() {
  try {
    const { model, peakEligible: pe } = await (await fetch('/api/model')).json();
    App.peakEligible = pe !== false;   // 官方直连渠道才启用高峰提醒
    ensureModelOption(modelInput, model);
    modelInput.value = model;
    modelInput.title = `当前模型：${model}（选择即切换，自动保存）`;
    updatePeakBanner();
  } catch (e) { /* 忽略 */ }
}
modelInput.addEventListener('change', async () => {
  let m = modelInput.value;
  if (m === '__custom__') {
    m = prompt('输入自定义模型名（会被端点探测，无效将自动纠正）：', '');
    if (!m) { loadModel(); return; }
  }
  m = m.trim();
  if (!m) { loadModel(); return; }
  try {
    const r = await (await fetch('/api/model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: m }),
    })).json();
    if (r.ok) {
      ensureModelOption(modelInput, r.model);
      modelInput.value = r.model;
      if (r.mapped) {
        modelInput.title = `「${r.requested}」被端点映射为 ${r.model}（已自动更正）`;
      } else {
        modelInput.title = `当前模型：${r.model}（选择即切换，自动保存）`;
      }
      App.peakEligible = r.peakEligible !== false;
      updatePeakBanner();
      loadStats();   // 切换模型后统计栏立即跟随新模型
    } else {
      alert('模型切换失败：' + (r.error || '未知错误'));
      loadModel();
    }
  } catch (e) { alert('模型切换失败：' + e.message); loadModel(); }
});

// ---------- 皮肤 & 背景（主题 + 自定义调色板 + 背景 URL） ----------
const themeSelect = document.getElementById('theme-select');

// localStorage key 迁移：旧 rw- 前缀（早期版本）→ mr-（当前）
function migrateKey(oldKey, newKey) {
  try {
    if (!localStorage.getItem(newKey) && localStorage.getItem(oldKey)) {
      localStorage.setItem(newKey, localStorage.getItem(oldKey));
      localStorage.removeItem(oldKey);
    }
  } catch (e) { /* ignore */ }
}
migrateKey('rw-custom-skin', 'mr-custom-skin');
migrateKey('rw-op-view', 'mr-op-view');
migrateKey('rw-op-expand', 'mr-op-expand');
migrateKey('rw-op-tools', 'mr-op-tools');
migrateKey('rw-tour-done-v1', 'mr-tour-done-v1');

// 自定义调色板：色相/饱和度/亮度 → HSL 派生 CSS 变量
const CUSTOM_SKIN_DEFAULT = { mode: 'dark', hue: 250, sat: 55, light: 45 };
App.customSkin = { ...CUSTOM_SKIN_DEFAULT };
try { App.customSkin = { ...CUSTOM_SKIN_DEFAULT, ...(JSON.parse(localStorage.getItem('mr-custom-skin')) || {}) }; } catch (e) { /* 首次 */ }
function saveCustomSkin() { localStorage.setItem('mr-custom-skin', JSON.stringify(App.customSkin)); }

function applyCustomSkin() {
  const { mode, hue, sat, light } = App.customSkin;
  const root = document.documentElement;
  const H = hue, S = sat / 100, L = light / 100;
  const hsl = (h, s, l) => `hsl(${h} ${s * 100}% ${l * 100}%)`;
  const base = mode === 'light'
    ? { bg: [H, S * 0.55, 0.90], bg2: [H, S * 0.45, 0.95], card: [H, S * 0.4, 1.0], border: [H, S * 0.25, 0.78], text: [H, S * 0.3, 0.18], muted: [H, S * 0.2, 0.45], accent: [H, S * 0.65, 0.42] }
    : { bg: [H, S * 0.5, L * 0.5], bg2: [H, S * 0.45, L * 0.58], card: [H, S * 0.42, L * 0.68], border: [H, S * 0.3, L * 0.85], text: [H, S * 0.2, 0.93], muted: [H, S * 0.15, 0.72], accent: [H, S * 0.75, Math.min(0.68, L * 1.1 + 0.25)] };
  const set = (name, v) => root.style.setProperty(name, hsl(...v));
  set('--bg', base.bg); set('--bg2', base.bg2); set('--card', base.card);
  set('--border', base.border); set('--text', base.text); set('--muted', base.muted);
  set('--accent', base.accent);
  root.style.setProperty('--user-bubble', hsl(H, S * 0.5, L * 0.72));
  root.style.setProperty('--user-border', hsl(H, S * 0.55, L * 0.9));
  root.style.setProperty('--scrim', mode === 'light' ? 'rgba(245, 241, 231, 0.55)' : 'rgba(12, 14, 24, 0.72)');
}

function applySkin() {
  if (App.prefs.theme === 'custom') {
    document.body.dataset.theme = 'default';   // 走默认结构，CSS 变量由 applyCustomSkin 覆盖
    applyCustomSkin();
  } else {
    document.documentElement.style.cssText = '';   // 清除自定义变量（还原主题定义）
    document.body.dataset.theme = App.prefs.theme || 'default';
  }
  // 背景 URL（自助美化）
  if (App.prefs.bgUrl && App.prefs.bgUrl.trim()) {
    // 过滤引号防 CSS 上下文注入
    document.body.style.setProperty('--bg-url', `url('${App.prefs.bgUrl.trim().replace(/['"\\]/g, '')}')`);
    document.body.classList.add('with-bg');
    document.body.classList.remove('bg-contain');
  } else {
    document.body.classList.remove('with-bg');
    document.body.style.removeProperty('--bg-url');
  }
  themeSelect.value = App.prefs.theme || 'default';
  const csBox = document.getElementById('custom-skin');
  if (csBox) csBox.classList.toggle('hidden', App.prefs.theme !== 'custom');
  const bgUrlInput = document.getElementById('bg-url-input');
  if (bgUrlInput) bgUrlInput.value = App.prefs.bgUrl || '';
}
themeSelect.addEventListener('change', () => {
  App.prefs.theme = themeSelect.value;
  savePrefs();
  applySkin();
});

// 自定义调色板控件（仅 theme=custom 时显示）
function bindCustomSkin() {
  const csMode = document.getElementById('cs-mode');
  const csHue = document.getElementById('cs-hue');
  const csSat = document.getElementById('cs-sat');
  const csLight = document.getElementById('cs-light');
  const csNote = document.getElementById('cs-note');
  if (!csMode) return;
  csMode.value = App.customSkin.mode;
  csHue.value = App.customSkin.hue;
  csSat.value = App.customSkin.sat;
  csLight.value = App.customSkin.light;
  const apply = () => {
    App.customSkin = { mode: csMode.value, hue: Number(csHue.value), sat: Number(csSat.value), light: Number(csLight.value) };
    saveCustomSkin();
    if (App.prefs.theme === 'custom') applyCustomSkin();
    csNote.classList.remove('hidden');
    setTimeout(() => csNote.classList.add('hidden'), 1500);
  };
  csMode.addEventListener('change', apply);
  csHue.addEventListener('input', apply);
  csSat.addEventListener('input', apply);
  csLight.addEventListener('input', apply);
  document.getElementById('cs-reset').addEventListener('click', () => {
    App.customSkin = { ...CUSTOM_SKIN_DEFAULT };
    csMode.value = App.customSkin.mode;
    csHue.value = App.customSkin.hue;
    csSat.value = App.customSkin.sat;
    csLight.value = App.customSkin.light;
    saveCustomSkin();
    if (App.prefs.theme === 'custom') applyCustomSkin();
  });
  const bgUrlInput = document.getElementById('bg-url-input');
  if (bgUrlInput) {
    bgUrlInput.addEventListener('change', () => {
      App.prefs.bgUrl = bgUrlInput.value.trim();
      savePrefs();
      applySkin();
    });
  }
}

// ---------- 显示设置（localStorage 持久化） ----------
const PREFS_KEY = 'moonrabbitPrefs';
App.prefs = { hlEnabled: true, theme: 'default', showThinking: true, peakConfirm: true, bgUrl: '' };
try {
  App.prefs = { ...App.prefs, ...(JSON.parse(localStorage.getItem(PREFS_KEY)) || {}) };
} catch (e) { /* 首次使用 */ }
function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(App.prefs)); }

function renderSettings() {
  const panel = document.getElementById('settings-panel');
  panel.innerHTML = '';
  const mk = (label, checked, onChange) => {
    const row = document.createElement('label');
    row.className = 'set-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => { onChange(cb.checked); savePrefs(); });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(label));
    return row;
  };
  panel.appendChild(mk('显示思考过程（💭 折叠块）', App.prefs.showThinking !== false, (v) => { App.prefs.showThinking = v; }));
  panel.appendChild(mk('高峰时段发送确认（官方直连渠道）', App.prefs.peakConfirm !== false, (v) => { App.prefs.peakConfirm = v; }));
}
document.getElementById('settings-toggle').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('hidden');
});

// ---------- 剧情记忆：时间线 / 物品栏 / 换装 / 情绪 / 导出 ----------
const tmTabTl = document.getElementById('tm-tab-tl');
const tmTabInv = document.getElementById('tm-tab-inv');
const tmTabWd = document.getElementById('tm-tab-wd');
const tmTabEm = document.getElementById('tm-tab-em');
const tmTabAuto = document.getElementById('tm-tab-auto');
const tmTabLoc = document.getElementById('tm-tab-loc');
const tmTimeline = document.getElementById('tm-timeline');
const tmInventory = document.getElementById('tm-inventory');
const tmWardrobe = document.getElementById('tm-wardrobe');
const tmEmotions = document.getElementById('tm-emotions');
const tmAuto = document.getElementById('tm-auto');
const tmLocations = document.getElementById('tm-locations');
const tmExport = document.getElementById('tm-export');
const tmExportBox = document.getElementById('tm-export-box');

async function loadEmotions() {
  const box = document.getElementById('em-list');
  const nameInput = document.getElementById('em-name');
  try {
    const { emotions } = await (await fetch(`/api/emotions?chatId=${encodeURIComponent(App.chatId || '')}`)).json();
    const names = Object.keys(emotions || {});
    box.innerHTML = '';
    if (!names.length) {
      box.innerHTML = '（暂无情绪记录）';
      return;
    }
    for (const n of names) {
      const d = document.createElement('div');
      d.className = 'em-item';
      d.innerHTML = `<span class="em-name">${escapeHtml(n)}</span><span class="em-text">${escapeHtml(emotions[n])}</span>`;
      box.appendChild(d);
    }
    if (nameInput) nameInput.value = names[0] || '';
  } catch (e) { box.textContent = '情绪读取失败：' + e.message; }
}
document.getElementById('em-btn').addEventListener('click', async () => {
  const name = document.getElementById('em-name').value.trim();
  const emotion = document.getElementById('em-text').value.trim();
  const note = document.getElementById('em-note');
  if (!name) { note.textContent = '请填写角色名'; note.classList.remove('hidden'); return; }
  try {
    const r = await (await fetch('/api/op/emotion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, name, emotion }),
    })).json();
    note.textContent = r.error ? `✗ ${r.error}` : `✓ ${r.note}`;
    if (!r.error) {
      document.getElementById('em-text').value = '';
      loadEmotions();
    }
  } catch (e) { note.textContent = `✗ ${e.message}`; }
  note.classList.remove('hidden');
  setTimeout(() => note.classList.add('hidden'), 6000);
});

async function loadTimeline() {
  try {
    const { turns } = await (await fetch(`/api/timeline?limit=15&chatId=${encodeURIComponent(App.chatId || '')}`)).json();
    tmTimeline.innerHTML = turns.length ? '' : '（暂无回合记录）';
    for (const t of turns) {
      const d = document.createElement('div');
      d.className = 'tm-item';
      const ev = (t.event || '').slice(0, 60);
      const loc = t.location ? `<span class="loc">${escapeHtml(t.location)}</span>` : '';
      const gain = t.items_gain.length ? `<span class="gain"> ＋${t.items_gain.map((g) => escapeHtml(g.name)).join('、')}</span>` : '';
      const loss = t.items_loss.length ? `<span class="loss"> －${t.items_loss.map(escapeHtml).join('、')}</span>` : '';
      const emo = t.emotion && Object.keys(t.emotion).length ? `<span class="emotag"> 💗${Object.entries(t.emotion).map(([n, v]) => `${escapeHtml(n)}=${escapeHtml(v)}`).join('、')}</span>` : '';
      d.innerHTML = `<div class="t">${escapeHtml(t.story_time || '?')}｜${escapeHtml(ev || '（无事件摘要）')}</div>${loc}${gain}${loss}${emo}`;
      if (t.id) {
        const act = document.createElement('div');
        act.className = 'tm-actions';
        const edit = document.createElement('button');
        edit.className = 'ma-btn';
        edit.textContent = '✏️ 改';
        edit.title = '修改该条时间线记录';
        edit.addEventListener('click', () => openTmItemEdit(d, t, 'edit'));
        const ins = document.createElement('button');
        ins.className = 'ma-btn';
        ins.textContent = '＋ 插';
        ins.title = '在该条之后补充一条时间线记录';
        ins.addEventListener('click', () => openTmItemEdit(d, t, 'insert'));
        const del = document.createElement('button');
        del.className = 'ma-btn del';
        del.textContent = '✕ 删';
        del.title = '删除该条回合记录';
        del.addEventListener('click', async () => {
          if (!confirm('删除该条回合记录？')) return;
          try {
            await fetch('/api/timeline/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chatId: App.chatId, id: t.id }),
            });
            loadTimeline();
            loadInventory();
          } catch (e) { /* 忽略 */ }
        });
        act.append(edit, ins, del);
        d.appendChild(act);
      }
      tmTimeline.appendChild(d);
    }
  } catch (e) { tmTimeline.textContent = '时间线读取失败'; }
}

// 时间线条目 修改/补充：行内编辑表单（edit=预填原值；insert=清空，插到该条之后）
App.tmItemEditBox = null;   // 当前展开的编辑容器（同一时间只开一个）
function openTmItemEdit(itemEl, t, mode) {
  if (App.tmItemEditBox && App.tmItemEditBox.parentNode) App.tmItemEditBox.remove();
  const label = mode === 'edit' ? '✏️ 修改时间线记录' : '＋ 在该条之后补充时间线记录';
  const box = document.createElement('div');
  box.className = 'tm-edit tm-item-edit';
  box.innerHTML = `
    <div class="tm-edit-title">${label}</div>
    <div class="em-row"><input data-f="story_time" type="text" placeholder="时间（如：8/9 早上）"><input data-f="location" type="text" placeholder="地点（可留空）"></div>
    <div class="em-row"><input data-f="characters" type="text" placeholder="在场角色（顿号分隔，可留空）"><input data-f="costume" type="text" placeholder="着装变化（可留空）"></div>
    <div class="em-row"><input data-f="atmosphere" type="text" placeholder="氛围（可留空）"><input data-f="event" type="text" placeholder="事件一句话（可留空）"></div>
    <div class="em-row"><button class="tm-ai-btn ma-btn">✨ AI 补全</button><button class="head-btn">✅ 保存</button><button class="tm-cancel-btn ma-btn">取消</button><span class="tm-item-note"></span></div>`;
  if (mode === 'edit') {
    box.querySelector('[data-f="story_time"]').value = t.story_time || '';
    box.querySelector('[data-f="location"]').value = t.location || '';
    box.querySelector('[data-f="characters"]').value = (t.characters || []).join('、');
    box.querySelector('[data-f="costume"]').value = t.costume || '';
    box.querySelector('[data-f="atmosphere"]').value = t.atmosphere || '';
    box.querySelector('[data-f="event"]').value = t.event || '';
  }
  const note = box.querySelector('.tm-item-note');
  const collect = () => ({
    chatId: App.chatId,
    story_time: box.querySelector('[data-f="story_time"]').value.trim(),
    location: box.querySelector('[data-f="location"]').value.trim(),
    characters: box.querySelector('[data-f="characters"]').value.trim(),
    costume: box.querySelector('[data-f="costume"]').value.trim(),
    atmosphere: box.querySelector('[data-f="atmosphere"]').value.trim(),
    event: box.querySelector('[data-f="event"]').value.trim(),
  });
  box.querySelector('.head-btn').addEventListener('click', async () => {
    const p = collect();
    if (!p.story_time && !p.event) { note.textContent = '至少填时间或事件'; return; }
    try {
      const body = mode === 'edit' ? { ...p, id: t.id } : { ...p, afterId: t.id };
      const r = await (await fetch(mode === 'edit' ? '/api/timeline/update' : '/api/timeline/insert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })).json();
      note.textContent = r.ok ? (mode === 'edit' ? '✓ 已保存，刷新中…' : '✓ 已补充，刷新中…') : `✗ ${r.error || '失败'}`;
      if (r.ok) setTimeout(() => loadTimeline(), 400);
    } catch (e) { note.textContent = '✗ ' + e.message; }
  });
  box.querySelector('.tm-ai-btn').addEventListener('click', () => {
    const hint = [...box.querySelectorAll('input[data-f]')].map((i) => i.value.trim()).filter(Boolean).join('；');
    aiFillTimeline(box, box.querySelector('.tm-item-note'), hint);
  });
  box.querySelector('.tm-cancel-btn').addEventListener('click', () => box.remove());
  itemEl.insertAdjacentElement('afterend', box);
  App.tmItemEditBox = box;
  box.querySelector('input').focus();
}

// AI 智能补全：调用 /api/timeline/ai-fill（辅助 API 串行队列），把返回字段填入表单（box 内需带 data-f 输入框）
async function aiFillTimeline(box, note, hint) {
  if (!note) return;
  note.textContent = '✨ AI 整理中…';
  try {
    const r = await (await fetch('/api/timeline/ai-fill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, hint: String(hint || '') }),
    })).json();
    if (!r.ok) { note.textContent = '✗ ' + (r.error || 'AI 补全失败，请手动填写'); return; }
    const f = r.fields || {};
    const set = (k, v) => { const el = box?.querySelector(`[data-f="${k}"]`); if (el) el.value = v || ''; };
    set('story_time', f.story_time);
    set('location', f.location);
    set('characters', (f.characters || []).join('、'));
    set('costume', f.costume);
    set('atmosphere', f.atmosphere);
    set('event', f.event);
    // 自动写入 turns
    const hasData = f.story_time || f.event || f.costume || (f.items_gain||[]).length || Object.keys(f.emotion||{}).length || f.location_detail;
    if (hasData) {
      try {
        await fetch('/api/timeline/manual', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: App.chatId, ...f, characters: Array.isArray(f.characters) ? f.characters.join('、') : f.characters }),
        });
        loadTimeline(); loadInventory(); loadCurrentWardrobe(); loadEmotions(); loadLocationsUI();
      } catch (e) { /* 写入失败不阻塞 */ }
    }
    const parts = [];
    if (f.story_time || f.event) parts.push('时间线');
    if (f.costume) parts.push('换装');
    if ((f.items_gain||[]).length || (f.items_loss||[]).length) parts.push(`物品${(f.items_gain||[]).length + (f.items_loss||[]).length}条`);
    if (Object.keys(f.emotion||{}).length) parts.push(`情绪${Object.keys(f.emotion).length}条`);
    if (f.location_detail) parts.push('地点');
    note.textContent = parts.length ? `✨ 已补全并写入：${parts.join('、')}` : '✨ AI 未提取到有效数据，请手动填写';
  } catch (e) { note.textContent = '✗ ' + e.message; }
}

async function loadInventory() {
  try {
    const { inventory, recent } = await (await fetch(`/api/inventory?chatId=${encodeURIComponent(App.chatId || '')}`)).json();
    tmInventory.innerHTML = '';
    if (inventory.length) {
      const head = document.createElement('div');
      head.innerHTML = '<b>当前物品栏：</b>';
      tmInventory.appendChild(head);
      const list = document.createElement('div');
      list.innerHTML = inventory.map((i) => `<span class="chip">${escapeHtml(i.name)}${i.count > 1 ? ` ×${i.count}` : ''}${i.holder ? `（${escapeHtml(i.holder)}）` : ''}</span>`).join(' ');
      tmInventory.appendChild(list);
    } else {
      tmInventory.innerHTML = '（暂无物品追踪记录）';
    }
    if (recent.length) {
      const rec = document.createElement('div');
      rec.style.marginTop = '8px';
      rec.innerHTML = '<b>最近变更：</b>';
      tmInventory.appendChild(rec);
      for (const r of recent) {
        const d = document.createElement('div');
        d.className = r.type === 'gain' ? 'gain' : 'loss';
        d.textContent = (r.type === 'gain' ? '＋' : '－') + r.name + (r.holder ? ` → ${r.holder}` : '');
        tmInventory.appendChild(d);
      }
    }
  } catch (e) { tmInventory.textContent = '物品栏读取失败'; }
}

const tmEditTl = document.querySelector('.tm-edit:not(#inv-edit)');  // 手动补记（时间线）编辑区
const tmEditInv = document.getElementById('inv-edit');                // 手动修改物品栏编辑区
function setTmTabVis(active) {
  const map = { tl: [tmTimeline, tmEditTl], inv: [tmInventory, tmEditInv], wd: [tmWardrobe], em: [tmEmotions], auto: [tmAuto], loc: [tmLocations] };
  for (const [k, els] of Object.entries(map)) {
    els.forEach(el => { if (el) el.classList.toggle('hidden', k !== active); });
  }
}
tmTabTl.addEventListener('click', () => {
  tmTabTl.classList.add('active'); tmTabInv.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabLoc.classList.remove('active');
  setTmTabVis('tl');
});
tmTabInv.addEventListener('click', () => {
  tmTabInv.classList.add('active'); tmTabTl.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabLoc.classList.remove('active');
  setTmTabVis('inv');
  loadInventory();
});
tmTabWd.addEventListener('click', () => {
  tmTabWd.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabLoc.classList.remove('active');
  setTmTabVis('wd');
  loadCurrentWardrobe();
});
tmTabEm.addEventListener('click', () => {
  tmTabEm.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabLoc.classList.remove('active');
  setTmTabVis('em');
  loadEmotions();
});
tmTabAuto.addEventListener('click', () => {
  tmTabAuto.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabLoc.classList.remove('active');
  setTmTabVis('auto');
  loadStoryMemoryUI();
});
tmTabLoc.addEventListener('click', () => {
  tmTabLoc.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabAuto.classList.remove('active');
  setTmTabVis('loc');
  loadLocationsUI();
});

// ---------- 剧情记忆手动编辑：时间线补记 / 物品栏增删 / 当前着装 ----------
// 手动补记一条回合
document.getElementById('mt-btn').addEventListener('click', async () => {
  const note = document.getElementById('mt-note');
  const payload = {
    chatId: App.chatId,
    story_time: document.getElementById('mt-time').value.trim(),
    location: document.getElementById('mt-loc').value.trim(),
    characters: document.getElementById('mt-char').value.trim(),
    costume: document.getElementById('mt-cos').value.trim(),
    atmosphere: document.getElementById('mt-atm').value.trim(),
    event: document.getElementById('mt-event').value.trim(),
  };
  if (!payload.story_time && !payload.event) { note.textContent = '至少填时间或事件'; note.classList.remove('hidden'); return; }
  try {
    const r = await (await fetch('/api/timeline/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })).json();
    note.textContent = r.ok ? `✓ 已补记（${r.rec.story_time || '时间未填'}）` : `✗ ${r.error || '失败'}`;
    if (r.ok) {
      document.getElementById('mt-time').value = ''; document.getElementById('mt-loc').value = '';
      document.getElementById('mt-char').value = ''; document.getElementById('mt-cos').value = '';
      document.getElementById('mt-atm').value = ''; document.getElementById('mt-event').value = '';
      loadTimeline();
    }
  } catch (e) { note.textContent = `✗ ${e.message}`; }
  note.classList.remove('hidden');
  setTimeout(() => note.classList.add('hidden'), 5000);
});
// AI 智能补全：把当前填的内容（无内容则靠最近对话）整理成规范字段
document.getElementById('mt-ai').addEventListener('click', () => {
  const box = document.getElementById('tm-edit-tl');
  const note = document.getElementById('mt-note');
  const hint = ['mt-time', 'mt-loc', 'mt-char', 'mt-cos', 'mt-atm', 'mt-event']
    .map((id) => document.getElementById(id).value.trim()).filter(Boolean).join('；');
  note.classList.remove('hidden');
  aiFillTimeline(box, note, hint);
  setTimeout(() => note.classList.add('hidden'), 8000);
});
// 手动添加 / 消耗物品
document.getElementById('inv-btn').addEventListener('click', async () => {
  const note = document.getElementById('inv-note');
  const name = document.getElementById('inv-name').value.trim();
  const holder = document.getElementById('inv-holder').value.trim();
  const action = document.getElementById('inv-act').value;
  if (!name) { note.textContent = '请填写物品名'; note.classList.remove('hidden'); return; }
  try {
    const r = await (await fetch('/api/inventory/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, action, name, holder }),
    })).json();
    note.textContent = r.ok ? `✓ ${r.note}` : `✗ ${r.error || '失败'}`;
    if (r.ok) {
      document.getElementById('inv-name').value = '';
      document.getElementById('inv-holder').value = '';
      loadInventory();
    }
  } catch (e) { note.textContent = `✗ ${e.message}`; }
  note.classList.remove('hidden');
  setTimeout(() => note.classList.add('hidden'), 5000);
});
// 当前着装聚合显示（换装卡片顶部）
async function loadCurrentWardrobe() {
  const box = document.getElementById('wd-current');
  if (!box) return;
  try {
    const { wardrobes } = await (await fetch(`/api/wardrobe/current?chatId=${encodeURIComponent(App.chatId || '')}`)).json();
    const names = Object.keys(wardrobes || {});
    box.innerHTML = names.length
      ? '当前着装：' + names.map((n) => `<span class="chip">${escapeHtml(n)}：${escapeHtml(wardrobes[n])}</span>`).join(' ')
      : '当前着装：未记录（换装后自动更新）';
  } catch (e) { box.textContent = '当前着装：读取失败'; }
}


tmExport.addEventListener('click', async () => {
  try {
    const text = await (await fetch(`/api/timeline/export?chatId=${encodeURIComponent(App.chatId || '')}`)).text();
    tmExportBox.classList.remove('hidden');
    tmExportBox.textContent = text;
  } catch (e) {
    tmExportBox.classList.remove('hidden');
    tmExportBox.textContent = '导出失败：' + e.message;
  }
});

// ---------- 调试：查看最近提示词 ----------
document.getElementById('prompt-btn').addEventListener('click', async () => {
  const modal = document.getElementById('prompt-modal');
  const meta = document.getElementById('prompt-meta');
  const body = document.getElementById('prompt-body');
  modal.classList.remove('hidden');
  meta.textContent = '加载中…';
  body.textContent = '';
  try {
    const d = await (await fetch(`/api/prompt/latest?chatId=${encodeURIComponent(App.chatId || '')}`)).json();
    const l = d.latest;
    if (!l || !l.system) {
      meta.textContent = '（本会话还没有请求记录——发一条消息后再查看）';
      body.textContent = '';
      return;
    }
    const t = new Date(l.ts);
    meta.innerHTML = `<b>${l.chatId}</b> · ${t.toLocaleString()} · 历史 ${l.historyCount} 条 · 工具：${(l.tools || []).join('、') || '无'}`;
    body.textContent = l.system;
  } catch (e) {
    meta.textContent = '读取失败：' + e.message;
  }
});
document.getElementById('prompt-close').addEventListener('click', () => {
  document.getElementById('prompt-modal').classList.add('hidden');
});

// ---------- 界面操作：视角切换 / 换装（记账，可导出） ----------
const viewSelect = document.getElementById('view-select');
const viewCustom = document.getElementById('view-custom');
const viewBtn = document.getElementById('view-btn');
const viewNote = document.getElementById('view-note');
const wdChar = document.getElementById('wd-char');
const wdOutfit = document.getElementById('wd-outfit');
const wdDay = document.getElementById('wd-day');
const wdBtn = document.getElementById('wd-btn');
const wdNote = document.getElementById('wd-note');

// 恢复持久化的当前视角（localStorage，跨刷新）
App.opView = localStorage.getItem('mr-op-view') || '';
if (App.opView && [...viewSelect.options].some((o) => o.value === App.opView)) viewSelect.value = App.opView;

viewBtn.addEventListener('click', async () => {
  // 优先自定义输入；其次下拉选择
  const custom = viewCustom.value.trim();
  const v = custom || viewSelect.value;
  if (!v) { viewNote.textContent = '（选择默认视角 = 用户角色主观视角）'; viewNote.classList.remove('hidden'); return; }
  viewBtn.disabled = true;
  try {
    const r = await (await fetch('/api/op/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, view: v }),
    })).json();
    if (r.error) { viewNote.textContent = `✗ ${r.error}`; }
    else {
      App.opView = v;
      localStorage.setItem('mr-op-view', v);
      viewNote.textContent = `✓ ${r.note}`;
    }
  } catch (e) { viewNote.textContent = `✗ ${e.message}`; }
  viewNote.classList.remove('hidden');
  viewBtn.disabled = false;
  setTimeout(() => viewNote.classList.add('hidden'), 6000);
});

// 扩写按钮（胶囊开关）
const setExpand = (en) => els.expandBtn.classList.toggle('on', en);
if (localStorage.getItem('mr-op-expand') === '1') setExpand(true);
els.expandBtn.addEventListener('click', async () => {
  const en = !els.expandBtn.classList.contains('on');
  els.expandBtn.disabled = true;
  try {
    const r = await (await fetch('/api/op/expand', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, enabled: en }),
    })).json();
    if (r.error) { els.opNote.textContent = '✗ ' + r.error; }
    else { setExpand(en); localStorage.setItem('mr-op-expand', en ? '1' : '0'); els.opNote.textContent = '✓ ' + r.note; }
  } catch (e) { els.opNote.textContent = '✗ ' + e.message; }
  els.opNote.classList.remove('hidden');
  els.expandBtn.disabled = false;
  setTimeout(() => els.opNote.classList.add('hidden'), 6000);
});

// ⋯ 菜单切换
const moreToolsBtn = document.getElementById('more-tools-btn');
const moreToolsMenu = document.getElementById('more-tools-menu');
if (moreToolsBtn && moreToolsMenu) {
  moreToolsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    moreToolsMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!moreToolsMenu.contains(e.target) && e.target !== moreToolsBtn) {
      moreToolsMenu.classList.add('hidden');
    }
  });
}

// 工具桥：自由勾选工具（通用版 = 仅联网）
const toolNames = () => els.toolChips.filter((c) => c.classList.contains('on')).map((c) => c.dataset.tool);
const setTools = (names) => els.toolChips.forEach((c) => c.classList.toggle('on', names.includes(c.dataset.tool)));
try { setTools(JSON.parse(localStorage.getItem('mr-op-tools') || '[]')); } catch (e) { setTools([]); }
els.toolChips.forEach((chip) => {
  chip.addEventListener('click', async () => {
    chip.classList.toggle('on');
    const sel = toolNames();
    chip.disabled = true;
    try {
      const r = await (await fetch('/api/op/tools', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: App.chatId, tools: sel }),
      })).json();
      if (r.error) { chip.classList.toggle('on'); els.opNote.textContent = '✗ ' + r.error; }
      else {
        setTools(r.tools || []);
        localStorage.setItem('mr-op-tools', JSON.stringify(r.tools || []));
        els.opNote.textContent = '✓ ' + r.note;
      }
    } catch (e) { chip.classList.toggle('on'); els.opNote.textContent = '✗ ' + e.message; }
    els.opNote.classList.remove('hidden');
    chip.disabled = false;
    setTimeout(() => els.opNote.classList.add('hidden'), 6000);
  });
});

wdBtn.addEventListener('click', async () => {
  const ch = wdChar.value, outfit = wdOutfit.value.trim(), day = wdDay.value.trim();
  if (!outfit) { wdNote.textContent = '请填写着装描述'; wdNote.classList.remove('hidden'); return; }
  wdBtn.disabled = true;
  try {
    const r = await (await fetch('/api/op/wardrobe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, character: ch, outfit, worn: day }),
    })).json();
    wdNote.textContent = r.error ? `✗ ${r.error}` : `✓ ${r.note}`;
    if (!r.error) { wdOutfit.value = ''; wdDay.value = ''; loadCurrentWardrobe(); }
  } catch (e) { wdNote.textContent = `✗ ${e.message}`; }
  wdNote.classList.remove('hidden');
  wdBtn.disabled = false;
  setTimeout(() => wdNote.classList.add('hidden'), 8000);
});

// ---------- 会话统计 ----------
const statsBar = document.getElementById('stats-bar');
function fmtDur(sec) {
  if (!sec) return '0s';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
  if (m) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
function fmtTok(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
function fmtCost(n) {
  if (!n) return '0';
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}
async function loadStats() {
  try {
    const s = await (await fetch('/api/stats?chatId=' + encodeURIComponent(App.chatId))).json();
    const c = s.current, t = s.total, ch = s.chat;
    const chatTxt = ch
      ? `<b>${ch.turns}</b> 轮 · <b>${ch.calls}</b> 次调用 | LLM 总耗时 <b>${fmtDur(ch.llmSec)}</b> | 首 token 平均 <b>${(ch.firstTokenAvgMs / 1000).toFixed(1)}s</b> · <b>${ch.tokPerSec}</b> tok/s | 缓存命中 <b>${ch.cacheRate}%</b> | 输入 <b>${fmtTok(ch.tokensIn)}</b> · 输出 <b>${fmtTok(ch.tokensOut)}</b> tok`
      : `—`;
    // 费用（Task6）：每日仪表盘估算（PRICE_TABLE 每 1M token 单价；仅参考非账单）
    const daily = s.daily || [];
    const today = daily[daily.length - 1];
    const costTxt = `💰 费用：今日 <b>¥${fmtCost(today ? today.cost : 0)}</b> · 累计 <b>¥${fmtCost(s.totalCost)}</b>`;
    statsBar.innerHTML = `模型 <b>${s.model}</b> | 本对话 ${chatTxt} | 累计 <b>${c.turns}</b> 轮 · 缓存 <b>${c.cacheRate}%</b> · <b>${fmtTok(c.tokensIn + c.tokensOut)}</b> tok | 全部 <b>${t.turns}</b> 轮 · 缓存 <b>${t.cacheRate}%</b> · <b>${fmtTok(t.tokensIn + t.tokensOut)}</b> tok | ${costTxt}`;
  } catch (e) { /* 忽略 */ }
}

// ---------- 高峰时段提示条（官方直连渠道 + 高峰时间才生效） ----------
App.peakEligible = true;   // 端点是否为 DeepSeek 官方直连（峰谷定价渠道）
function isPeakHours(d) {
  const day = d.getDay();            // 0=周日 6=周六
  if (day === 0 || day === 6) return false;   // 2026-08-23 起周末全天为低谷价（不计峰谷）
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}
function updatePeakBanner() {
  const b = document.getElementById('peak-banner');
  if (b) b.classList.toggle('hidden', !(App.peakEligible && isPeakHours(new Date())));
}

// ---------- 新手导航（首次使用交互式导览） ----------
const TOUR_KEY = 'mr-tour-done-v1';
const tourSteps = [
  { title: '👋 欢迎', body: '这是通用多角色 RP 界面：多角色对话、头像渲染、世界设定自填、回合自动记账。首次使用带你看一圈～', target: null },
  { title: '🌍 世界设定', body: '在右侧「世界设定」里填写你的世界观 / 角色卡 / 规则。保存在本浏览器，对话时注入 system。', target: 'card-world' },
  { title: '📜 剧情记忆', body: '回合自动记账：时间线 / 物品栏 / 历史检索 / 情绪。可导出 markdown 自行归档。', target: 'card-tm' },
  { title: '✍️ 输入区', body: '底部输入区支持「角色名：台词」格式；可切换视角、开扩写、勾选联网工具。Enter 换行，Ctrl+Enter 发送。', target: 'input' },
  { title: '⚙ API 设置', body: '右上角「⚙ API」可配置端点 / 模型 / 上下文预算 / 辅助 API（后台任务独立端点）。', target: 'api-btn' },
];
App.tourIdx = 0;
function tourShow() {
  const overlay = document.getElementById('tour-overlay');
  const body = document.getElementById('tour-body');
  const dots = document.getElementById('tour-dots');
  const prev = document.getElementById('tour-prev');
  const next = document.getElementById('tour-next');
  const step = tourSteps[App.tourIdx];
  if (!step) return;
  body.textContent = step.body;
  dots.innerHTML = tourSteps.map((_, i) => `<span class="dot ${i === App.tourIdx ? 'on' : ''}"></span>`).join('');
  prev.classList.toggle('hidden', App.tourIdx === 0);
  next.textContent = App.tourIdx === tourSteps.length - 1 ? '开始使用' : '下一步';
  document.querySelectorAll('.tour-highlight').forEach((el) => el.classList.remove('tour-highlight'));
  if (step.target) {
    const el = document.getElementById(step.target);
    if (el) {
      el.classList.add('tour-highlight');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}
function tourDone() {
  localStorage.setItem(TOUR_KEY, '1');
  document.getElementById('tour-overlay').classList.add('hidden');
  document.querySelectorAll('.tour-highlight').forEach((el) => el.classList.remove('tour-highlight'));
}
document.getElementById('tour-next').addEventListener('click', () => {
  if (App.tourIdx < tourSteps.length - 1) { App.tourIdx += 1; tourShow(); } else tourDone();
});
document.getElementById('tour-prev').addEventListener('click', () => {
  if (App.tourIdx > 0) { App.tourIdx -= 1; tourShow(); }
});
document.getElementById('tour-skip').addEventListener('click', tourDone);
function maybeStartTour() {
  if (localStorage.getItem(TOUR_KEY)) return;
  App.tourIdx = 0;
  document.getElementById('tour-overlay').classList.remove('hidden');
  tourShow();
}

// ---------- 事件 ----------
els.send.addEventListener('click', send);
// Token 预估
function estimateTokens(text) { return Math.ceil(String(text||'').length * 0.67); }
function updateTokenEstimate() {
  const el = document.getElementById('token-estimate');
  if (!el) return;
  const inputTokens = estimateTokens(els.input.value);
  const sysTokens = estimateTokens(App.lastSystemPrompt || '');
  const histTokens = App.history.reduce((s, m) => s + estimateTokens(m.content), 0);
  const contextTokens = sysTokens + histTokens;
  const maxCtx = App.currentMaxContext || 1048576;
  const remaining = maxCtx - contextTokens;
  const pct = maxCtx > 0 ? (contextTokens / maxCtx * 100) : 0;
  el.innerHTML = `<span>约 ${inputTokens.toLocaleString()} tok</span> · <span>上下文 ${(contextTokens/1000).toFixed(1)}K/${(maxCtx/1000).toFixed(0)}K</span> · <span style="color:${pct>80?'#f0a3a3':pct>60?'#f0d080':'var(--muted,#888)'}">余量 ${(remaining/1000).toFixed(1)}K</span>`;
}
App.lastSystemPrompt = '';
App.currentMaxContext = 1048576;
els.input.addEventListener('input', updateTokenEstimate);
// 变量提示按钮
document.getElementById('var-hint-btn')?.addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:420px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">变量模板</div><table style="width:100%;font-size:13px;border-collapse:collapse"><tr style="border-bottom:1px solid var(--border,#3a4163)"><td style="padding:6px;font-weight:500">变量</td><td style="padding:6px;font-weight:500">替换为</td></tr><tr><td style="padding:6px;font-family:monospace">{{user}}</td><td style="padding:6px">用户名</td></tr><tr><td style="padding:6px;font-family:monospace">{{char}}</td><td style="padding:6px">当前角色名</td></tr><tr><td style="padding:6px;font-family:monospace">{{time}}</td><td style="padding:6px">当前时间</td></tr><tr><td style="padding:6px;font-family:monospace">{{date}}</td><td style="padding:6px">当前日期</td></tr><tr><td style="padding:6px;font-family:monospace">{{chatId}}</td><td style="padding:6px">会话 ID</td></tr><tr><td style="padding:6px;font-family:monospace">{{turnCount}}</td><td style="padding:6px">消息数</td></tr><tr><td style="padding:6px;font-family:monospace">{{lastMessage}}</td><td style="padding:6px">最后用户消息</td></tr></table><div style="margin-top:16px;display:flex;justify-content:flex-end"><button id="var-close" class="btn-sm" style="padding:6px 16px">关闭</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#var-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});
// 剧情建议
document.getElementById('suggestions-btn')?.addEventListener('click', async () => {
  if (!App.chatId) { alert('请先创建或打开一个对话'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px;max-height:80vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">✨ 剧情走向建议</div><div id="suggestions-loading" style="text-align:center;padding:20px;color:var(--muted,#888)">正在构思剧情走向...</div><div id="suggestions-list" style="display:flex;flex-direction:column;gap:10px"></div><div style="margin-top:16px;display:flex;justify-content:flex-end"><button id="sg-close" class="btn-sm" style="padding:6px 16px">关闭</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#sg-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  try {
    const r = await fetch('/api/suggestions/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: App.chatId }) });
    const d = await r.json();
    const loading = overlay.querySelector('#suggestions-loading');
    const list = overlay.querySelector('#suggestions-list');
    if (loading) loading.remove();
    if (d.error) { list.textContent = '生成失败：' + d.error; return; }
    if (!d.suggestions?.length) { list.textContent = '暂无建议'; return; }
    for (const sg of d.suggestions) {
      const card = document.createElement('div');
      card.style.cssText = 'padding:12px;border-radius:8px;background:var(--bg2,#f5f5f5);border:1px solid var(--border,#3a4163)';
      const safeTitle = escapeHtml(sg.title || '未命名');
      const safeMood = sg.mood ? '氛围：' + escapeHtml(sg.mood) : '';
      const safeDetail = escapeHtml(sg.detail || '');
      card.innerHTML = `<div style="font-weight:500;font-size:13px;margin-bottom:4px">${safeTitle}</div><div style="font-size:12px;color:var(--muted,#888);margin-bottom:6px">${safeMood}</div><div style="font-size:13px;display:none" class="sg-detail">${safeDetail}</div><div style="display:flex;gap:6px;margin-top:8px"><button class="btn-sm sg-expand" style="padding:4px 10px;font-size:11px">展开</button><button class="btn-sm sg-use" style="padding:4px 10px;font-size:11px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:4px">采用</button></div>`;
      card.querySelector('.sg-expand').onclick = () => { const det = card.querySelector('.sg-detail'); det.style.display = det.style.display === 'none' ? 'block' : 'none'; };
      card.querySelector('.sg-use').onclick = () => { els.input.value = (sg.detail || sg.title || ''); overlay.remove(); els.input.focus(); };
      list.appendChild(card);
    }
  } catch (e) { const loading = overlay.querySelector('#suggestions-loading'); if (loading) loading.textContent = '请求失败：' + e.message; }
});
// 历史搜索：搜索聊天历史（跨会话）
document.getElementById('recall-btn')?.addEventListener('click', async () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:550px;max-height:80vh;overflow-y:auto">
    <div style="font-size:15px;font-weight:500;margin-bottom:12px">🔍 历史搜索</div>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      <input id="recall-query" style="flex:1;padding:8px;border-radius:6px;background:var(--bg2,#232946);color:var(--text,#e8e6f0);border:1px solid var(--border,#3a4163)" placeholder="搜索聊天历史…" autofocus>
      <button id="recall-search" class="btn-sm" style="padding:8px 16px;background:var(--accent,#7F77DD);color:#fff;border-radius:6px;border:none;cursor:pointer">搜索</button>
    </div>
    <label style="font-size:12px;color:var(--muted,#888)"><input type="checkbox" id="recall-global"> 跨会话搜索（默认仅当前会话）</label>
    <div id="recall-results" style="margin-top:12px;font-size:12px"></div>
    <div style="margin-top:16px;display:flex;justify-content:flex-end"><button id="recall-close" class="btn-sm" style="padding:6px 16px">关闭</button></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#recall-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const doSearch = async () => {
    const query = overlay.querySelector('#recall-query').value.trim();
    if (!query) return;
    const global = overlay.querySelector('#recall-global').checked;
    const resBox = overlay.querySelector('#recall-results');
    resBox.textContent = '搜索中…';
    try {
      const r = await fetch('/api/memory/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, chatId: global ? '' : App.chatId, limit: 15 }) });
      const d = await r.json();
      if (d.error) { resBox.textContent = '错误：' + d.error; return; }
      if (!d.results?.length) { resBox.innerHTML = '<div style="color:var(--muted,#888);text-align:center;padding:12px">未找到相关记忆</div>'; return; }
      resBox.innerHTML = `<div style="color:var(--muted,#888);margin-bottom:8px">共 ${d.total} 条消息，找到 ${d.results.length} 条相关记忆</div>`;
      for (const item of d.results) {
        const card = document.createElement('div');
        card.style.cssText = 'padding:8px;margin-bottom:6px;border-radius:6px;background:var(--bg2,#1f2438);border:1px solid var(--border,#3a4163);cursor:pointer';
        const preview = item.content.length > 200 ? item.content.slice(0, 200) + '…' : item.content;
        card.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:var(--accent,#7F77DD);font-size:11px">${String(item.chatTitle || item.chatId).replace(/</g,'&lt;')}</span><span style="color:var(--muted,#888);font-size:11px">相关度 ${item.score.toFixed(2)}</span></div><div style="font-size:12px;white-space:pre-wrap;word-break:break-word">${preview.replace(/</g,'&lt;')}</div>`;
        card.onclick = () => { els.input.value = (els.input.value ? els.input.value + '\n' : '') + item.content.slice(0, 500); overlay.remove(); els.input.focus(); };
        resBox.appendChild(card);
      }
    } catch (e) { resBox.textContent = '搜索失败：' + e.message; }
  };
  overlay.querySelector('#recall-search').onclick = doSearch;
  overlay.querySelector('#recall-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
});
// 场景插图：AI 图片生成
document.getElementById('illustration-btn')?.addEventListener('click', () => { openIllustration(); });

// 插图弹窗（可传入 prefillText 预填场景描述；不传则自动提取最近一条对话）
function openIllustration(prefillText) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px;max-height:80vh;overflow-y:auto">
    <div style="font-size:15px;font-weight:500;margin-bottom:12px">🎨 场景插图</div>
    <label style="font-size:12px;color:var(--muted,#888)">场景描述（已自动提取最近对话，可修改）</label>
    <textarea id="ill-prompt" rows="3" style="width:100%;padding:8px;margin:4px 0 8px;border-radius:6px;background:var(--bg2,#232946);color:var(--text,#e8e6f0);border:1px solid var(--border,#3a4163);resize:vertical" placeholder="描述你想生成的场景…"></textarea>
    <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
      <button id="ill-auto" class="btn-sm" style="padding:4px 10px;margin-bottom:8px;font-size:12px">🔍 从对话提取</button>
      <button id="ill-enhance" class="btn-sm" style="padding:4px 10px;margin-bottom:8px;font-size:12px">✨ 提示词优化</button>
    </div>
    <label style="font-size:12px;color:var(--muted,#888)">风格</label>
    <select id="ill-style" style="width:100%;padding:6px;margin:4px 0 8px;border-radius:6px;background:var(--bg2,#232946);color:var(--text,#e8e6f0);border:1px solid var(--border,#3a4163)">
      <option value="">（跟随模型默认）</option>
      <option value="anime">动漫风格</option>
      <option value="realistic">写实风格</option>
      <option value="watercolor">水彩风格</option>
      <option value="sketch">素描风格</option>
    </select>
    <label style="font-size:12px;color:var(--muted,#888)">引擎</label>
    <select id="ill-engine" style="width:100%;padding:6px;margin:4px 0 8px;border-radius:6px;background:var(--bg2,#232946);color:var(--text,#e8e6f0);border:1px solid var(--border,#3a4163)">
      <option value="kolors">Kolors（免费）</option>
      <option value="zimage">Z-Image（¥0.30/张）</option>
      <option value="zturb">Z-Image-Turbo（¥0.10/张）</option>
      <option value="qwenimg">Qwen-Image（¥0.30/张）</option>
      <option value="ernie">ERNIE-Image（¥0.11/张）</option>
    </select>
    <label style="display:flex;align-items:center;gap:6px;margin:8px 0;font-size:12px;cursor:pointer;color:var(--muted,#888)">
      <input type="checkbox" id="ill-scenery-only" style="accent-color:var(--accent,#7F77DD)">
      🎭 纯场景（无人物）— 过滤人物，只出环境/背景
    </label>
    <div id="ill-result" style="margin-top:12px;text-align:center"></div>
    <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button id="ill-generate" class="btn-sm" style="padding:6px 16px;background:var(--accent,#7F77DD);color:#fff;border-radius:6px;border:none;cursor:pointer">生成</button>
      <button id="ill-config" class="btn-sm" style="padding:6px 16px">⚙️ 配置</button>
      <button id="ill-close" class="btn-sm" style="padding:6px 16px">关闭</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#ill-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  // 自动提取最近一条 AI 回复（非空文本）作为场景描述
  // 注意：消息文本在 .msg-wrap 内 .bubble；assistant wrap 无 .msg.user；.msg-text 实际不存在（勿用）
  const autoFillIll = () => {
    const promptBox = overlay.querySelector('#ill-prompt');
    if (!promptBox) { return; }
    if (prefillText) { promptBox.value = String(prefillText).slice(0, 300); return; }
    const wraps = Array.from(document.querySelectorAll('.msg-wrap'));
    const assistantWraps = wraps.filter(w => !w.querySelector('.msg.user'));
    for (let i = assistantWraps.length - 1; i >= 0; i--) {
      const t = (assistantWraps[i].querySelector('.bubble')?.textContent || '').trim();
      if (t) { promptBox.value = t.slice(0, 300); return; }
    }
    const anyBubble = [...document.querySelectorAll('.bubble')].reverse().map(b => (b.textContent||'').trim()).find(Boolean);
    if (anyBubble) promptBox.value = anyBubble.slice(0, 300);
  };
  autoFillIll();
  overlay.querySelector('#ill-auto').onclick = autoFillIll;
  // 提示词优化：把描述润色成英文生图提示词并回填
  overlay.querySelector('#ill-enhance').onclick = async () => {
    const promptBox = overlay.querySelector('#ill-prompt');
    const raw = promptBox.value.trim();
    if (!raw) { alert('请先输入或提取场景描述，再优化提示词'); return; }
    const style = overlay.querySelector('#ill-style').value;
    const btn = overlay.querySelector('#ill-enhance');
    const resBox = overlay.querySelector('#ill-result');
    const oldText = btn.textContent;
    btn.textContent = '优化中…';
    btn.disabled = true;
    try {
      const r = await fetch('/api/illustration/enhance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: raw, style }) });
      const d = await r.json();
      if (d.error) { resBox.innerHTML = `<div style="color:#f0a3a3;padding:12px">${safeHtml(d.error)}</div>`; return; }
      promptBox.value = d.enhanced;
      resBox.innerHTML = `<div style="color:#7fe0a9;padding:12px;font-size:12px">✨ 已优化（${d.enhanced.length} 字符），可直接生成或继续修改</div>`;
    } catch (e) { resBox.innerHTML = `<div style="color:#f0a3a3;padding:12px">优化失败：${safeHtml(e.message)}</div>`; }
    finally { btn.textContent = oldText; btn.disabled = false; }
  };
  // 风格 → 英文提示词片段（硅基流动对英文更稳）
  const styleToEn = (s) => {
    const map = { anime: ', anime style, cel shading, vibrant colors', realistic: ', photorealistic, cinematic lighting, high detail', watercolor: ', watercolor painting style, soft colors', sketch: ', pencil sketch, monochrome, line art' };
    return map[s] || '';
  };
  overlay.querySelector('#ill-generate').onclick = async () => {
    const prompt = overlay.querySelector('#ill-prompt').value.trim();
    if (!prompt) { alert('请输入场景描述'); return; }
    const style = overlay.querySelector('#ill-style').value;
    const engine = overlay.querySelector('#ill-engine').value;
    const sceneryOnly = overlay.querySelector('#ill-scenery-only')?.checked || false;
    const resBox = overlay.querySelector('#ill-result');
    resBox.textContent = '生成中，约 5-15 秒…';
    try {
      const fullPrompt = prompt + styleToEn(style);
      const r = await fetch('/api/illustration/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: fullPrompt, style, engine, chatId: App.chatId, sceneryOnly }) });
      const d = await r.json();
      if (d.error) {
        resBox.innerHTML = `<div style="color:#f0a3a3;padding:12px">${safeHtml(d.error)}</div>`;
        if (d.needConfig) resBox.innerHTML += '<div style="font-size:12px;color:var(--muted,#888);margin-top:8px">点击「配置」按钮设置图片生成 API Key（硅基流动）</div>';
        return;
      }
      if (d.image) {
        const isData = /^data:/.test(d.image);
        const src = isData ? d.image : (d.image.url || d.image);
        resBox.innerHTML = `<img src="${src}" style="max-width:100%;max-height:360px;border-radius:8px;display:block;margin:0 auto;image-rendering:auto" alt="场景插图"/>` +
          `<div style="color:#7fe0a9;padding:12px;font-size:12px">✅ 已生成（${safeHtml(d.label || d.model || '')}${d.price ? ' · ' + safeHtml(d.price) : ''}）</div>`;
      } else {
        resBox.innerHTML = `<div style="color:#7fe0a9;padding:12px">${safeHtml(d.message || '功能就绪')}</div>`;
      }
    } catch (e) { resBox.textContent = '请求失败：' + e.message; }
  };
  overlay.querySelector('#ill-config').onclick = async () => {
    const engine = prompt('引擎（kolors/schnell/dev）：', 'kolors');
    if (!engine) return;
    const apiKey = prompt('API Key（留空则用 models.json 里的硅基流动 key）：');
    const baseURL = prompt('Base URL（留空用默认 api.siliconflow.cn/v1）：', '');
    try {
      await fetch('/api/illustration/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine, apiKey, baseURL }) });
      alert('✅ 配置已保存');
    } catch (e) { alert('保存失败：' + e.message); }
  };
}
// 语音朗读：TTS 合成
document.getElementById('tts-btn')?.addEventListener('click', () => { openTts(); });

// 朗读指定文本（seq 为空时由调用方已传 text）
function openTts(text) {
  text = String(text || '').trim().slice(0, 2000);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:460px">
    <div style="font-size:15px;font-weight:500;margin-bottom:12px">🔊 语音朗读</div>
    <div style="font-size:12px;color:var(--muted,#888);margin-bottom:8px">将朗读以下文本（${text.length} 字）</div>
    <div style="font-size:13px;max-height:120px;overflow-y:auto;padding:8px;background:var(--bg2,#1f2438);border-radius:6px;margin-bottom:10px;white-space:pre-wrap;word-break:break-word">${safeHtml(text.slice(0, 300))}${text.length > 300 ? '…' : ''}</div>
    <label class="api-field">模型<select id="tts-model" style="width:100%">
      <option value="mimo-v2.5-tts">内置音色（7 种预设）</option>
      <option value="mimo-v2.5-tts-voicedesign">声线设计（文字描述生成声音）</option>
      <option value="mimo-v2.5-tts-voiceclone">声音克隆（参考音频复刻）</option>
    </select></label>
    <div id="tts-character-wrap" class="api-field">角色音色<select id="tts-character" style="width:100%">
      <option value="">（不绑定角色）</option>
      <option value="格蕾修（天行·绘星之卷）">格蕾修（天行·绘星之卷）</option>
      <option value="格蕾修（繁星·绘世之卷）">格蕾修（繁星·绘世之卷）</option>
      <option value="菲米莉丝">菲米莉丝</option>
      <option value="华">华</option>
      <option value="爱莉希雅">爱莉希雅</option>
    </select><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">选择角色后自动使用该角色的声音朗读</div></div>
    <div id="tts-voice-wrap" class="api-field">音色<select id="tts-voice" style="width:100%">
      <option value="mimo_default">mimo_default（默认）</option>
      <option value="default_zh">default_zh</option>
      <option value="default_en">default_en</option>
      <option value="Mia">Mia</option>
      <option value="Chloe">Chloe</option>
      <option value="Milo">Milo</option>
      <option value="Dean">Dean</option>
    </select></div>
    <div id="tts-style-wrap" class="hidden api-field">声音描述 / 风格指令<textarea id="tts-style" class="world-setting" rows="3" style="width:100%" placeholder="例：一位中年男性，低沉有磁性，像纪录片旁白解说员…"></textarea></div>
    <div id="tts-ref-wrap" class="hidden api-field">参考音频（mp3/wav，10-30 秒清晰人声）<input id="tts-ref" type="file" accept="audio/*,.mp3,.wav" style="width:100%"><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">上传后即作为克隆音色，可另填风格指令控制语气</div></div>
    <div id="tts-result" style="margin-top:8px;text-align:center"></div>
    <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button id="tts-play" class="btn-sm" style="padding:6px 16px;background:var(--accent,#7F77DD);color:#fff;border-radius:6px;border:none;cursor:pointer">▶ 朗读</button>
      <button id="tts-config" class="btn-sm" style="padding:6px 16px">⚙️ 配置</button>
      <button id="tts-close" class="btn-sm" style="padding:6px 16px">关闭</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  // 模型切换 → 显示对应输入区
  const ttsModelSel = overlay.querySelector('#tts-model');
  const voiceWrap = overlay.querySelector('#tts-voice-wrap');
  const styleWrap = overlay.querySelector('#tts-style-wrap');
  const refWrap = overlay.querySelector('#tts-ref-wrap');
  ttsModelSel.addEventListener('change', () => {
    const v = ttsModelSel.value;
    voiceWrap.classList.toggle('hidden', v !== 'mimo-v2.5-tts');
    styleWrap.classList.toggle('hidden', v === 'mimo-v2.5-tts');
    refWrap.classList.toggle('hidden', v !== 'mimo-v2.5-tts-voiceclone');
  });
  overlay.querySelector('#tts-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#tts-play').onclick = async () => {
    const resBox = overlay.querySelector('#tts-result');
    const model = ttsModelSel.value;
    const style = overlay.querySelector('#tts-style').value.trim();
    const voice = overlay.querySelector('#tts-voice').value;
    const character = overlay.querySelector('#tts-character').value;
    let referenceAudio = null;
    
    // 如果选择了角色且没有手动上传参考音频，服务端会自动使用角色绑定的参考音频
    if (model === 'mimo-v2.5-tts-voiceclone' && !character) {
      const file = overlay.querySelector('#tts-ref').files[0];
      if (!file) { resBox.innerHTML = '<div style="color:#f0a3a3;padding:8px">请先选择参考音频（mp3/wav）或选择角色</div>'; return; }
      if (file.size > 10 * 1024 * 1024) { resBox.innerHTML = '<div style="color:#f0a3a3;padding:8px">参考音频需小于 10MB</div>'; return; }
      const mime = file.type === 'audio/wav' || /\.wav$/i.test(file.name) ? 'audio/wav' : 'audio/mpeg';
      referenceAudio = { mime, data: await new Promise((ok, fail) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result).split(',')[1] || ''); rd.onerror = fail; rd.readAsDataURL(file); }) };
    }
    resBox.textContent = '合成中…';
    try {
      const r = await fetch('/api/tts/synthesize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, model, voice, style, referenceAudio, character }) });
      const d = await r.json();
      if (d.error) {
        resBox.innerHTML = `<div style="color:#f0a3a3;padding:8px">${safeHtml(d.error)}</div>`;
        if (d.needConfig) resBox.innerHTML += '<div style="font-size:12px;color:var(--muted,#888);margin-top:4px">点击「配置」按钮设置 TTS 引擎</div>';
        return;
      }
      if (d.audio) {
        // MiMo TTS 返回 base64 音频 → 直接播放
        const a = new Audio('data:audio/' + (d.format || 'mp3') + ';base64,' + d.audio);
        a.play().catch(() => {});
        resBox.innerHTML = `<div style="color:#7fe0a9;padding:8px">▶ ${safeHtml(d.message || '合成成功')}</div>`;
        return;
      }
      resBox.innerHTML = `<div style="color:#7fe0a9;padding:8px">${safeHtml(d.message || '朗读功能就绪')}</div>`;
    } catch (e) { resBox.textContent = '请求失败：' + e.message; }
  };
  overlay.querySelector('#tts-config').onclick = async () => {
    const engine = prompt('TTS 引擎（mimo/edge/openai，mimo=MiMo 官方免费）：', 'mimo');
    if (!engine) return;
    const apiKey = prompt('API Key（mimo 引擎可留空，自动读 WorkBuddy 配置）：', '');
    const voice = prompt('语音（mimo 内置：mimo_default / default_zh / default_en / Mia / Chloe / Milo / Dean）：', 'mimo_default');
    const rate = prompt('语速（0.5-2.0）：', '1.0');
    try {
      await fetch('/api/tts/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine, apiKey, voice, rate }) });
      alert('✅ TTS 配置已保存');
    } catch (e) { alert('保存失败：' + e.message); }
  };
}
els.input.addEventListener('keydown', (e) => {
  // Enter = 换行（textarea 默认行为）；Ctrl/Cmd+Enter = 发送
  // 输入法组合期间（isComposing/keyCode 229）不触发发送，避免发出缺最后一段组合文本的输入
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
});
// 图片粘贴（Task17）：剪贴板图片 → base64 → markdown 图片语法插入输入框（>1MB 拒绝）
els.input.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      // Limit to 1MB
      if (file.size > 1024 * 1024) { alert('图片过大（>1MB），请压缩后粘贴'); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result;
        // Insert markdown image syntax into input
        const cursor = els.input.selectionStart;
        const text = els.input.value;
        const imgTag = `![pasted-image](${base64})`;
        els.input.value = text.slice(0, cursor) + imgTag + text.slice(cursor);
        els.input.focus();
        // 视觉模型提示（Task17 增强）：服务端按模型判定——含 vision 的模型图片直传，否则降级 [图片]
        const sb = document.getElementById('stats-bar');
        if (sb) {
          const old = sb.textContent;
          sb.innerHTML = sb.innerHTML + ' <span style="color:#a78bfa">📷 图片已粘贴（当前模型支持视觉则直传，否则降级为占位符）</span>';
          setTimeout(() => { if (sb && sb.textContent !== old) sb.innerHTML = old; }, 4000);
        }
      };
      reader.readAsDataURL(file);
    }
  }
});
// 自动保存（Task9）：输入停顿 3s 自动落盘；关页前尽力保存
App.autoSaveTimer = null;
els.input.addEventListener('input', () => {
  clearTimeout(App.autoSaveTimer);
  App.autoSaveTimer = setTimeout(() => { if (App.history.length) saveChat(); }, 3000);
});
// Before unload: try to save（keepalive 确保页面卸载时请求仍发出；异步 saveChat 会随页面销毁丢失）
window.addEventListener('beforeunload', () => {
  if (!App.chatId || !App.history.length) return;
  const firstUser = App.history.find((m) => m.role === 'user');
  const title = App.chatTitle || (firstUser ? firstUser.content.slice(0, 24) : '新对话');
  try {
    fetch('/api/chats/' + App.chatId, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, messages: App.history }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* best effort */ }
});
// 全局快捷键：Ctrl+Shift+F 聚焦世界设定（通用版无检索框）
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault();
    if (worldInput) { worldInput.focus(); worldInput.select(); }
  }
});
// 移动端侧栏抽屉：汉堡按钮开 / 遮罩点击关（<768px 生效，桌面端无影响）
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const sidebarEl = document.getElementById('sidebar');
function toggleSidebar(open) {
  if (sidebarEl) sidebarEl.classList.toggle('open', open);
  if (sidebarOverlay) sidebarOverlay.classList.toggle('open', open);
}
if (sidebarToggle) sidebarToggle.addEventListener('click', () => toggleSidebar(!(sidebarEl && sidebarEl.classList.contains('open'))));
if (sidebarOverlay) sidebarOverlay.addEventListener('click', () => toggleSidebar(false));

// ---------- 手动附加资料（📎 临时注入，不进对话历史） ----------
els.manAttachBtn.addEventListener('click', () => {
  els.manAttachBox.classList.remove('hidden');
  els.manAttachInput.focus();
});
els.manAttachCancel.addEventListener('click', () => {
  els.manAttachBox.classList.add('hidden');
  els.manAttachInput.value = '';
});
els.manAttachOk.addEventListener('click', () => {
  const text = els.manAttachInput.value.trim();
  if (!text) return;
  App.pendingContext = text;
  els.manAttachBox.classList.add('hidden');
  els.manAttachInput.value = '';
  els.manAttachNote.classList.remove('hidden');
});

// ---------- 会话常驻设定（📌 每轮注入 system，防遗忘；按会话隔离） ----------
// Task15 多槽位：其他 / 背景 / 关系 / 规则（页签切换编辑，保存时整包提交）
const NOTE_SLOTS_UI = ['其他', '背景', '关系', '规则'];
App.noteSlotsData = {};      // 内存槽位数据
App.noteSlotsPristine = {};  // 打开/加载时的原始槽位快照（取消时整体还原，防页签暂存无法撤销）
App.currentNoteSlot = '其他';

function noteSlotTab(name) {
  return els.noteAttachBox.querySelector(`.note-slot-tab[data-slot="${name}"]`);
}
function switchNoteSlot(name) {
  App.currentNoteSlot = name;
  els.noteAttachInput.value = App.noteSlotsData[name] || '';
  NOTE_SLOTS_UI.forEach((k) => {
    const t = noteSlotTab(k);
    if (t) t.classList.toggle('active', k === name);
  });
}
async function loadSessionNote() {
  try {
    const r = await (await fetch('/api/op/note', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, get: true }),
    })).json();
    App.noteSlotsData = (r && r.slots && typeof r.slots === 'object') ? r.slots : {};
    App.noteSlotsPristine = JSON.parse(JSON.stringify(App.noteSlotsData));   // 快照：取消时还原到本次加载值
    const hasAny = NOTE_SLOTS_UI.some((k) => String(App.noteSlotsData[k] || '').trim());
    els.noteAttachBtn.textContent = hasAny
      ? '📌 会话常驻设定（已设置，点击查看/修改）'
      : '📌 会话常驻设定（每轮注入，防遗忘）';
    switchNoteSlot('其他');
  } catch (e) { /* 忽略 */ }
}
els.noteAttachBtn.addEventListener('click', () => {
  els.noteAttachBox.classList.toggle('hidden');
});
// 页签切换：暂存当前槽内容 → 加载目标槽
NOTE_SLOTS_UI.forEach((k) => {
  const tab = noteSlotTab(k);
  if (tab) tab.addEventListener('click', () => {
    App.noteSlotsData[App.currentNoteSlot] = els.noteAttachInput.value.trim();
    switchNoteSlot(k);
  });
});
els.noteAttachCancel.addEventListener('click', () => {
  App.noteSlotsData = JSON.parse(JSON.stringify(App.noteSlotsPristine));   // 整体还原到加载时快照（含切过页签的暂存）
  switchNoteSlot(App.currentNoteSlot);
  els.noteAttachBox.classList.add('hidden');
});
els.noteAttachOk.addEventListener('click', async () => {
  App.noteSlotsData[App.currentNoteSlot] = els.noteAttachInput.value.trim();   // 先同步当前槽
  try {
    const r = await (await fetch('/api/op/note', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, slots: App.noteSlotsData }),
    })).json();
    if (r && r.ok) {
      els.noteAttachBox.classList.add('hidden');
      els.noteAttachNote.classList.remove('hidden');
      setTimeout(() => els.noteAttachNote.classList.add('hidden'), 2500);
      loadSessionNote();
    }
  } catch (e) { /* 忽略 */ }
});

// ---------- 对话内搜索（🔍 搜索当前会话消息：输入即过滤 + 高亮 + 跳转） ----------
function initMsgSearch() {
  const chatInner = els.messages && els.messages.parentNode;
  if (!chatInner || chatInner.querySelector('.msg-search-bar')) return;   // 已初始化
  // 样式内联注入（两版通用，不依赖 style.css）
  if (!document.getElementById('msg-search-style')) {
    const st = document.createElement('style');
    st.id = 'msg-search-style';
    st.textContent = `
      .msg-search-bar{display:flex;align-items:center;gap:8px;padding:4px 10px;background:var(--card,#232946);border:1px solid var(--border,#3a4163);border-radius:10px;margin:6px 10px 2px;}
      .msg-search-bar.hidden{display:none;}
      .msg-search-toggle{background:var(--card,#232946);border:1px solid var(--border,#3a4163);color:var(--muted,#9aa0c0);border-radius:6px;padding:2px 10px;font-size:13px;cursor:pointer;flex:none;opacity:.75;}
      .msg-search-toggle:hover{opacity:1;color:var(--accent,#a78bfa);border-color:var(--accent,#a78bfa);}
      .msg-search-inputs{display:flex;align-items:center;gap:8px;flex:1;min-width:0;}
      .msg-search-inputs.hidden{display:none;}
      .msg-search-bar input{flex:1;min-width:0;background:var(--bg2,#1f2438);color:var(--text,#e8e6f0);border:1px solid var(--border,#3a4163);border-radius:6px;padding:5px 9px;font-size:13px;outline:none;}
      .msg-search-bar input:focus{border-color:var(--accent,#a78bfa);}
      .msg-search-info{color:var(--muted,#9aa0c0);font-size:12px;white-space:nowrap;}
      .msg-search-bar button{background:var(--card,#232946);border:1px solid var(--border,#3a4163);color:var(--muted,#9aa0c0);border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;flex:none;}
      .msg-search-bar button:hover{color:var(--accent,#a78bfa);border-color:var(--accent,#a78bfa);}
      .msg-wrap.msg-search-hit{outline:2px solid var(--accent,#a78bfa);outline-offset:-2px;border-radius:10px;}
    `;
    document.head.appendChild(st);
  }
  const toggle = document.createElement('button');
  toggle.className = 'msg-search-toggle';
  toggle.textContent = '🔍';
  toggle.title = '展开/收起搜索';
  const bar = document.createElement('div');
  bar.className = 'msg-search-bar';
  const inputs = document.createElement('div');
  inputs.className = 'msg-search-inputs hidden';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = '搜索对话内容…（Enter = 下一处，Esc = 关闭）';
  const info = document.createElement('span');
  info.className = 'msg-search-info';
  const close = document.createElement('button');
  close.textContent = '✕';
  close.title = '关闭搜索';
  inputs.appendChild(input);
  inputs.appendChild(info);
  inputs.appendChild(close);
  bar.appendChild(toggle);
  bar.appendChild(inputs);
  chatInner.insertBefore(bar, els.messages);
  if (getComputedStyle(chatInner).position === 'static') chatInner.style.position = 'relative';

  let matches = [];
  let curIdx = -1;
  const clearHl = () => {
    document.querySelectorAll('.msg-wrap.msg-search-hit').forEach((el) => el.classList.remove('msg-search-hit'));
  };
  const closeSearch = () => {
    inputs.classList.add('hidden');
    input.value = '';
    info.textContent = '';
    matches = [];
    curIdx = -1;
    clearHl();
  };
  const jump = (dir) => {
    if (!matches.length) return;
    curIdx = (curIdx + dir + matches.length) % matches.length;
    clearHl();
    const el = matches[curIdx];
    el.classList.add('msg-search-hit');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    info.textContent = `${curIdx + 1} / ${matches.length}`;
  };
  const runSearch = () => {
    const q = input.value.trim().toLowerCase();
    clearHl();
    matches = [];
    curIdx = -1;
    if (!q) { info.textContent = ''; return; }
    // 只匹配气泡文本（不含操作按钮符号）
    matches = Array.from(els.messages.querySelectorAll('.msg-wrap')).filter((w) =>
      Array.from(w.querySelectorAll('.bubble')).some((b) => (b.textContent || '').toLowerCase().includes(q))
    );
    info.textContent = matches.length ? `匹配 ${matches.length} 条` : '无匹配';
    if (matches.length) jump(1);
  };
  toggle.addEventListener('click', () => {
    const isOpen = !inputs.classList.contains('hidden');
    if (isOpen) closeSearch();
    else {
      inputs.classList.remove('hidden');
      input.focus();
      if (input.value.trim()) runSearch();
    }
  });
  close.addEventListener('click', closeSearch);
  input.addEventListener('input', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jump(1); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
  });
}

// ---------- 对话配置档管理 UI ----------
async function loadChatProfileManage() {
  await loadChatProfiles();
  const box = document.getElementById('cp-manage-list');
  if (!box) return;
  box.innerHTML = '';
  const profiles = App.chatProfilesCache;
  const ids = Object.keys(profiles);
  if (!ids.length) { box.textContent = '（暂无配置档）'; return; }
  for (const id of ids) {
    const p = profiles[id];
    const isCurrent = id === App.currentChatProfileId;
    const d = document.createElement('div');
    d.className = 'cp-item';
    d.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;border-left:4px solid ${p.color||'#639922'};background:var(--bg2,#f5f5f5);margin-bottom:6px;${isCurrent?'border:1px solid var(--accent,#a78bfa)':''}`;
    d.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${p.label||id}${isCurrent?' <span style="color:var(--accent,#a78bfa);font-size:11px">← 当前会话</span>':''}</div>${p.prefix?'<div style="font-size:11px;color:var(--muted,#888);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">'+p.prefix+'</div>':''}</div>${!isCurrent?'<button class="head-btn cp-apply-btn" data-id="'+id+'" style="padding:2px 8px;font-size:11px" title="应用到当前会话（改绑定）">🔗 应用</button>':''}<button class="head-btn cp-edit-btn" data-id="${id}" style="padding:2px 8px;font-size:11px">编辑</button>${p.isDefault?'':'<button class="head-btn cp-del-btn" data-id="'+id+'" style="padding:2px 8px;font-size:11px;color:#f0a3a3">删</button>'}`;
    box.appendChild(d);
  }
  // 应用按钮：把配置档应用到当前会话（改绑定）
  box.querySelectorAll('.cp-apply-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cid = App.chatId;
      if (!cid) { alert('请先打开一个会话'); return; }
      if (!confirm(`将配置档「${btn.dataset.id}」应用到当前会话？`)) return;
      try {
        const r = await fetch('/api/chat-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply', id: btn.dataset.id, profile: { chatId: cid } }) });
        const d = await r.json();
        if (d.ok) { App.currentChatProfileId = btn.dataset.id; loadChatProfileManage(); loadChatList(); alert('已应用：当前会话改用「' + btn.dataset.id + '」配置档'); }
        else alert('应用失败：' + (d.error || '未知错误'));
      } catch (e) { alert('应用失败：' + e.message); }
    });
  });
  box.querySelectorAll('.cp-edit-btn').forEach(btn => btn.addEventListener('click', () => editChatProfile(btn.dataset.id)));
  box.querySelectorAll('.cp-del-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`确认删除配置档「${btn.dataset.id}」？`)) return;
    await fetch('/api/chat-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: btn.dataset.id }) });
    loadChatProfileManage();
  }));
}
function editChatProfile(id) {
  const p = App.chatProfilesCache[id] || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">编辑配置档：${id}</div><div style="font-size:12px;color:var(--muted,#888);margin-bottom:10px">💡 配置档只负责「切换标记 + 首条模板」；排除项（【排除当前状态】等）统一写在会话常驻设定里。</div><label class="api-field">显示名称<input id="ep-label" type="text" value="${p.label||id}" style="width:100%"></label><label class="api-field">颜色<input id="ep-color" type="color" value="${p.color||'#639922'}"></label><label class="api-field">首条消息模板路径<input id="ep-firstmsg" type="text" value="${p.firstMsg||''}" placeholder="文件路径" style="width:100%"></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="ep-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="ep-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#ep-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#ep-save').onclick = async () => {
    await fetch('/api/chat-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', id, profile: { label: overlay.querySelector('#ep-label').value.trim().slice(0,40), color: overlay.querySelector('#ep-color').value, firstMsg: overlay.querySelector('#ep-firstmsg').value.trim(), isDefault: p.isDefault||false } }) });
    overlay.remove(); loadChatProfileManage();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
document.getElementById('cp-add-btn')?.addEventListener('click', () => { const id = prompt('配置档 ID：'); if (id?.trim()) editChatProfile(id.trim()); });
loadChatProfileManage();

// ---------- NPC 档案管理 UI ----------
async function loadNpcProfiles() {
  const box = document.getElementById('npc-list');
  if (!box) return;
  try {
    const r = await fetch('/api/npc-profiles'); const d = await r.json();
    box.innerHTML = '';
    if (!d.profiles?.length) { box.textContent = '（暂无角色档案）'; return; }
    for (const p of d.profiles) {
      const el = document.createElement('div');
      el.className = 'cp-item';
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg2,#f5f5f5);margin-bottom:6px';
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${p.name}</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${[p.personality,p.appearance?.slice(0,30)].filter(Boolean).join(' · ')||'暂无描述'}</div></div><button class="head-btn npc-export-btn" data-name="${p.name}" style="padding:2px 8px;font-size:11px" title="导出为酒馆角色卡 PNG">📤</button><button class="head-btn npc-edit-btn" data-name="${p.name}" style="padding:2px 8px;font-size:11px">编辑</button><button class="head-btn npc-del-btn" data-name="${p.name}" style="padding:2px 8px;font-size:11px;color:#f0a3a3">删</button>`;
      box.appendChild(el);
    }
    box.querySelectorAll('.npc-edit-btn').forEach(btn => btn.addEventListener('click', () => editNpcProfile(btn.dataset.name)));
    box.querySelectorAll('.npc-del-btn').forEach(btn => btn.addEventListener('click', async () => { if (!confirm(`确认删除「${btn.dataset.name}」？`)) return; await fetch('/api/npc-profiles/'+encodeURIComponent(btn.dataset.name),{method:'DELETE'}); loadNpcProfiles(); }));
    box.querySelectorAll('.npc-export-btn').forEach(btn => btn.addEventListener('click', () => exportNpcCard(btn.dataset.name)));
  } catch (e) { box.textContent = '加载失败'; }
}
async function editNpcProfile(name) {
  let profile = { name, aliases: [], appearance: '', personality: '', age: '', ageNote: '', relationships: {}, firstAppearance: '', notes: '' };
  if (name) { try { const r = await fetch('/api/npc-profiles/'+encodeURIComponent(name)); const d = await r.json(); if (d.profile) profile = d.profile; } catch (e) { /* 新建 */ } }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px;max-height:85vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${name?'编辑':'新建'}角色档案</div><label class="api-field">名称<input id="np-name" type="text" value="${profile.name}" style="width:100%"></label><label class="api-field">外观<textarea id="np-appearance" class="world-setting" rows="2" style="width:100%">${profile.appearance||''}</textarea></label><label class="api-field">性格<textarea id="np-personality" class="world-setting" rows="2" style="width:100%">${profile.personality||''}</textarea></label><label class="api-field">关系（JSON）<textarea id="np-rel" class="world-setting" rows="2" style="width:100%">${JSON.stringify(profile.relationships||{},null,2)}</textarea></label><label class="api-field">备注<textarea id="np-notes" class="world-setting" rows="2" style="width:100%">${profile.notes||''}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="np-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="np-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#np-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#np-save').onclick = async () => {
    let rels = {}; try { rels = JSON.parse(overlay.querySelector('#np-rel').value||'{}'); } catch(e) {}
    await fetch('/api/npc-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: overlay.querySelector('#np-name').value.trim().slice(0,40), appearance: overlay.querySelector('#np-appearance').value, personality: overlay.querySelector('#np-personality').value, relationships: rels, notes: overlay.querySelector('#np-notes').value }) });
    overlay.remove(); loadNpcProfiles();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
document.getElementById('npc-add-btn')?.addEventListener('click', () => editNpcProfile(null));
// 卡片交换：从酒馆角色卡 PNG 导入
document.getElementById('card-import-btn')?.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.png';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const r = await fetch('/api/cards/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ imageData: reader.result }) });
        const d = await r.json();
        if (d.error) { alert('导入失败：' + d.error); return; }
        alert(`✅ 导入成功：${d.profile.name}\n已保存为角色档案`);
        loadNpcProfiles();
      } catch (e) { alert('请求失败：' + e.message); }
    };
    reader.readAsDataURL(file);
  };
  input.click();
});
function exportNpcCard(name) {
  const a = document.createElement('a');
  a.href = `/api/cards/export/${encodeURIComponent(name)}`;
  a.download = `${name}.png`;
  a.click();
}
loadNpcProfiles();

// ---------- 场景档案管理 UI ----------
async function loadSceneProfiles() {
  const box = document.getElementById('scene-list');
  if (!box) return;
  try {
    const r = await fetch('/api/scenes'); const d = await r.json();
    box.innerHTML = '';
    if (!d.scenes?.length) { box.textContent = '（暂无场景档案）'; return; }
    for (const s of d.scenes) {
      const el = document.createElement('div');
      el.className = 'cp-item';
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg2,#f5f5f5);margin-bottom:6px';
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${s.name}</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${s.location?s.location+' · ':''}${s.physicalFeatures?.length||0} 个特征</div></div><button class="head-btn scene-edit-btn" data-name="${s.name}" style="padding:2px 8px;font-size:11px">编辑</button><button class="head-btn scene-del-btn" data-name="${s.name}" style="padding:2px 8px;font-size:11px;color:#f0a3a3">删</button>`;
      box.appendChild(el);
    }
    box.querySelectorAll('.scene-edit-btn').forEach(btn => btn.addEventListener('click', () => editSceneProfile(btn.dataset.name)));
    box.querySelectorAll('.scene-del-btn').forEach(btn => btn.addEventListener('click', async () => { if (!confirm(`确认删除「${btn.dataset.name}」？`)) return; await fetch('/api/scenes/'+encodeURIComponent(btn.dataset.name),{method:'DELETE'}); loadSceneProfiles(); }));
  } catch (e) { box.textContent = '加载失败'; }
}
async function editSceneProfile(name) {
  let scene = { name, location: '', physicalFeatures: [], atmosphere: '', notes: '' };
  if (name) { try { const r = await fetch('/api/scenes/'+encodeURIComponent(name)); const d = await r.json(); if (d.scene) scene = d.scene; } catch (e) { /* 新建 */ } }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px;max-height:85vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${name?'编辑':'新建'}场景档案</div><label class="api-field">名称<input id="sp-name" type="text" value="${scene.name}" style="width:100%"></label><label class="api-field">位置<input id="sp-location" type="text" value="${scene.location||''}" style="width:100%"></label><label class="api-field">物理特征（每行一条）<textarea id="sp-features" class="world-setting" rows="5" style="width:100%">${(scene.physicalFeatures||[]).join('\n')}</textarea></label><label class="api-field">氛围<textarea id="sp-atmosphere" class="world-setting" rows="2" style="width:100%">${scene.atmosphere||''}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="sp-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="sp-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#sp-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#sp-save').onclick = async () => {
    await fetch('/api/scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: overlay.querySelector('#sp-name').value.trim().slice(0,40), location: overlay.querySelector('#sp-location').value.trim(), physicalFeatures: overlay.querySelector('#sp-features').value.split('\n').map(s=>s.trim()).filter(Boolean), atmosphere: overlay.querySelector('#sp-atmosphere').value }) });
    overlay.remove(); loadSceneProfiles();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
document.getElementById('scene-add-btn')?.addEventListener('click', () => editSceneProfile(null));
loadSceneProfiles();

// ---------- 表情系统管理 UI ----------
App.expressionsCache = {};
App.expressionConfigCache = { emotionMap: {}, enableAutoSwitch: true };
// 主要角色（预置，无表情目录也可选——选择后自动创建目录）
const EXPR_PRIMARY_CHARS = ['格蕾修', '菲米莉丝', 'rabbit'];
async function loadExpressions() {
  try {
    const r = await fetch('/api/expressions'); const d = await r.json();
    App.expressionsCache = d.expressions || {};
    App.expressionConfigCache = d.config || { emotionMap: {}, enableAutoSwitch: true };
    const dropdown = document.getElementById('expr-char-dropdown');
    if (dropdown) {
      const chars = Array.from(new Set([...EXPR_PRIMARY_CHARS, ...Object.keys(App.expressionsCache)]));
      dropdown.innerHTML = chars.map(c => `<option value="${safeHtml(c)}">${safeHtml(c)}</option>`).join('') || '<option value="">暂无角色</option>';
      renderExpressionGrid(chars[0] || '');
    }
  } catch (e) { /* 忽略 */ }
}
function renderExpressionGrid(charName) {
  const grid = document.getElementById('expr-grid');
  if (!grid) return;
  const exprs = App.expressionsCache[charName] || [];
  grid.innerHTML = '';
  if (!exprs.length) { grid.textContent = '暂无表情'; return; }
  for (const expr of exprs) {
    const el = document.createElement('div');
    el.style.cssText = 'position:relative;border-radius:6px;overflow:hidden;aspect-ratio:1;background:var(--bg2,#232946)';
    el.innerHTML = `<img src="${expr.url}" alt="${expr.name}" style="width:100%;height:100%;object-fit:cover"><div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;padding:2px 4px;text-align:center">${expr.name}</div><button class="head-btn expr-del-btn" data-char="${encodeURIComponent(charName)}" data-file="${encodeURIComponent(expr.file)}" title="删除此表情" style="position:absolute;top:2px;right:2px;padding:0 6px;font-size:11px;background:rgba(0,0,0,0.6);color:#f0a3a3;border:1px solid rgba(240,163,163,0.4);border-radius:4px;display:none">✕</button>`;
    el.addEventListener('mouseenter', () => { const b = el.querySelector('.expr-del-btn'); if (b) b.style.display = ''; });
    el.addEventListener('mouseleave', () => { const b = el.querySelector('.expr-del-btn'); if (b) b.style.display = 'none'; });
    grid.appendChild(el);
  }
  grid.querySelectorAll('.expr-del-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const char = decodeURIComponent(btn.dataset.char);
      const file = decodeURIComponent(btn.dataset.file);
      if (!confirm(`删除表情「${file}」？`)) return;
      try {
        const r = await fetch(`/api/expressions/${encodeURIComponent(char)}?name=${encodeURIComponent(file)}`, { method: 'DELETE' });
        const d = await r.json();
        if (d.ok) loadExpressions(); else alert('删除失败：' + (d.error || '未知错误'));
      } catch (err) { alert('删除失败：' + err.message); }
    });
  });
}
document.getElementById('expr-char-dropdown')?.addEventListener('change', (e) => renderExpressionGrid(e.target.value));
document.getElementById('expr-upload-btn')?.addEventListener('click', () => {
  const charName = document.getElementById('expr-char-dropdown')?.value;
  if (!charName) { alert('请先选择角色'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">添加表情到「${charName}」</div><label class="api-field">情绪名称<input id="exp-name" type="text" placeholder="开心" style="width:100%"></label><label class="api-field">图片<input id="exp-file" type="file" accept="image/*" style="width:100%"></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="exp-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="exp-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">上传</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#exp-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#exp-save').onclick = async () => {
    const name = overlay.querySelector('#exp-name').value.trim();
    const file = overlay.querySelector('#exp-file').files[0];
    if (!name || !file) { alert('请填写名称并选择图片'); return; }
    const reader = new FileReader();
    reader.onload = async () => { await fetch('/api/expressions/'+encodeURIComponent(charName), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name,imageData:reader.result}) }); overlay.remove(); loadExpressions(); };
    reader.readAsDataURL(file);
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});
loadExpressions();

// ---------- 输出过滤器管理 UI ----------
async function loadRegexRulesUI() {
  const box = document.getElementById('regex-rules-list');
  if (!box) return;
  try {
    const r = await fetch('/api/regex-rules'); const d = await r.json();
    box.innerHTML = '';
    if (!d.rules?.length) { box.textContent = '（暂无规则）'; return; }
    for (const rule of d.rules) {
      const el = document.createElement('div');
      el.className = 'cp-item';
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg2,#f5f5f5);margin-bottom:6px';
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${rule.name||rule.id}</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px;font-family:monospace">${rule.pattern}</div></div><label style="font-size:11px"><input type="checkbox" class="regex-toggle" data-id="${rule.id}" ${rule.enabled?'checked':''}> 启用</label><button class="head-btn regex-edit-btn" data-id="${rule.id}" style="padding:2px 8px;font-size:11px">编辑</button><button class="head-btn regex-del-btn" data-id="${rule.id}" style="padding:2px 8px;font-size:11px;color:#f0a3a3">删</button>`;
      box.appendChild(el);
    }
    box.querySelectorAll('.regex-toggle').forEach(cb => cb.addEventListener('change', async () => { const rule = d.rules.find(r => r.id === cb.dataset.id); if (rule) { rule.enabled = cb.checked; await fetch('/api/regex-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', rule }) }); loadRegexRules(); } }));
    box.querySelectorAll('.regex-edit-btn').forEach(btn => btn.addEventListener('click', () => editRegexRule(d.rules.find(r => r.id === btn.dataset.id))));
    box.querySelectorAll('.regex-del-btn').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('确认删除？')) return; await fetch('/api/regex-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', rule: { id: btn.dataset.id } }) }); loadRegexRulesUI(); loadRegexRules(); }));
  } catch (e) { box.textContent = '加载失败'; }
}
function editRegexRule(rule) {
  if (!rule) rule = { id: 'rule_' + Date.now(), name: '', pattern: '', replacement: '', flags: 'g', enabled: true };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">编辑过滤规则</div><label class="api-field">名称<input id="rr-name" type="text" value="${rule.name||''}" style="width:100%"></label><label class="api-field">正则表达式<input id="rr-pattern" type="text" value="${rule.pattern||''}" style="width:100%;font-family:monospace"></label><label class="api-field">替换为<input id="rr-replacement" type="text" value="${rule.replacement||''}" style="width:100%"></label><label class="api-field">标志<input id="rr-flags" type="text" value="${rule.flags||'g'}" style="width:80px"></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="rr-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="rr-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#rr-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#rr-save').onclick = async () => {
    await fetch('/api/regex-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', rule: { id: rule.id, name: overlay.querySelector('#rr-name').value.trim(), pattern: overlay.querySelector('#rr-pattern').value, replacement: overlay.querySelector('#rr-replacement').value, flags: overlay.querySelector('#rr-flags').value, enabled: rule.enabled !== false } }) });
    overlay.remove(); loadRegexRulesUI(); loadRegexRules();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
document.getElementById('regex-add-btn')?.addEventListener('click', () => editRegexRule(null));
document.getElementById('regex-test-btn')?.addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">测试过滤规则</div><label class="api-field">正则表达式<input id="rt-pattern" type="text" style="width:100%;font-family:monospace"></label><label class="api-field">替换为<input id="rt-replacement" type="text" style="width:100%"></label><label class="api-field">测试文本<textarea id="rt-text" class="world-setting" rows="4" style="width:100%"></textarea></label><div id="rt-result" style="margin-top:8px;padding:8px;background:var(--bg2,#f5f5f5);border-radius:6px;font-size:13px;min-height:40px"></div><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="rt-close" class="btn-sm" style="padding:6px 16px">关闭</button><button id="rt-run" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">测试</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#rt-close').onclick = () => overlay.remove();
  overlay.querySelector('#rt-run').onclick = async () => {
    const r = await fetch('/api/regex-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test', rule: { pattern: overlay.querySelector('#rt-pattern').value, replacement: overlay.querySelector('#rt-replacement').value, testText: overlay.querySelector('#rt-text').value } }) });
    const d = await r.json();
    overlay.querySelector('#rt-result').textContent = d.result || d.error || '无结果';
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});
loadRegexRulesUI();

// ---------- 设定触发器管理 UI ----------
App.lorebookEntriesCache = {};
App.lorebookSettingsCache = { enabled: true, tokenBudget: 'auto', maxBudget: 10000, budgetRatio: 0.1 };
async function loadLorebookUI() {
  const box = document.getElementById('lorebook-list');
  if (!box) return;
  try {
    const r = await fetch('/api/lorebook'); const d = await r.json();
    App.lorebookEntriesCache = d.entries || {}; App.lorebookSettingsCache = d.settings || {};
    renderLorebookList();
  } catch (e) { box.textContent = '加载失败'; }
}
function renderLorebookList() {
  const box = document.getElementById('lorebook-list');
  if (!box) return;
  const search = (document.getElementById('lb-search')?.value || '').trim().toLowerCase();
  box.innerHTML = '';
  const allEntries = Object.entries(App.lorebookEntriesCache);
  if (!allEntries.length) { box.textContent = '（暂无条目）'; return; }
  const filtered = search
    ? allEntries.filter(([, e]) => (e.name || '').toLowerCase().includes(search) || (e.keywords || []).some(k => k.toLowerCase().includes(search)))
    : allEntries;
  if (!filtered.length) { box.textContent = '（无匹配条目）'; return; }
  for (const [id, entry] of filtered.sort(([, a], [, b]) => (b.priority || 0) - (a.priority || 0))) {
    const el = document.createElement('div');
    el.className = 'cp-item';
    el.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:var(--bg2,#f5f5f5);margin-bottom:4px;font-size:12px';
    const kws = (entry.keywords || []).slice(0, 3).join(', ');
    el.innerHTML = `<div style="flex:1;min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(entry.name||id)}${entry.constant?' <span style="color:var(--accent,#a78bfa)">[常驻]</span>':''}</div><div style="font-size:11px;color:var(--muted,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(kws||'无关键词')}</div></div><label style="font-size:11px;flex:none"><input type="checkbox" class="lb-toggle" data-id="${escapeHtml(id)}" ${entry.enabled!==false?'checked':''}> 启用</label><button class="head-btn lb-edit-btn" data-id="${escapeHtml(id)}" style="padding:2px 6px;font-size:11px;flex:none">编辑</button><button class="head-btn lb-del-btn" data-id="${escapeHtml(id)}" style="padding:2px 6px;font-size:11px;color:#f0a3a3;flex:none">删</button>`;
    box.appendChild(el);
  }
  box.querySelectorAll('.lb-toggle').forEach(cb => cb.addEventListener('change', async () => { const e = App.lorebookEntriesCache[cb.dataset.id]; if (e) { e.enabled = cb.checked; await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', id: cb.dataset.id, entry: e }) }); } }));
  box.querySelectorAll('.lb-edit-btn').forEach(btn => btn.addEventListener('click', () => editLorebookEntry(btn.dataset.id, App.lorebookEntriesCache[btn.dataset.id])));
  box.querySelectorAll('.lb-del-btn').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('确认删除？')) return; await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: btn.dataset.id }) }); delete App.lorebookEntriesCache[btn.dataset.id]; renderLorebookList(); }));
}
document.getElementById('lb-search')?.addEventListener('input', () => renderLorebookList());
function editLorebookEntry(id, entry) {
  const isNew = !id;
  if (!entry) entry = { name: '', keywords: [], content: '', enabled: true, priority: 0, constant: false, matchMode: 'any' };
  if (isNew) id = 'entry_' + Date.now();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:550px;max-height:85vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${isNew?'新建':'编辑'}设定条目</div><label class="api-field">名称<input id="lb-name" type="text" value="${escapeHtml(entry.name||'')}" style="width:100%"></label><label class="api-field">关键词（逗号分隔）<input id="lb-keywords" type="text" value="${escapeHtml((entry.keywords||[]).join(', '))}" style="width:100%"></label><label class="api-field">内容<textarea id="lb-content" class="world-setting" rows="6" style="width:100%">${escapeHtml(entry.content||'')}</textarea></label><div style="display:flex;gap:12px;margin-top:8px"><label><input type="checkbox" id="lb-enabled" ${entry.enabled!==false?'checked':''}> 启用</label><label><input type="checkbox" id="lb-constant" ${entry.constant?'checked':''}> 常驻注入</label></div><div style="display:flex;gap:12px;margin-top:8px"><label class="api-field">优先级<input id="lb-priority" type="number" value="${entry.priority||0}" style="width:80px"></label><label class="api-field">匹配模式<select id="lb-matchmode"><option value="any" ${entry.matchMode==='any'?'selected':''}>任一关键词</option><option value="all" ${entry.matchMode==='all'?'selected':''}>全部关键词</option></select></label></div><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="lb-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="lb-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#lb-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#lb-save').onclick = async () => {
    const updated = { name: overlay.querySelector('#lb-name').value.trim().slice(0,40), keywords: overlay.querySelector('#lb-keywords').value.split(',').map(s=>s.trim()).filter(Boolean), content: overlay.querySelector('#lb-content').value, enabled: overlay.querySelector('#lb-enabled').checked, constant: overlay.querySelector('#lb-constant').checked, priority: Number(overlay.querySelector('#lb-priority').value)||0, matchMode: overlay.querySelector('#lb-matchmode').value };
    await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', id, entry: updated }) });
    App.lorebookEntriesCache[id] = { ...App.lorebookEntriesCache[id], ...updated, id };
    overlay.remove(); renderLorebookList();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
document.getElementById('lb-add-btn')?.addEventListener('click', () => editLorebookEntry(null));
// 从世界书导入设定触发器（支持自定义路径）
document.getElementById('lb-wb-btn')?.addEventListener('click', async () => {
  const defaultPath = 'canonical/lore/entries';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:520px;max-height:85vh;display:flex;flex-direction:column">
    <div style="font-size:15px;font-weight:500;margin-bottom:8px">📥 从世界书导入设定触发器</div>
    <label class="api-field">世界书目录（绝对或相对路径，留空=canonical/lore/entries）<input id="wb-path" type="text" value="${defaultPath}" style="width:100%" placeholder="如：canonical/lore/entries"></label>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      <button id="wb-load" class="head-btn" style="padding:4px 12px">🔍 加载</button>
      <button id="wb-all" class="btn-sm" style="padding:3px 10px" disabled>全选</button>
      <button id="wb-none" class="btn-sm" style="padding:3px 10px" disabled>全不选</button>
      <button id="wb-onlynew" class="btn-sm" style="padding:3px 10px" disabled>仅未导入</button>
    </div>
    <div id="wb-status" style="font-size:12px;color:var(--muted,#888);margin-bottom:8px">输入路径后点击「加载」</div>
    <div id="wb-list" style="flex:1;overflow-y:auto;min-height:200px"></div>
    <div style="margin-top:10px;display:flex;justify-content:flex-end;gap:8px">
      <button id="wb-cancel" class="btn-sm" style="padding:6px 16px">取消</button>
      <button id="wb-import" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px" disabled>导入选中</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#wb-cancel').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  const checkboxes = () => Array.from(overlay.querySelectorAll('.wb-item'));
  overlay.querySelector('#wb-load').onclick = async () => {
    const p = overlay.querySelector('#wb-path').value.trim();
    const status = overlay.querySelector('#wb-status');
    const listEl = overlay.querySelector('#wb-list');
    status.textContent = '加载中…';
    listEl.innerHTML = '';
    try {
      const r = await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'list-worldbook', entry: { path: p || undefined } }) });
      const d = await r.json();
      if (!d.ok) { status.textContent = '加载失败：' + (d.error || '未知错误'); return; }
      const entries = d.entries || [];
      if (!entries.length) { status.textContent = d.note || '没有可导入的条目'; return; }
      status.textContent = `${d.total} 个文件，可导入 ${entries.length} 条。勾选后点「导入选中」。`;
      listEl.innerHTML = entries.map(e => {
        const checked = e.exists ? 'checked disabled' : 'checked';
        const constTag = e.constant ? ' <span style="color:var(--accent,#a78bfa);font-size:10px">常驻</span>' : '';
        const existsTag = e.exists ? ' <span style="color:#f0a3a3;font-size:10px">已导入</span>' : '';
        return `<label style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:4px;cursor:pointer;background:var(--bg2,#1f2438);margin-bottom:3px">
          <input type="checkbox" class="wb-item" data-id="${escapeHtml(e.id)}" ${checked}> 
          <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.name)}${constTag}${existsTag}</span>
          <span style="font-size:10px;color:var(--muted,#888)">${e.contentLength}字</span>
        </label>`;
      }).join('');
      ['wb-all', 'wb-none', 'wb-onlynew', 'wb-import'].forEach(id => { const b = overlay.querySelector('#' + id); if (b) b.disabled = false; });
    } catch (e) { status.textContent = '请求失败：' + e.message; }
  };
  overlay.querySelector('#wb-all').onclick = () => checkboxes().forEach(c => { if (!c.disabled) c.checked = true; });
  overlay.querySelector('#wb-none').onclick = () => checkboxes().forEach(c => { if (!c.disabled) c.checked = false; });
  overlay.querySelector('#wb-onlynew').onclick = () => checkboxes().forEach(c => { c.checked = c.disabled; });
  overlay.querySelector('#wb-import').onclick = async () => {
    const ids = checkboxes().filter(c => c.checked && !c.disabled).map(c => c.dataset.id);
    if (!ids.length) { alert('请先勾选要导入的条目'); return; }
    const p = overlay.querySelector('#wb-path').value.trim();
    const ir = await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import-worldbook', entry: { ids, path: p || undefined } }) });
    const id = await ir.json();
    overlay.remove();
    loadLorebookUI();
    alert(`✅ 已导入 ${id.imported || 0} 条设定触发器`);
  };
});
document.getElementById('lb-scan-btn')?.addEventListener('click', async () => {
  const testText = prompt('输入测试文本：');
  if (testText === null) return;
  const r = await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scan', testText, entry: { chatId: App.chatId } }) });
  const d = await r.json();
  alert(`扫描结果：${d.matched||0} 条命中，注入 ${d.totalTokens||0} token（预算 ${d.budget||0}）`);
});
document.getElementById('lb-settings-btn')?.addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">设定触发器设置</div><label style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><input type="checkbox" id="lbs-enabled" ${App.lorebookSettingsCache.enabled!==false?'checked':''}> 启用设定触发器（关闭后整体不注入）</label><label class="api-field">Token 预算模式<select id="lbs-budget-mode"><option value="auto" ${App.lorebookSettingsCache.tokenBudget==='auto'?'selected':''}>自动（10% maxContext）</option><option value="custom" ${typeof App.lorebookSettingsCache.tokenBudget==='number'?'selected':''}>自定义</option><option value="unlimited" ${App.lorebookSettingsCache.tokenBudget==='unlimited'?'selected':''}>不限制</option></select></label><label class="api-field">自定义预算（token）<input id="lbs-budget-val" type="number" value="${typeof App.lorebookSettingsCache.tokenBudget==='number'?App.lorebookSettingsCache.tokenBudget:10000}" style="width:100%"></label><label class="api-field">自动模式比例（0.01-0.5）<input id="lbs-ratio" type="number" step="0.01" min="0.01" max="0.5" value="${App.lorebookSettingsCache.budgetRatio||0.1}" style="width:100%"></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="lbs-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="lbs-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#lbs-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#lbs-save').onclick = async () => {
    const mode = overlay.querySelector('#lbs-budget-mode').value;
    const tokenBudget = mode === 'auto' ? 'auto' : mode === 'unlimited' ? 'unlimited' : Number(overlay.querySelector('#lbs-budget-val').value) || 10000;
    await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'settings', settings: { enabled: overlay.querySelector('#lbs-enabled').checked, tokenBudget, budgetRatio: Number(overlay.querySelector('#lbs-ratio').value) || 0.1 } }) });
    overlay.remove(); loadLorebookUI();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});
loadLorebookUI();

// ---------- 关系图谱管理 UI ----------
App.graphDataCache = { nodes: [], edges: [] };
async function loadGraphUI() {
  try {
    const r = await fetch('/api/graph'); const d = await r.json();
    App.graphDataCache = { nodes: d.nodes || [], edges: d.edges || [] };
    // 图谱为空时自动从剧情记忆提取
    if (!App.graphDataCache.nodes.length && App.chatId) {
      try {
        const mem = await (await fetch(`/api/story-memory/data?chatId=${encodeURIComponent(App.chatId)}`)).json();
        if (mem.ok) {
          const autoNodes = new Map();
          const autoEdges = [];
          for (const [name] of Object.entries(mem.characters || {})) {
            autoNodes.set(name, { id: name, name, type: 'character', avatar: '', description: mem.characters[name] || '', tags: [] });
          }
          for (const rel of (mem.relationships || [])) {
            if (!autoNodes.has(rel.from)) autoNodes.set(rel.from, { id: rel.from, name: rel.from, type: 'character', avatar: '', description: '', tags: [] });
            if (!autoNodes.has(rel.to)) autoNodes.set(rel.to, { id: rel.to, name: rel.to, type: 'character', avatar: '', description: '', tags: [] });
            autoEdges.push({ id: `auto-${rel.from}-${rel.to}`, from: rel.from, to: rel.to, label: rel.type || '', weight: 1 });
          }
          if (autoNodes.size) App.graphDataCache = { nodes: [...autoNodes.values()], edges: autoEdges };
        }
      } catch (e) { /* 忽略 */ }
    }
    renderGraph();
  } catch (e) { /* 忽略 */ }
}
function renderGraph() {
  const svg = document.getElementById('graph-svg');
  if (!svg) return;
  const w = svg.clientWidth || 400, h = svg.clientHeight || 300;
  const nodes = App.graphDataCache.nodes, edges = App.graphDataCache.edges;
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.35;
  const positions = {};
  nodes.forEach((n, i) => { const a = (2 * Math.PI * i) / nodes.length - Math.PI / 2; positions[n.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; });
  let svgContent = '';
  for (const e of edges) { const f = positions[e.from], t = positions[e.to]; if (!f || !t) continue; svgContent += `<line x1="${f.x}" y1="${f.y}" x2="${t.x}" y2="${t.y}" stroke="var(--muted,#9aa0c0)" stroke-width="${e.weight||1}"/>`; if (e.label) svgContent += `<text x="${(f.x+t.x)/2}" y="${(f.y+t.y)/2-6}" text-anchor="middle" fill="var(--text,#e8e6f0)" font-size="11">${e.label}</text>`; }
  for (const n of nodes) { const p = positions[n.id]; if (!p) continue; const c = n.type==='character'?'#a78bfa':n.type==='location'?'#6ee7a0':'#f0a35e'; svgContent += `<circle cx="${p.x}" cy="${p.y}" r="20" fill="${c}" stroke="var(--border,#3a4163)" stroke-width="1" style="cursor:pointer" onclick="editGraphNode('${n.id}')"/>`; svgContent += `<text x="${p.x}" y="${p.y+30}" text-anchor="middle" fill="var(--text,#e8e6f0)" font-size="11">${n.name}</text>`; }
  svg.innerHTML = svgContent;
}
function editGraphNode(nodeId) {
  const node = App.graphDataCache.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">编辑角色</div><label class="api-field">名称<input id="gn-name" type="text" value="${node.name}" style="width:100%"></label><label class="api-field">类型<select id="gn-type"><option value="character" ${node.type==='character'?'selected':''}>角色</option><option value="location" ${node.type==='location'?'selected':''}>地点</option><option value="faction" ${node.type==='faction'?'selected':''}>势力</option></select></label><label class="api-field">描述<textarea id="gn-desc" class="world-setting" rows="2" style="width:100%">${node.description||''}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="gn-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="gn-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button><button id="gn-delete" class="btn-sm" style="padding:6px 16px;color:#f0a3a3">删除</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#gn-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#gn-save').onclick = async () => { await fetch('/api/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'updateNode', node: { id: nodeId, name: overlay.querySelector('#gn-name').value.trim(), type: overlay.querySelector('#gn-type').value, description: overlay.querySelector('#gn-desc').value } }) }); overlay.remove(); loadGraphUI(); };
  overlay.querySelector('#gn-delete').onclick = async () => { if (!confirm('确认删除？')) return; await fetch('/api/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'deleteNode', node: { id: nodeId } }) }); overlay.remove(); loadGraphUI(); };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
document.getElementById('graph-add-node')?.addEventListener('click', async () => { const name = prompt('角色名称：'); if (!name?.trim()) return; await fetch('/api/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'addNode', node: { name: name.trim() } }) }); loadGraphUI(); });
document.getElementById('graph-add-edge')?.addEventListener('click', async () => {
  const nodes = App.graphDataCache.nodes; if (nodes.length < 2) { alert('至少需要 2 个角色'); return; }
  const from = prompt('从哪个角色？\n可选：' + nodes.map(n => n.name).join(', '));
  const to = prompt('到哪个角色？\n可选：' + nodes.map(n => n.name).join(', '));
  const label = prompt('关系标签（如：朋友/家人/敌人）：');
  if (!from || !to) return;
  const fn = nodes.find(n => n.name === from), tn = nodes.find(n => n.name === to);
  if (!fn || !tn) { alert('名称不匹配'); return; }
  await fetch('/api/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'addEdge', edge: { from: fn.id, to: tn.id, label: label || '' } }) }); loadGraphUI();
});
loadGraphUI();

// ---------- 剧情记忆管理 UI ----------
async function loadStoryMemoryUI() {
  const cid = App.chatId;
  if (!cid) return;
  try {
    const [memRes, invRes, emoRes] = await Promise.all([
      fetch(`/api/story-memory/data?chatId=${encodeURIComponent(cid)}`).then(r => r.json()),
      fetch(`/api/inventory?chatId=${encodeURIComponent(cid)}`).then(r => r.json()).catch(() => ({ inventory: [] })),
      fetch(`/api/emotions?chatId=${encodeURIComponent(cid)}`).then(r => r.json()).catch(() => ({ emotions: {} })),
    ]);
    const d = memRes;
    if (!d.ok) return;
    // 场景
    const sceneEl = document.getElementById('memory-scene');
    if (sceneEl) {
      const scenes = d.scenes || [];
      if (scenes.length) {
        const items = [...scenes].reverse().slice(0, 8).map((s, i) => {
          const isLatest = i === 0;
          const timeStr = s.story_time ? `<span style="color:var(--accent,#a78bfa)">${safeHtml(s.story_time)}</span>` : '';
          const atmo = s.atmosphere ? ` · ${safeHtml(s.atmosphere)}` : '';
          const ev = s.event ? `<div style="margin-left:16px;color:var(--muted,#888);font-size:11px">${safeHtml(s.event)}</div>` : '';
          return `<div style="${isLatest ? 'font-weight:600' : ''}">${isLatest ? '📍 ' : '· '}${timeStr} ${safeHtml(s.location)}${atmo}</div>${ev}`;
        }).join('');
        sceneEl.innerHTML = `<strong>场景历史（${scenes.length} 处）：</strong><br>${items}`;
      } else { sceneEl.textContent = '暂无场景信息'; }
    }
    // 角色简介
    const charsEl = document.getElementById('memory-characters');
    if (charsEl) {
      const chars = Object.entries(d.characters || {});
      if (chars.length) {
        charsEl.innerHTML = `<strong>角色简介（${chars.length}）：</strong><br>${chars.map(([name, intro]) => `<b>${safeHtml(name)}</b>：${safeHtml(intro)}`).join('<br>')}`;
      } else { charsEl.textContent = '暂无角色简介'; }
    }
    // 关系
    const relsEl = document.getElementById('memory-relationships');
    if (relsEl) {
      const rels = d.relationships || [];
      if (rels.length) {
        relsEl.innerHTML = `<strong>角色关系（${rels.length}）：</strong><br>${rels.map(rel => `${safeHtml(rel.from)} → ${safeHtml(rel.to)}：${safeHtml(rel.type)}${rel.description ? `（${safeHtml(rel.description)}）` : ''}`).join('<br>')}`;
      } else { relsEl.textContent = '暂无关系信息'; }
    }
    // 着装
    const wdEl = document.getElementById('memory-wardrobe');
    if (wdEl) {
      const wdRes = await fetch(`/api/wardrobe/current?chatId=${encodeURIComponent(cid)}`).then(r => r.json()).catch(() => ({}));
      const wardrobes = wdRes.wardrobes || {};
      const wdKeys = Object.keys(wardrobes);
      if (wdKeys.length) {
        wdEl.innerHTML = `<strong>当前着装：</strong><br>${wdKeys.map(k => `<b>${safeHtml(k)}</b>：${safeHtml(wardrobes[k])}`).join('<br>')}`;
      } else { wdEl.textContent = '暂无着装信息'; }
    }
    // 情绪
    const emoEl = document.getElementById('memory-emotions');
    if (emoEl) {
      const emos = emoRes.emotions || {};
      const keys = Object.keys(emos);
      if (keys.length) {
        emoEl.innerHTML = `<strong>当前情绪：</strong><br>${keys.map(k => `<b>${safeHtml(k)}</b>：${safeHtml(emos[k])}`).join('<br>')}`;
      } else { emoEl.textContent = '暂无情绪信息'; }
    }
    // 物品
    const invEl = document.getElementById('memory-inventory');
    if (invEl) {
      const inv = invRes.inventory || [];
      if (inv.length) {
        invEl.innerHTML = `<strong>物品栏（${inv.length}）：</strong><br>${inv.map(i => `${safeHtml(i.name)}${i.count > 1 ? ` ×${i.count}` : ''}${i.holder ? `（${safeHtml(i.holder)}）` : ''}`).join('、')}`;
      } else { invEl.textContent = '暂无物品'; }
    }
    // 地点档案
    const locEl = document.getElementById('memory-locations2');
    if (locEl) {
      const locs = d.locationDetails || [];
      if (locs.length) {
        locEl.innerHTML = `<strong>地点档案（${locs.length}）：</strong><br>${locs.map(l => `<b>${safeHtml(l.group)}</b>｜${safeHtml(l.name)}：${safeHtml((l.description || '').slice(0, 80))}`).join('<br>')}`;
      } else { locEl.textContent = '暂无地点档案'; }
    }
  } catch (e) { /* 忽略 */ }
}
document.getElementById('memory-refresh-btn')?.addEventListener('click', loadStoryMemoryUI);
document.getElementById('memory-config-btn')?.addEventListener('click', async () => {
  const r = await fetch('/api/story-memory/config');
  const d = await r.json();
  const config = d.config || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">剧情记忆配置</div><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-scene" ${config.scene ? 'checked' : ''}> 场景档案注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-character" ${config.character ? 'checked' : ''}> 角色档案注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-relationship" ${config.relationship ? 'checked' : ''}> 关系档案注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-expression" ${config.expression ? 'checked' : ''}> 情绪注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-wardrobe" ${config.wardrobe !== false ? 'checked' : ''}> 着装注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-inventory" ${config.inventory !== false ? 'checked' : ''}> 物品栏注入</label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="smc-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="smc-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#smc-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#smc-save').onclick = async () => {
    const newConfig = {
      scene: overlay.querySelector('#smc-scene').checked,
      character: overlay.querySelector('#smc-character').checked,
      relationship: overlay.querySelector('#smc-relationship').checked,
      expression: overlay.querySelector('#smc-expression').checked,
      wardrobe: overlay.querySelector('#smc-wardrobe').checked,
      inventory: overlay.querySelector('#smc-inventory').checked,
    };
    await fetch('/api/story-memory/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(newConfig) });
    overlay.remove();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});
loadStoryMemoryUI();

// ---------- 地点档案管理 UI（知识库格式，可合入 canonical/lore/地点.txt） ----------
App.locationDetailsCache = [];
async function loadLocationsUI() {
  const cid = App.chatId;
  const box = document.getElementById('location-list');
  if (!cid) { if (box) box.textContent = '无会话'; return; }
  if (!box) return;
  try {
    const r = await fetch(`/api/story-memory/data?chatId=${encodeURIComponent(cid)}`);
    const d = await r.json();
    App.locationDetailsCache = d.locationDetails || [];
    if (!App.locationDetailsCache.length) { box.textContent = '暂无地点档案（AI 在新地点首次造访时输出 location_detail 自动建档）'; return; }
    const byGroup = {};
    for (const loc of App.locationDetailsCache) (byGroup[loc.group] = byGroup[loc.group] || []).push(loc);
    const lines = [];
    for (const [g, locs] of Object.entries(byGroup)) {
      lines.push(`## ${g}`);
      for (const loc of locs) lines.push(`- ${loc.name}：${loc.detail}`);
      lines.push('');
    }
    box.textContent = lines.join('\n');
  } catch (e) { box.textContent = '加载失败：' + e.message; }
}
document.getElementById('location-refresh-btn')?.addEventListener('click', loadLocationsUI);

// ---------- 玩家身份管理 UI ----------
App.personasCache = {};
App.activePersonaCache = '';
async function loadPersonasUI() {
  const box = document.getElementById('persona-list');
  if (!box) return;
  try {
    const r = await fetch('/api/personas'); const d = await r.json();
    App.personasCache = d.personas || {}; App.activePersonaCache = d.active || '';
    box.innerHTML = '';
    if (!Object.keys(App.personasCache).length) { box.textContent = '（暂无身份，点击下方新建）'; return; }
    for (const [id, p] of Object.entries(App.personasCache)) {
      const el = document.createElement('div');
      el.className = 'cp-item';
      el.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg2,#f5f5f5);margin-bottom:6px;${id===App.activePersonaCache?'border:2px solid var(--accent,#a78bfa)':''}`;
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${p.name}${id===App.activePersonaCache?' <span style="color:var(--accent,#a78bfa)">[当前]</span>':''}</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${p.description||'暂无描述'}</div></div>${id!==App.activePersonaCache?`<button class="head-btn persona-activate" data-id="${id}" style="padding:2px 8px;font-size:11px">切换</button>`:''}<button class="head-btn persona-edit" data-id="${id}" style="padding:2px 8px;font-size:11px">编辑</button>${!p.isDefault?`<button class="head-btn persona-del" data-id="${id}" style="padding:2px 8px;font-size:11px;color:#f0a3a3">删</button>`:''}`;
      box.appendChild(el);
    }
    box.querySelectorAll('.persona-activate').forEach(btn => btn.addEventListener('click', async () => { await fetch('/api/personas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'activate', id: btn.dataset.id }) }); loadPersonasUI(); }));
    box.querySelectorAll('.persona-edit').forEach(btn => btn.addEventListener('click', () => editPersona(btn.dataset.id)));
    box.querySelectorAll('.persona-del').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('确认删除？')) return; await fetch('/api/personas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: btn.dataset.id }) }); loadPersonasUI(); }));
  } catch (e) { box.textContent = '加载失败'; }
}
function editPersona(id) {
  const p = App.personasCache[id] || { name: '', description: '' };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${id?'编辑':'新建'}玩家身份</div><label class="api-field">名称<input id="pe-name" type="text" value="${p.name||''}" style="width:100%"></label><label class="api-field">描述<textarea id="pe-desc" class="world-setting" rows="3" style="width:100%">${p.description||''}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="pe-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="pe-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#pe-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#pe-save').onclick = async () => { await fetch('/api/personas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', id: id||undefined, persona: { name: overlay.querySelector('#pe-name').value.trim(), description: overlay.querySelector('#pe-desc').value } }) }); overlay.remove(); loadPersonasUI(); };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
document.getElementById('persona-add-btn')?.addEventListener('click', () => editPersona(null));
loadPersonasUI();

// ---------- 剧情备忘管理 UI ----------
async function loadAgendaUI() {
  const box = document.getElementById('agenda-list');
  if (!box || !App.chatId) { if (box) box.textContent = '请先打开对话'; return; }
  try {
    const r = await fetch('/api/agenda/' + encodeURIComponent(App.chatId)); const d = await r.json();
    box.innerHTML = '';
    const pending = (d.items || []).filter(i => i.status === 'pending');
    const completed = (d.items || []).filter(i => i.status === 'completed');
    if (!pending.length && !completed.length) { box.textContent = '（暂无备忘）'; return; }
    for (const item of pending) {
      const el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:var(--bg2,#f5f5f5);margin-bottom:4px;font-size:12px';
      el.innerHTML = `<div style="flex:1">${escapeHtml(item.content)}</div><button class="head-btn agenda-complete" data-id="${escapeHtml(item.id)}" style="padding:2px 6px;font-size:11px">✓</button><button class="head-btn agenda-del" data-id="${escapeHtml(item.id)}" style="padding:2px 6px;font-size:11px;color:#f0a3a3">✕</button>`;
      box.appendChild(el);
    }
    if (completed.length) {
      const hr = document.createElement('div'); hr.style.cssText = 'font-size:11px;color:var(--muted,#888);margin-top:8px;margin-bottom:4px'; hr.textContent = `已完成 (${completed.length})`; box.appendChild(hr);
      for (const item of completed.slice(-5)) { const el = document.createElement('div'); el.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;font-size:11px;color:var(--muted,#888);text-decoration:line-through'; el.innerHTML = `<div style="flex:1">${escapeHtml(item.content)}</div>`; box.appendChild(el); }
    }
    box.querySelectorAll('.agenda-complete').forEach(btn => btn.addEventListener('click', async () => { await fetch('/api/agenda/' + encodeURIComponent(App.chatId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'complete', item: { id: btn.dataset.id } }) }); loadAgendaUI(); }));
    box.querySelectorAll('.agenda-del').forEach(btn => btn.addEventListener('click', async () => { await fetch('/api/agenda/' + encodeURIComponent(App.chatId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', item: { id: btn.dataset.id } }) }); loadAgendaUI(); }));
  } catch (e) { box.textContent = '加载失败'; }
}
document.getElementById('agenda-add-btn')?.addEventListener('click', async () => { if (!App.chatId) { alert('请先打开对话'); return; } const content = prompt('备忘内容：'); if (!content?.trim()) return; await fetch('/api/agenda/' + encodeURIComponent(App.chatId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', item: { content: content.trim() } }) }); loadAgendaUI(); });

// ---------- 报告系统 UI ----------
async function loadReportListUI() {
  const box = document.getElementById('report-list');
  if (!box || !App.chatId) { if (box) box.textContent = '请先打开对话'; return; }
  try {
    const r = await fetch('/api/report/list?chatId=' + encodeURIComponent(App.chatId)); const d = await r.json();
    box.innerHTML = '';
    if (!d.reports?.length) { box.textContent = '（暂无报告）'; return; }
    for (const report of d.reports.slice(0, 10)) {
      const el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:var(--bg2,#f5f5f5);margin-bottom:4px;font-size:12px;cursor:pointer';
      el.innerHTML = `<div style="flex:1">${report.filename}</div><span style="font-size:11px;color:var(--muted,#888)">${report.ts.slice(0, 16)}</span>`;
      el.onclick = async () => { const r2 = await fetch('/api/report/' + encodeURIComponent(App.chatId) + '/' + encodeURIComponent(report.filename)); const d2 = await r2.json(); if (d2.content) showReportPreview(d2.content, report.filename); };
      box.appendChild(el);
    }
  } catch (e) { box.textContent = '加载失败'; }
}
function showReportPreview(content, title) {
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:600px;max-height:80vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${title||'报告'}</div><div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${content}</div><div style="margin-top:16px;display:flex;justify-content:flex-end"><button id="rp-close" class="btn-sm" style="padding:6px 16px">关闭</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#rp-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
document.getElementById('report-overview-btn')?.addEventListener('click', async () => {
  if (!App.chatId) { alert('请先打开对话'); return; }
  const range = prompt('报告范围（last10/today/all）：', 'last10');
  if (!range) return;
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="text-align:center;padding:20px;color:var(--muted,#888)">正在生成回顾报告...</div></div>`; document.body.appendChild(overlay);
  try { const r = await fetch('/api/report/overview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: App.chatId, range }) }); const d = await r.json(); overlay.remove(); if (d.error) { alert('生成失败：' + d.error); return; } showReportPreview(d.content, '回顾报告'); loadReportListUI(); } catch (e) { overlay.remove(); alert('请求失败：' + e.message); }
});
document.getElementById('report-audit-btn')?.addEventListener('click', async () => {
  if (!App.chatId) { alert('请先打开对话'); return; }
  const range = prompt('报告范围（last10/today/all）：', 'last10');
  if (!range) return;
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="text-align:center;padding:20px;color:var(--muted,#888)">正在生成自检报告...</div></div>`; document.body.appendChild(overlay);
  try { const r = await fetch('/api/report/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: App.chatId, range }) }); const d = await r.json(); overlay.remove(); if (d.error) { alert('生成失败：' + d.error); return; } showReportPreview(d.content, '自检报告'); loadReportListUI(); } catch (e) { overlay.remove(); alert('请求失败：' + e.message); }
});
document.getElementById('report-retro-btn')?.addEventListener('click', async () => {
  if (!App.chatId) { alert('请先打开对话'); return; }
  if (!confirm('回溯分析会分批调用 AI 分析全部历史消息，可能消耗较多 token。继续？')) return;
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="text-align:center;padding:20px;color:var(--muted,#888)">正在回溯分析...</div></div>`; document.body.appendChild(overlay);
  try { const r = await fetch('/api/analyze/retro', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: App.chatId }) }); const d = await r.json(); overlay.remove(); if (d.error) { alert('分析失败：' + d.error); return; } showReportPreview(d.content, `回溯分析（${d.stats?.messages||0} 条消息，${d.stats?.batches||0} 批）`); loadReportListUI(); } catch (e) { overlay.remove(); alert('请求失败：' + e.message); }
});
loadReportListUI();

// ---------- 旁注管理 UI ----------
async function loadAnnotationsUI() {
  const box = document.getElementById('annotation-list');
  if (!box || !App.chatId) { if (box) box.textContent = '请先打开对话'; return; }
  try {
    const r = await fetch('/api/annotations/' + encodeURIComponent(App.chatId)); const d = await r.json();
    box.innerHTML = '';
    const notes = d.notes || [];
    if (!notes.length) { box.textContent = '（暂无旁注）'; return; }
    for (const note of notes) {
      const el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:var(--bg2,#f5f5f5);margin-bottom:4px;font-size:12px';
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500">第${note.position}条消息后</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${note.content}</div></div><label style="font-size:11px;flex:none"><input type="checkbox" class="ann-toggle" data-id="${note.id}" ${note.enabled?'checked':''}> 启用</label><button class="head-btn ann-edit" data-id="${note.id}" style="padding:2px 6px;font-size:11px;flex:none">编辑</button><button class="head-btn ann-del" data-id="${note.id}" style="padding:2px 6px;font-size:11px;color:#f0a3a3;flex:none">删</button>`;
      box.appendChild(el);
    }
    box.querySelectorAll('.ann-toggle').forEach(cb => cb.addEventListener('change', async () => { await fetch('/api/annotations/' + encodeURIComponent(App.chatId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update', note: { id: cb.dataset.id, enabled: cb.checked } }) }); }));
    box.querySelectorAll('.ann-edit').forEach(btn => btn.addEventListener('click', () => editAnnotation(notes.find(n => n.id === btn.dataset.id))));
    box.querySelectorAll('.ann-del').forEach(btn => btn.addEventListener('click', async () => { await fetch('/api/annotations/' + encodeURIComponent(App.chatId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', note: { id: btn.dataset.id } }) }); loadAnnotationsUI(); }));
  } catch (e) { box.textContent = '加载失败'; }
}
function editAnnotation(note) {
  if (!note) note = { position: 3, content: '' };
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${note.id?'编辑':'添加'}旁注</div><label class="api-field">位置（在第几条消息后）<input id="an-pos" type="number" min="1" value="${note.position||3}" style="width:80px"></label><label class="api-field">内容<textarea id="an-content" class="world-setting" rows="3" style="width:100%">${note.content||''}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="an-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="an-save" class="btn-sm" style="padding:6px 16px;background:var(--accent,#a78bfa);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#an-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#an-save').onclick = async () => {
    const data = { position: Number(overlay.querySelector('#an-pos').value) || 3, content: overlay.querySelector('#an-content').value };
    if (note.id) data.id = note.id;
    await fetch('/api/annotations/' + encodeURIComponent(App.chatId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: note.id ? 'update' : 'add', note: data }) });
    overlay.remove(); loadAnnotationsUI();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
document.getElementById('ann-add-btn')?.addEventListener('click', () => editAnnotation(null));
loadAnnotationsUI();

// ---------- 可折叠分组（card-group + 独立卡片 collapsible，状态存 localStorage） ----------
const FOLD_KEY = 'mr-sidebar-folded';
App.foldedCards = [];
try { App.foldedCards = JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); } catch (e) { App.foldedCards = []; }
function applyFoldedState() {
  for (const id of App.foldedCards) {
    const el = document.getElementById(id);
    if (el) el.classList.add('collapsed');
  }
}
function saveFoldedState() {
  App.foldedCards = Array.from(document.querySelectorAll('#sidebar .card.collapsed')).map(el => el.id);
  localStorage.setItem(FOLD_KEY, JSON.stringify(App.foldedCards));
}
document.querySelectorAll('#sidebar .group-toggle').forEach(toggle => {
  toggle.addEventListener('click', () => {
    const group = toggle.closest('.card-group') || toggle.closest('.card.collapsible');
    if (group) { group.classList.toggle('collapsed'); saveFoldedState(); }
  });
});
document.querySelectorAll('#sidebar .card.collapsible .card-title').forEach(title => {
  if (title.classList.contains('group-toggle')) return;
  title.addEventListener('click', () => {
    const card = title.closest('.card');
    if (card) { card.classList.toggle('collapsed'); saveFoldedState(); }
  });
});
applyFoldedState();

// ---------- 侧栏卡片拖拽排序（card-group + 独立卡片，顺序存 localStorage） ----------
(function initSidebarDragSort() {
  const SORT_KEY = 'mr-sidebar-order';
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const cards = Array.from(sidebar.querySelectorAll(':scope > .card'));
  if (!cards.length) return;

  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) || '[]');
    if (Array.isArray(saved) && saved.length) {
      for (const id of [...saved].reverse()) {
        const el = document.getElementById(id);
        if (el) sidebar.insertBefore(el, sidebar.firstChild);
      }
    }
  } catch (e) { /* 忽略 */ }

  let dragEl = null;
  let dragOverEl = null;

  cards.forEach(c => {
    c.draggable = true;
    c.addEventListener('dragstart', (e) => {
      dragEl = c;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', c.id); } catch (err) { /* 忽略 */ }
      c.classList.add('drag-sorting');
    });
    c.addEventListener('dragend', () => {
      if (dragEl) dragEl.classList.remove('drag-sorting');
      cards.forEach(x => x.classList.remove('drag-over'));
      dragEl = null; dragOverEl = null;
      const order = Array.from(sidebar.querySelectorAll(':scope > .card')).map(x => x.id);
      localStorage.setItem(SORT_KEY, JSON.stringify(order));
    });
    c.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dragOverEl !== c) {
        dragOverEl = c;
        cards.forEach(x => x.classList.remove('drag-over'));
        c.classList.add('drag-over');
      }
    });
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragEl && dragEl !== c) {
        const rect = c.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        if (after) c.after(dragEl); else c.before(dragEl);
        const order = Array.from(sidebar.querySelectorAll(':scope > .card')).map(x => x.id);
        localStorage.setItem(SORT_KEY, JSON.stringify(order));
      }
    });
    c.querySelector('.group-toggle, .card-title')?.addEventListener('dragstart', (e) => e.stopPropagation());
  });
})();

// ---------- 启动 ----------
document.getElementById('card-world').style.display = '';
renderSettings();
applySkin();
bindCustomSkin();
updatePeakBanner();
setInterval(updatePeakBanner, 60000);
loadChatList();   // 会话列表（R3-v3 修复：启动即加载，避免首屏卡"加载中…"）
loadTimeline();
loadCurrentWardrobe();
loadSessionNote();
loadStats();
loadModel();
loadProfiles();
initMsgSearch();
// 多标签页同步：另一 tab 切换会话/改偏好时本页跟随（避免互相覆盖）
window.addEventListener('storage', (e) => {
  if (!e.newValue) return;
  if (e.key === CUR_CHAT_KEY && e.newValue !== App.chatId) {
    fetch('/api/chats/' + e.newValue).then((r) => r.json()).then((c) => {
      if (c && !c.error && (c.messages || []).length) openChat(e.newValue);
    }).catch(() => {});
  } else if (e.key === PREFS_KEY || e.key === 'mr-custom-skin') {
    location.reload();   // 主题/背景/侧栏偏好：刷新应用
  }
});
maybeStartTour();
setInterval(loadStats, 15000);

// 会话恢复：有当前会话则打开，否则新建
(async () => {
  const saved = localStorage.getItem(CUR_CHAT_KEY);
  if (saved) {
    try {
      const c = await (await fetch('/api/chats/' + saved)).json();
      if (c && !c.error && (c.messages || []).length) { await openChat(saved); return; }
    } catch (e) { /* 继续新建 */ }
  }
  await newChat();
})();
