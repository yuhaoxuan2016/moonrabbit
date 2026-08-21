// app.js —— 通用多角色 RP / 互动小说界面前端逻辑
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
  return `<span class="avatar-badge" style="background:${nameColor(name)}">${(name || '?').slice(0, 1)}</span>`;
}

function parseSegments(text) {
  const segs = [];
  let cur = null;
  const lines = text.split('\n');
  const push = () => { if (cur && cur.text.trim()) segs.push(cur); cur = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m1 = /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z·]{0,10})[：:]\s*(.*)$/.exec(line);
    const m2 = /^([\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z·]{0,10})[（(](.+)[）)]$/.exec(line);
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
    // 重建气泡内容（显示旧版文本）
    const bub = oldWrap.querySelector('.bubble');
    if (bub) { bub.innerHTML = ''; bub.appendChild(document.createTextNode(stripTurnTags(content))); }
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
  bub.innerHTML = highlightText(content);
  body.appendChild(bub);
  if (role === 'user') {
    row.className = 'msg user';
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.borderColor = '#60a5fa';
    av.innerHTML = avatarHtml('rabbit');
    const nm = document.createElement('div');
    nm.className = 'char-name';
    nm.textContent = 'rabbit（你）';
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
    contentNode.innerHTML = highlightText(seg.text.trim());
    if (seg.actionOnly) { contentNode.className = 'action'; contentNode.innerHTML = `（${highlightText(seg.text.trim())}）`; }
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
  bub.innerHTML = highlightText(content);
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
  // 高峰时段强提醒：官方直连渠道 + 高峰时间 + 发送前确认（可设置关闭）
  if (peakEligible && prefs.peakConfirm !== false && isPeakHours(new Date())) {
    if (!confirm('⚠️ 当前高峰时段（9:00-12:00 / 14:00-18:00）\nAPI 费用翻倍、可能限流变卡。\n\n继续发送吗？')) {
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
          acc += ev.text;
          tempBub.textContent = stripTurnTags(acc);
          els.messages.scrollTop = els.messages.scrollHeight;
        } else if (ev.type === 'thinking') {
          thinkAcc += ev.text;
        } else if (ev.type === 'tools') {
          renderThinking(`🔧 ${(ev.trace || []).join('；')}`);
        } else if (ev.type === 'summarized') {
          renderThinking(`💾 ${ev.note}`);
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
  try {
    await fetch('/api/chats/' + chatId, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, messages: history }),
    });
    chatTitle = title;
  } catch (e) { /* 忽略 */ }
}

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
      d.innerHTML = `<span class="ci-title"></span><span class="ci-time">${time}</span><span class="ci-del" title="删除">×</span>`;
      d.querySelector('.ci-title').textContent = c.title;
      d.querySelector('.ci-title').addEventListener('click', () => openChat(c.id));
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
    loadStats();   // 统计栏按对话口径刷新（缓存命中）
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
        const del = document.createElement('button');
        del.className = 'ma-btn tm-del';
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
        d.appendChild(del);
      }
      tmTimeline.appendChild(d);
    }
  } catch (e) { tmTimeline.textContent = '时间线读取失败'; }
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

tmTabTl.addEventListener('click', () => {
  tmTabTl.classList.add('active'); tmTabInv.classList.remove('active'); tmTabHs.classList.remove('active'); tmTabEm.classList.remove('active');
  tmTimeline.classList.remove('hidden'); tmInventory.classList.add('hidden'); tmHistSearch.classList.add('hidden'); tmEmotions.classList.add('hidden');
});
tmTabInv.addEventListener('click', () => {
  tmTabInv.classList.add('active'); tmTabTl.classList.remove('active'); tmTabHs.classList.remove('active'); tmTabEm.classList.remove('active');
  tmInventory.classList.remove('hidden'); tmTimeline.classList.add('hidden'); tmHistSearch.classList.add('hidden'); tmEmotions.classList.add('hidden');
  document.getElementById('inv-edit').classList.remove('hidden');
  loadInventory();
});
tmTabHs.addEventListener('click', () => {
  tmTabHs.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabEm.classList.remove('active');
  tmHistSearch.classList.remove('hidden'); tmTimeline.classList.add('hidden'); tmInventory.classList.add('hidden'); tmEmotions.classList.add('hidden');
  document.getElementById('hs-input').focus();
});
tmTabEm.addEventListener('click', () => {
  tmTabEm.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabHs.classList.remove('active');
  tmEmotions.classList.remove('hidden'); tmTimeline.classList.add('hidden'); tmInventory.classList.add('hidden'); tmHistSearch.classList.add('hidden');
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
async function loadStats() {
  try {
    const s = await (await fetch('/api/stats?chatId=' + encodeURIComponent(chatId))).json();
    const c = s.current, t = s.total, ch = s.chat;
    const chatTxt = ch
      ? `<b>${ch.turns}</b> 轮 · <b>${ch.calls}</b> 次调用 | LLM 总耗时 <b>${fmtDur(ch.llmSec)}</b> | 首 token 平均 <b>${(ch.firstTokenAvgMs / 1000).toFixed(1)}s</b> · <b>${ch.tokPerSec}</b> tok/s | 缓存命中 <b>${ch.cacheRate}%</b> | 输入 <b>${fmtTok(ch.tokensIn)}</b> · 输出 <b>${fmtTok(ch.tokensOut)}</b> tok`
      : `—`;
    statsBar.innerHTML = `模型 <b>${s.model}</b> | 本对话 ${chatTxt} | 累计 <b>${c.turns}</b> 轮 · 缓存 <b>${c.cacheRate}%</b> · <b>${fmtTok(c.tokensIn + c.tokensOut)}</b> tok | 全部 <b>${t.turns}</b> 轮 · 缓存 <b>${t.cacheRate}%</b> · <b>${fmtTok(t.tokensIn + t.tokensOut)}</b> tok`;
  } catch (e) { /* 忽略 */ }
}

// ---------- 高峰时段提示条（官方直连渠道 + 高峰时间才生效） ----------
let peakEligible = true;   // 端点是否为 DeepSeek 官方直连（峰谷定价渠道）
function isPeakHours(d) {
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
  { title: '✍️ 输入区', body: '底部输入区支持「角色名：台词」格式；可切换视角、开扩写、勾选联网工具。Enter 发送，Shift+Enter 换行。', target: 'input' },
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
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

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
async function loadSessionNote() {
  try {
    const r = await (await fetch('/api/op/note', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, get: true }),
    })).json();
    if (r && r.note) {
      els.noteAttachInput.value = r.note;
      els.noteAttachBtn.textContent = '📌 会话常驻设定（已设置，点击查看/修改）';
    } else {
      els.noteAttachInput.value = '';
      els.noteAttachBtn.textContent = '📌 会话常驻设定（每轮注入，防遗忘）';
    }
  } catch (e) { /* 忽略 */ }
}
els.noteAttachBtn.addEventListener('click', () => {
  els.noteAttachBox.classList.toggle('hidden');
});
els.noteAttachCancel.addEventListener('click', () => {
  els.noteAttachBox.classList.add('hidden');
});
els.noteAttachOk.addEventListener('click', async () => {
  const text = els.noteAttachInput.value.trim();
  try {
    const r = await (await fetch('/api/op/note', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, note: text }),
    })).json();
    if (r && r.ok) {
      els.noteAttachBox.classList.add('hidden');
      els.noteAttachNote.classList.remove('hidden');
      setTimeout(() => els.noteAttachNote.classList.add('hidden'), 2500);
      loadSessionNote();
    }
  } catch (e) { /* 忽略 */ }
});

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
