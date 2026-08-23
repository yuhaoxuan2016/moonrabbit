// app.js —— 通用多角色 RP / 互动小说界面前端逻辑
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

let pendingContext = '';   // 手动附加资料 → 下一条消息附带（不进对话历史）

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

let history = [];          // [{role, content, seq}]
let msgSeq = 0;            // 消息序号（重roll/删除定位用）
let streaming = false;

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

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  if (streaming) return;
  const idx = history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  // 记录旧版进版本链（锚点 = 该回复之前最近一条 user 消息的 seq；多次重roll 累积）
  const oldMsg = history[idx];
  let anchorSeq = seq;
  for (let i = idx - 1; i >= 0; i--) { if (history[i].role === 'user') { anchorSeq = history[i].seq; break; } }
  if (oldMsg && oldMsg.role === 'assistant') {
    (rerollVersions[anchorSeq] = rerollVersions[anchorSeq] || []).push({ content: oldMsg.content, ts: Date.now() });
  }
  history = history.slice(0, idx);          // 截断：该条及其后全部作废（旧文本不进 AI 上下文）
  // 同步清理回合记录：删除 seq >= n 的记账（旧回复的账本不残留）
  fetch('/api/timeline/truncate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, seq, mode: 'gte' }),
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
  if (streaming) return;
  const versions = rerollVersions[anchorSeq];
  if (!versions || !versions[verIdx]) return;
  const content = versions[verIdx].content;
  // 1) 从 history 移除锚点之后的所有消息（当前链）
  const anchorIdx = history.findIndex((m) => m.seq === anchorSeq);
  if (anchorIdx < 0) return;
  history = history.slice(0, anchorIdx + 1);
  // 1.5) 清理锚点后的回合记录（重roll 后新回复的账本不残留）
  fetch('/api/timeline/truncate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, seq: anchorSeq + 1, mode: 'gte' }),
  }).catch(() => {});
  // 2) 旧版放回原位（新 seq，避免与已存消息冲突）
  const newSeq = ++msgSeq;
  history.push({ role: 'assistant', content, seq: newSeq });
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
  if (streaming) return;
  const idx = history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  const removed = history[idx];
  history.splice(idx, 1);
  // 删除的是 AI 回复 → 同步清理其回合记录（eq 只删该条）
  if (removed && removed.role === 'assistant') {
    fetch('/api/timeline/truncate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, seq, mode: 'eq' }),
    }).catch(() => {});
  }
  const wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  if (wrap) wrap.remove();
  saveChat();
}

// ---------- 对话编辑（✏️ 编辑消息 / ✂️ 截断至此） ----------
function editMsg(seq) {
  if (streaming) return;
  const idx = history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  const wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  if (!wrap) return;
  if (wrap.querySelector('.edit-box')) return;   // 已在编辑中
  const ta = document.createElement('textarea');
  ta.className = 'edit-box';
  ta.value = stripTurnTags(history[idx].content);
  const btnRow = document.createElement('div');
  btnRow.className = 'edit-actions';
  const ok = document.createElement('button');
  ok.className = 'ma-btn';
  ok.textContent = '保存';
  ok.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) return;
    history[idx].content = text;
    saveChat();
    rebuildMsgWrap(wrap, history[idx].role, text, seq);
  });
  const cancel = document.createElement('button');
  cancel.className = 'ma-btn del';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => rebuildMsgWrap(wrap, history[idx].role, history[idx].content, seq));
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
  if (streaming) return;
  const idx = history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  if (!confirm(`截断：删除该消息及其后所有消息（${history.length} → ${idx} 条）？\n用于把剧情拉回正轨；旧内容在 data 子仓检查点可找回。`)) return;
  history = history.slice(0, idx);
  fetch('/api/timeline/truncate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId, seq, mode: 'gte' }),
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
  return String(text || '')
    .replace(/<storyevent>[\s\S]*?<\/storyevent>/gi, '')
    .replace(/<items>[\s\S]*?<\/items>/gi, '')
    .replace(/^【更新】[^\n]*$/gm, '');
}

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
  if (!content || streaming) return;
  // 发送即取消自动保存防抖（防 3s 后以发送前旧快照 PUT 覆盖新数据）
  clearTimeout(autoSaveTimer);
  // 高峰时段强提醒：官方直连渠道 + 高峰时间 + 发送前确认（可设置关闭）
  if (peakEligible && prefs.peakConfirm !== false && isPeakHours(new Date())) {
    if (!confirm('⚠️ 当前为工作日高峰时段（9:00-12:00 / 14:00-18:00）\nAPI 费率较高、可能限流变卡；周末全天为低谷价。\n\n继续发送吗？')) {
      return;
    }
  }
  els.input.value = '';
  const seq = ++msgSeq;
  renderUser(content, seq);
  history.push({ role: 'user', content, seq });
  saveChat();
  await generate();
}

async function generate() {
  streaming = true;
  els.send.disabled = true;
  els.typing.classList.remove('hidden');
  const extra = pendingContext;
  pendingContext = '';
  els.manAttachNote.classList.add('hidden');
  const seq = ++msgSeq;

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
        messages: history,
        chatId,
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
    if (thinkAcc.trim() && prefs.showThinking !== false) {
      renderThinking(thinkAcc.trim());
    }
    if (acc.trim()) {
      renderAssistant(acc.trim(), seq);
      // 思考记录一并存进 history（刷新/切会话后恢复显示）
      history.push({ role: 'assistant', content: acc.trim(), seq, thinking: thinkAcc.trim() || undefined });
    }
  } catch (e) {
    tempWrap.remove();
    renderAssistant(`（叙事者提示：${e.message}）`, seq);
  } finally {
    streaming = false;
    els.send.disabled = false;
    els.typing.classList.add('hidden');
    els.input.focus();
    saveChat();       // 会话自动保存（归档）
    loadTimeline();   // 剧情记忆：刷新时间线/物品栏
    loadInventory();
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
let chatId = null;
let chatTitle = '';

async function saveChat() {
  if (!chatId) return;
  const firstUser = history.find((m) => m.role === 'user');
  const title = chatTitle || (firstUser ? firstUser.content.slice(0, 24) : '新对话');
  // 失败自动重试 1 次（500ms 后）；仍失败 → 状态栏提示（不静默丢数据）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch('/api/chats/' + chatId, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, messages: history }),
      });
      if (r.ok) { chatTitle = title; return; }
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
    fetch('/api/chats/' + chatId, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, messages: history }),
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
  if (!chatId || !history.length) { alert('当前会话为空，无内容可导出'); return; }
  const firstUser = history.find((m) => m.role === 'user');
  const title = chatTitle || (firstUser ? firstUser.content.slice(0, 24) : '新对话');
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  if (!md) {
    downloadBlob(`${safeTitle}.json`, JSON.stringify({ id: chatId, title, exportedAt: new Date().toISOString(), messages: history }, null, 2), 'application/json');
  } else {
    const lines = [`# ${title}`, '', `> 导出时间：${new Date().toLocaleString()}`, ''];
    for (const m of history) {
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
  if (!chatId) { alert('还没有会话，无法存档'); return; }
  if (!history.length) { alert('当前会话为空，无需存档'); return; }
  await saveChat();   // 先把最新对话落盘，再存副本
  const label = (prompt('存档备注（可留空）：', '') || '').trim().slice(0, 40);
  try {
    const r = await (await fetch('/api/savepoints/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, label }),
    })).json();
    if (!r.ok) throw new Error(r.error || '存档失败');
    alert('✅ ' + r.note);
  } catch (e) { alert('存档失败：' + e.message); }
});
document.getElementById('loadpoint-btn').addEventListener('click', async () => {
  if (!chatId) { alert('还没有会话，无法读档'); return; }
  try {
    const { ok, savepoints } = await (await fetch(`/api/savepoints/list?chatId=${encodeURIComponent(chatId)}`)).json();
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
      body: JSON.stringify({ chatId, ts: sp.ts }),
    })).json();
    if (!r.ok) throw new Error(r.error || '读档失败');
    // 清空本地状态再重新打开（避免 openChat 先把旧 history 存回覆盖存档）
    const prevHistory = history.slice();   // 备份：openChat 失败时恢复，防空 history 覆盖存档
    history = [];
    els.messages.innerHTML = '';
    msgSeq = 0;
    await openChat(chatId);
    if (!history.length && prevHistory.length) history = prevHistory;   // GET 失败 → 恢复旧状态
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
      d.className = 'chat-item' + (c.id === chatId ? ' active' : '');
      const time = (c.updatedAt || '').slice(5, 16).replace('T', ' ');
      d.innerHTML = `<span class="ci-pin${c.pinned ? ' on' : ''}" title="${c.pinned ? '取消置顶' : '置顶'}">📌</span><span class="ci-title"></span><span class="ci-rename" title="重命名">✏️</span><span class="ci-time">${time}</span><span class="ci-del" title="删除">×</span>`;
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
          if (c.id === chatId) chatTitle = name;   // 当前会话标题同步，后续 saveChat 沿用
        } catch (err) { alert('重命名失败：' + err.message); }
        loadChatList();
      });
      d.querySelector('.ci-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除会话「${c.title}」？`)) return;
        await fetch('/api/chats/' + c.id, { method: 'DELETE' });
        if (c.id === chatId) { chatId = null; localStorage.removeItem(CUR_CHAT_KEY); }
        loadChatList();
      });
      box.appendChild(d);
    }
  } catch (e) { box.textContent = '会话列表读取失败'; }
}

async function newChat() {
  if (history.length) await saveChat();   // 旧对话自动归档
  try {
    const { id } = await (await fetch('/api/chats', { method: 'POST' })).json();
    chatId = id;
    chatTitle = '';
    localStorage.setItem(CUR_CHAT_KEY, id);
    els.messages.innerHTML = '';
    history = [];
    renderAssistant('（新对话开始。在右侧「世界设定」里填写你的世界观/角色/规则（可选），然后直接开始对话。多角色场景按「角色名：台词」分段显示头像。）');
    loadChatList();
    loadTimeline();   // 剧情记忆按会话隔离，切会话后刷新
    loadInventory();
    loadSessionNote();   // 会话常驻设定按会话加载（新会话为空）
    toggleSidebar(false);   // 移动端：新建会话后收起抽屉
  } catch (e) { /* 忽略 */ }
}

async function openChat(id) {
  if (history.length) await saveChat();
  try {
    const c = await (await fetch('/api/chats/' + id)).json();
    if (c.error) return;
    chatId = c.id;
    chatTitle = c.title;
    localStorage.setItem(CUR_CHAT_KEY, id);
    els.messages.innerHTML = '';
    history = Array.isArray(c.messages) ? c.messages : [];
    // 恢复旧会话：无 seq 的补发（兼容历史数据）
    for (const m of history) {
      if (!m.seq) m.seq = ++msgSeq;
      else msgSeq = Math.max(msgSeq, m.seq);
      if (m.role === 'user') renderUser(m.content, m.seq);
      else if (m.role === 'assistant') {
        // 先渲染思考块（与实时生成顺序一致：思考在回复内容上方）
        if (m.thinking && prefs.showThinking !== false) renderThinking(m.thinking);
        renderAssistant(m.content, m.seq);
      }
    }
    loadChatList();
    loadTimeline();   // 剧情记忆按会话隔离，切会话后刷新
    loadInventory();
    loadCurrentWardrobe();
    loadSessionNote();   // 会话常驻设定按会话加载
    loadInjections();    // 自定义注入槽按会话刷新（API 弹窗开着时同步显示当前会话值）
    loadStats();   // 统计栏按对话口径刷新（缓存命中）
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
    const r = await (await fetch('/api/op/inject?chatId=' + encodeURIComponent(chatId || ''))).json();
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
        chatId,
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
let profileData = {};

async function loadProfiles() {
  try {
    const r = await (await fetch('/api/profiles')).json();
    if (!r.ok) return;
    profileData = r.profiles || {};
    profileInput.innerHTML = '<option value="">— 配置档案 —</option>';
    for (const name of Object.keys(profileData)) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name + (profileData[name].builtin ? ' ⭐' : '');
      profileInput.appendChild(o);
    }
    if (r.active) profileInput.value = r.active;
    profileInput.title = r.active ? `当前档案：${r.active}（选择即切换整套配置）` : '配置档案（端点 + 模型 + 参数整套切换）';
    profileSelect.innerHTML = '';
    for (const name of Object.keys(profileData)) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name + (profileData[name].builtin ? ' ⭐' : '');
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
      profileInput.title = `当前档案：${name}`;
      ensureModelOption(modelInput, r.model);
      modelInput.value = r.model;
      modelInput.title = `当前模型：${r.model}（档案「${name}」已切换）`;
      peakEligible = r.peakEligible !== false;
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
      peakEligible = r.peakEligible !== false;
      updatePeakBanner();
      await loadPresets();
      loadStats();
      apiMsg.className = 'api-msg ok';
      apiMsg.textContent = r.note || '已切换';
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
    peakEligible = pe !== false;   // 官方直连渠道才启用高峰提醒
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
      peakEligible = r.peakEligible !== false;
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
let customSkin = { ...CUSTOM_SKIN_DEFAULT };
try { customSkin = { ...CUSTOM_SKIN_DEFAULT, ...(JSON.parse(localStorage.getItem('mr-custom-skin')) || {}) }; } catch (e) { /* 首次 */ }
function saveCustomSkin() { localStorage.setItem('mr-custom-skin', JSON.stringify(customSkin)); }

function applyCustomSkin() {
  const { mode, hue, sat, light } = customSkin;
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
  if (prefs.theme === 'custom') {
    document.body.dataset.theme = 'default';   // 走默认结构，CSS 变量由 applyCustomSkin 覆盖
    applyCustomSkin();
  } else {
    document.documentElement.style.cssText = '';   // 清除自定义变量（还原主题定义）
    document.body.dataset.theme = prefs.theme || 'default';
  }
  // 背景 URL（自助美化）
  if (prefs.bgUrl && prefs.bgUrl.trim()) {
    document.body.style.setProperty('--bg-url', `url('${prefs.bgUrl.trim()}')`);
    document.body.classList.add('with-bg');
    document.body.classList.remove('bg-contain');
  } else {
    document.body.classList.remove('with-bg');
    document.body.style.removeProperty('--bg-url');
  }
  themeSelect.value = prefs.theme || 'default';
  const csBox = document.getElementById('custom-skin');
  if (csBox) csBox.classList.toggle('hidden', prefs.theme !== 'custom');
  const bgUrlInput = document.getElementById('bg-url-input');
  if (bgUrlInput) bgUrlInput.value = prefs.bgUrl || '';
}
themeSelect.addEventListener('change', () => {
  prefs.theme = themeSelect.value;
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
  csMode.value = customSkin.mode;
  csHue.value = customSkin.hue;
  csSat.value = customSkin.sat;
  csLight.value = customSkin.light;
  const apply = () => {
    customSkin = { mode: csMode.value, hue: Number(csHue.value), sat: Number(csSat.value), light: Number(csLight.value) };
    saveCustomSkin();
    if (prefs.theme === 'custom') applyCustomSkin();
    csNote.classList.remove('hidden');
    setTimeout(() => csNote.classList.add('hidden'), 1500);
  };
  csMode.addEventListener('change', apply);
  csHue.addEventListener('input', apply);
  csSat.addEventListener('input', apply);
  csLight.addEventListener('input', apply);
  document.getElementById('cs-reset').addEventListener('click', () => {
    customSkin = { ...CUSTOM_SKIN_DEFAULT };
    csMode.value = customSkin.mode;
    csHue.value = customSkin.hue;
    csSat.value = customSkin.sat;
    csLight.value = customSkin.light;
    saveCustomSkin();
    if (prefs.theme === 'custom') applyCustomSkin();
  });
  const bgUrlInput = document.getElementById('bg-url-input');
  if (bgUrlInput) {
    bgUrlInput.addEventListener('change', () => {
      prefs.bgUrl = bgUrlInput.value.trim();
      savePrefs();
      applySkin();
    });
  }
}

// ---------- 显示设置（localStorage 持久化） ----------
const PREFS_KEY = 'moonrabbitPrefs';
let prefs = { hlEnabled: true, theme: 'default', showThinking: true, peakConfirm: true, bgUrl: '' };
try {
  prefs = { ...prefs, ...(JSON.parse(localStorage.getItem(PREFS_KEY)) || {}) };
} catch (e) { /* 首次使用 */ }
function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }

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
  panel.appendChild(mk('显示思考过程（💭 折叠块）', prefs.showThinking !== false, (v) => { prefs.showThinking = v; }));
  panel.appendChild(mk('高峰时段发送确认（官方直连渠道）', prefs.peakConfirm !== false, (v) => { prefs.peakConfirm = v; }));
}
document.getElementById('settings-toggle').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('hidden');
});

// ---------- 剧情记忆：时间线 / 物品栏 / 历史检索 / 情绪 / 导出 ----------
const tmTabTl = document.getElementById('tm-tab-tl');
const tmTabInv = document.getElementById('tm-tab-inv');
const tmTabHs = document.getElementById('tm-tab-hs');
const tmTabEm = document.getElementById('tm-tab-em');
const tmTimeline = document.getElementById('tm-timeline');
const tmInventory = document.getElementById('tm-inventory');
const tmHistSearch = document.getElementById('tm-histsearch');
const tmEmotions = document.getElementById('tm-emotions');
const tmExport = document.getElementById('tm-export');
const tmExportBox = document.getElementById('tm-export-box');

async function loadEmotions() {
  const box = document.getElementById('em-list');
  const nameInput = document.getElementById('em-name');
  try {
    const { emotions } = await (await fetch(`/api/emotions?chatId=${encodeURIComponent(chatId || '')}`)).json();
    const names = Object.keys(emotions || {});
    box.innerHTML = '';
    if (!names.length) {
      box.innerHTML = '（暂无情绪记录）';
      return;
    }
    for (const n of names) {
      const d = document.createElement('div');
      d.className = 'em-item';
      d.innerHTML = `<span class="em-name">${n}</span><span class="em-text">${emotions[n]}</span>`;
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
      body: JSON.stringify({ chatId, name, emotion }),
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
    const { turns } = await (await fetch(`/api/timeline?limit=15&chatId=${encodeURIComponent(chatId || '')}`)).json();
    tmTimeline.innerHTML = turns.length ? '' : '（暂无回合记录）';
    for (const t of turns) {
      const d = document.createElement('div');
      d.className = 'tm-item';
      const ev = (t.event || '').slice(0, 60);
      const loc = t.location ? `<span class="loc">${t.location}</span>` : '';
      const gain = t.items_gain.length ? `<span class="gain"> ＋${t.items_gain.map((g) => g.name).join('、')}</span>` : '';
      const loss = t.items_loss.length ? `<span class="loss"> －${t.items_loss.join('、')}</span>` : '';
      const emo = t.emotion && Object.keys(t.emotion).length ? `<span class="emotag"> 💗${Object.entries(t.emotion).map(([n, v]) => `${n}=${v}`).join('、')}</span>` : '';
      d.innerHTML = `<div class="t">${t.story_time || '?'}｜${ev || '（无事件摘要）'}</div>${loc}${gain}${loss}${emo}`;
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
              body: JSON.stringify({ chatId, id: t.id }),
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
let tmItemEditBox = null;   // 当前展开的编辑容器（同一时间只开一个）
function openTmItemEdit(itemEl, t, mode) {
  if (tmItemEditBox && tmItemEditBox.parentNode) tmItemEditBox.remove();
  const label = mode === 'edit' ? '✏️ 修改时间线记录' : '＋ 在该条之后补充时间线记录';
  const box = document.createElement('div');
  box.className = 'tm-edit tm-item-edit';
  box.innerHTML = `
    <div class="tm-edit-title">${label}</div>
    <div class="em-row"><input data-f="story_time" type="text" placeholder="时间（如：8/9 早上）"><input data-f="location" type="text" placeholder="地点（可留空）"></div>
    <div class="em-row"><input data-f="characters" type="text" placeholder="在场角色（顿号分隔，可留空）"><input data-f="costume" type="text" placeholder="着装变化（可留空）"></div>
    <div class="em-row"><input data-f="atmosphere" type="text" placeholder="氛围（可留空）"><input data-f="event" type="text" placeholder="事件一句话（可留空）"></div>
    <div class="em-row"><button class="head-btn">✅ 保存</button><button class="ma-btn">取消</button><span class="tm-item-note"></span></div>`;
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
    chatId,
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
  box.querySelector('.ma-btn').addEventListener('click', () => box.remove());
  itemEl.insertAdjacentElement('afterend', box);
  tmItemEditBox = box;
  box.querySelector('input').focus();
}

async function loadInventory() {
  try {
    const { inventory, recent } = await (await fetch(`/api/inventory?chatId=${encodeURIComponent(chatId || '')}`)).json();
    tmInventory.innerHTML = '';
    if (inventory.length) {
      const head = document.createElement('div');
      head.innerHTML = '<b>当前物品栏：</b>';
      tmInventory.appendChild(head);
      const list = document.createElement('div');
      list.innerHTML = inventory.map((i) => `<span class="chip">${i.name}${i.count > 1 ? ` ×${i.count}` : ''}${i.holder ? `（${i.holder}）` : ''}</span>`).join(' ');
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
  const map = { tl: [tmTimeline, tmEditTl], inv: [tmInventory, tmEditInv], hs: [tmHistSearch], em: [tmEmotions] };
  for (const [k, els] of Object.entries(map)) {
    els.forEach(el => { if (el) el.classList.toggle('hidden', k !== active); });
  }
}
tmTabTl.addEventListener('click', () => {
  tmTabTl.classList.add('active'); tmTabInv.classList.remove('active'); tmTabHs.classList.remove('active'); tmTabEm.classList.remove('active');
  setTmTabVis('tl');
});
tmTabInv.addEventListener('click', () => {
  tmTabInv.classList.add('active'); tmTabTl.classList.remove('active'); tmTabHs.classList.remove('active'); tmTabEm.classList.remove('active');
  setTmTabVis('inv');
  loadInventory();
});
tmTabHs.addEventListener('click', () => {
  tmTabHs.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabEm.classList.remove('active');
  setTmTabVis('hs');
  document.getElementById('hs-input').focus();
});
tmTabEm.addEventListener('click', () => {
  tmTabEm.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabHs.classList.remove('active');
  setTmTabVis('em');
  loadEmotions();
});

// ---------- 剧情记忆手动编辑：时间线补记 / 物品栏增删 / 当前着装 ----------
// 手动补记一条回合
document.getElementById('mt-btn').addEventListener('click', async () => {
  const note = document.getElementById('mt-note');
  const payload = {
    chatId,
    story_time: document.getElementById('mt-time').value.trim(),
    location: document.getElementById('mt-loc').value.trim(),
    characters: document.getElementById('mt-char').value.trim(),
    costume: document.getElementById('mt-cos').value.trim(),
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
      document.getElementById('mt-event').value = '';
      loadTimeline();
    }
  } catch (e) { note.textContent = `✗ ${e.message}`; }
  note.classList.remove('hidden');
  setTimeout(() => note.classList.add('hidden'), 5000);
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
      body: JSON.stringify({ chatId, action, name, holder }),
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
    const { wardrobes } = await (await fetch(`/api/wardrobe/current?chatId=${encodeURIComponent(chatId || '')}`)).json();
    const names = Object.keys(wardrobes || {});
    box.innerHTML = names.length
      ? '当前着装：' + names.map((n) => `<span class="chip">${n}：${wardrobes[n]}</span>`).join(' ')
      : '当前着装：未记录（换装后自动更新）';
  } catch (e) { box.textContent = '当前着装：读取失败'; }
}

// 历史消息检索（本地关键词，零 API）：高亮命中词 + 点击展开全文
function hsHighlight(text, ranges) {
  let out = '', last = 0;
  for (const r of ranges) {
    if (r.from < last) continue;                       // 区间可能重叠，跳过已被覆盖部分
    out += escapeHtml(text.slice(last, r.from)) + '<mark>' + escapeHtml(text.slice(r.from, r.to)) + '</mark>';
    last = r.to;
  }
  out += escapeHtml(text.slice(last));
  return out;
}
async function hsSearch() {
  const q = document.getElementById('hs-input').value.trim();
  const box = document.getElementById('hs-result');
  if (!q) { box.textContent = '（输入关键词，空格分隔多个词 = AND）'; return; }
  const cur = document.getElementById('hs-scope-cur').checked;
  box.innerHTML = '检索中…';
  try {
    const params = new URLSearchParams({ q, limit: '30' });
    if (cur && chatId) params.set('chatId', chatId);
    const d = await (await fetch(`/api/history/search?${params}`)).json();
    if (d.error) { box.textContent = `错误：${d.error}`; return; }
    if (!d.total) { box.textContent = `（无结果：${d.kws.join(' + ') || d.query}）`; return; }
    box.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'hs-total';
    head.textContent = `命中 ${d.total} 条（${cur ? '仅当前会话' : '全部会话'}）`;
    box.appendChild(head);
    for (const r of d.results) {
      const item = document.createElement('div');
      item.className = 'hs-item';
      const who = r.role === 'user' ? '你' : 'AI';
      const meta = `<span class="hs-meta">[${r.chatTitle}] #${r.seq} ${who} · 命中 ${r.hits} 次 · 分数 ${r.score}</span>`;
      item.innerHTML = `<div class="hs-meta-row">${meta}</div><div class="hs-snip">${hsHighlight(r.snippet, r.ranges)}</div>`;
      const full = document.createElement('div');
      full.className = 'hs-full hidden';
      full.innerHTML = hsHighlight(r.content, r.ranges);
      const btn = document.createElement('button');
      btn.className = 'attach hs-toggle';
      btn.textContent = '展开全文';
      btn.addEventListener('click', () => {
        const isHidden = full.classList.contains('hidden');
        full.classList.toggle('hidden', !isHidden);
        btn.textContent = isHidden ? '收起' : '展开全文';
      });
      item.appendChild(full);
      item.appendChild(btn);
      box.appendChild(item);
    }
  } catch (e) { box.textContent = `检索失败：${e.message}`; }
}
document.getElementById('hs-btn').addEventListener('click', hsSearch);
document.getElementById('hs-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') hsSearch(); });

tmExport.addEventListener('click', async () => {
  try {
    const text = await (await fetch(`/api/timeline/export?chatId=${encodeURIComponent(chatId || '')}`)).text();
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
    const d = await (await fetch(`/api/prompt/latest?chatId=${encodeURIComponent(chatId || '')}`)).json();
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
let opView = localStorage.getItem('mr-op-view') || '';
if (opView && [...viewSelect.options].some((o) => o.value === opView)) viewSelect.value = opView;

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
      body: JSON.stringify({ chatId, view: v }),
    })).json();
    if (r.error) { viewNote.textContent = `✗ ${r.error}`; }
    else {
      opView = v;
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
      body: JSON.stringify({ chatId, enabled: en }),
    })).json();
    if (r.error) { els.opNote.textContent = '✗ ' + r.error; }
    else { setExpand(en); localStorage.setItem('mr-op-expand', en ? '1' : '0'); els.opNote.textContent = '✓ ' + r.note; }
  } catch (e) { els.opNote.textContent = '✗ ' + e.message; }
  els.opNote.classList.remove('hidden');
  els.expandBtn.disabled = false;
  setTimeout(() => els.opNote.classList.add('hidden'), 6000);
});

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
        body: JSON.stringify({ chatId, tools: sel }),
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
      body: JSON.stringify({ chatId, character: ch, outfit, worn: day }),
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
    const s = await (await fetch('/api/stats?chatId=' + encodeURIComponent(chatId))).json();
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
let peakEligible = true;   // 端点是否为 DeepSeek 官方直连（峰谷定价渠道）
function isPeakHours(d) {
  const day = d.getDay();            // 0=周日 6=周六
  if (day === 0 || day === 6) return false;   // 2026-08-23 起周末全天为低谷价（不计峰谷）
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}
function updatePeakBanner() {
  const b = document.getElementById('peak-banner');
  if (b) b.classList.toggle('hidden', !(peakEligible && isPeakHours(new Date())));
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
let tourIdx = 0;
function tourShow() {
  const overlay = document.getElementById('tour-overlay');
  const body = document.getElementById('tour-body');
  const dots = document.getElementById('tour-dots');
  const prev = document.getElementById('tour-prev');
  const next = document.getElementById('tour-next');
  const step = tourSteps[tourIdx];
  if (!step) return;
  body.textContent = step.body;
  dots.innerHTML = tourSteps.map((_, i) => `<span class="dot ${i === tourIdx ? 'on' : ''}"></span>`).join('');
  prev.classList.toggle('hidden', tourIdx === 0);
  next.textContent = tourIdx === tourSteps.length - 1 ? '开始使用' : '下一步';
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
  if (tourIdx < tourSteps.length - 1) { tourIdx += 1; tourShow(); } else tourDone();
});
document.getElementById('tour-prev').addEventListener('click', () => {
  if (tourIdx > 0) { tourIdx -= 1; tourShow(); }
});
document.getElementById('tour-skip').addEventListener('click', tourDone);
function maybeStartTour() {
  if (localStorage.getItem(TOUR_KEY)) return;
  tourIdx = 0;
  document.getElementById('tour-overlay').classList.remove('hidden');
  tourShow();
}

// ---------- 事件 ----------
els.send.addEventListener('click', send);
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
let autoSaveTimer = null;
els.input.addEventListener('input', () => {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => { if (history.length) saveChat(); }, 3000);
});
// Before unload: try to save（keepalive 确保页面卸载时请求仍发出；异步 saveChat 会随页面销毁丢失）
window.addEventListener('beforeunload', () => {
  if (!chatId || !history.length) return;
  const firstUser = history.find((m) => m.role === 'user');
  const title = chatTitle || (firstUser ? firstUser.content.slice(0, 24) : '新对话');
  try {
    fetch('/api/chats/' + chatId, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, messages: history }),
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
  pendingContext = text;
  els.manAttachBox.classList.add('hidden');
  els.manAttachInput.value = '';
  els.manAttachNote.classList.remove('hidden');
});

// ---------- 会话常驻设定（📌 每轮注入 system，防遗忘；按会话隔离） ----------
// Task15 多槽位：其他 / 背景 / 关系 / 规则（页签切换编辑，保存时整包提交）
const NOTE_SLOTS_UI = ['其他', '背景', '关系', '规则'];
let noteSlotsData = {};      // 内存槽位数据
let noteSlotsPristine = {};  // 打开/加载时的原始槽位快照（取消时整体还原，防页签暂存无法撤销）
let currentNoteSlot = '其他';

function noteSlotTab(name) {
  return els.noteAttachBox.querySelector(`.note-slot-tab[data-slot="${name}"]`);
}
function switchNoteSlot(name) {
  currentNoteSlot = name;
  els.noteAttachInput.value = noteSlotsData[name] || '';
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
      body: JSON.stringify({ chatId, get: true }),
    })).json();
    noteSlotsData = (r && r.slots && typeof r.slots === 'object') ? r.slots : {};
    noteSlotsPristine = JSON.parse(JSON.stringify(noteSlotsData));   // 快照：取消时还原到本次加载值
    const hasAny = NOTE_SLOTS_UI.some((k) => String(noteSlotsData[k] || '').trim());
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
    noteSlotsData[currentNoteSlot] = els.noteAttachInput.value.trim();
    switchNoteSlot(k);
  });
});
els.noteAttachCancel.addEventListener('click', () => {
  noteSlotsData = JSON.parse(JSON.stringify(noteSlotsPristine));   // 整体还原到加载时快照（含切过页签的暂存）
  switchNoteSlot(currentNoteSlot);
  els.noteAttachBox.classList.add('hidden');
});
els.noteAttachOk.addEventListener('click', async () => {
  noteSlotsData[currentNoteSlot] = els.noteAttachInput.value.trim();   // 先同步当前槽
  try {
    const r = await (await fetch('/api/op/note', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, slots: noteSlotsData }),
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

// ---------- 启动 ----------
document.getElementById('card-world').style.display = '';
renderSettings();
applySkin();
bindCustomSkin();
updatePeakBanner();
setInterval(updatePeakBanner, 60000);
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
  if (e.key === CUR_CHAT_KEY && e.newValue !== chatId) {
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
