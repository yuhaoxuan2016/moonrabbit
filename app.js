// app.js —— 通用多角色 RP / 互动小说界面前端逻辑
'use strict';

const els = {
  messages: document.getElementById('messages'),
  typing: document.getElementById('typing'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
};

// 通用模式：不注入任何预设真值源，世界设定由用户自填
const GENERIC = true;
const WORLD_KEY = 'genericWorldSetting';
const worldInput = document.getElementById('world-setting');
const worldNote = document.getElementById('world-note');
{
  const title = document.querySelector('.subtitle');
  if (title) title.textContent = '通用 RP 界面 · 设定自填';
  els.input.placeholder = '开始输入你的剧情……';
  try { worldInput.value = localStorage.getItem(WORLD_KEY) || ''; } catch (e) { /* ignore */ }
  let saveTimer = null;
  worldInput.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(WORLD_KEY, worldInput.value);
        worldNote.classList.remove('hidden');
        setTimeout(() => worldNote.classList.add('hidden'), 1500);
      } catch (e) { /* ignore */ }
    }, 600);
  });
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
  history = history.slice(0, idx);          // 截断：该条及其后全部作废
  const wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  if (wrap) {
    let node = wrap;
    while (node) { const next = node.nextSibling; node.remove(); node = next; }
  }
  generate();
}

function deleteMsg(seq) {
  if (streaming) return;
  const idx = history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  history.splice(idx, 1);
  const wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  if (wrap) wrap.remove();
  saveChat();
}

function renderAssistant(content, seq) {
  const wrap = makeWrap('assistant', seq);
  const segs = parseSegments(content);
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
        worldSetting: worldInput.value,
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
          tempBub.textContent = acc;
          els.messages.scrollTop = els.messages.scrollHeight;
        } else if (ev.type === 'thinking') {
          thinkAcc += ev.text;
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
      history.push({ role: 'assistant', content: acc.trim(), seq });
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
      else if (m.role === 'assistant') renderAssistant(m.content, m.seq);
    }
    loadChatList();
    loadTimeline();   // 剧情记忆按会话隔离，切会话后刷新
    loadInventory();
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
    document.getElementById('api-thinking').value = c.thinking || 'auto';
    document.getElementById('api-budget').value = c.thinkingBudget || 2048;
    document.getElementById('api-context').value = c.maxContext ?? 64000;
    document.getElementById('api-autosummary').value = String(c.autoSummary !== false);
    document.getElementById('api-sumthreshold').value = c.autoSummaryThreshold || 12000;
    apiNow.textContent = `当前：${c.protocol === 'openai' ? 'OpenAI 兼容' : 'Anthropic 兼容'} · ${c.baseURL} · ${c.model}${c.apiKeyMasked ? ' · Key ' + c.apiKeyMasked : ''} · max_tokens ${c.maxTokens} · thinking ${c.thinking} · context ${c.maxContext ?? 64000}`;
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

// ---------- 皮肤（主题，无外部素材） ----------
const themeSelect = document.getElementById('theme-select');
function applySkin() {
  document.body.dataset.theme = prefs.theme || 'default';
  themeSelect.value = prefs.theme || 'default';
}
themeSelect.addEventListener('change', () => {
  prefs.theme = themeSelect.value;
  savePrefs();
  applySkin();
});

// ---------- 显示设置（localStorage 持久化） ----------
const PREFS_KEY = 'moonrabbitPrefs';
let prefs = { hlEnabled: true, theme: 'default', showThinking: true, peakConfirm: true };
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

// ---------- 剧情记忆：时间线 / 物品栏 / 历史检索 / 导出 ----------
const tmTabTl = document.getElementById('tm-tab-tl');
const tmTabInv = document.getElementById('tm-tab-inv');
const tmTabHs = document.getElementById('tm-tab-hs');
const tmTimeline = document.getElementById('tm-timeline');
const tmInventory = document.getElementById('tm-inventory');
const tmHistSearch = document.getElementById('tm-histsearch');
const tmExport = document.getElementById('tm-export');
const tmExportBox = document.getElementById('tm-export-box');

async function loadTimeline() {
  try {
    const { turns } = await (await fetch(`/api/timeline?limit=10&chatId=${encodeURIComponent(chatId || '')}`)).json();
    tmTimeline.innerHTML = turns.length ? '' : '（暂无回合记录）';
    for (const t of turns) {
      const d = document.createElement('div');
      d.className = 'tm-item';
      const ev = (t.event || '').slice(0, 60);
      const loc = t.location ? `<span class="loc">${t.location}</span>` : '';
      const gain = t.items_gain.length ? `<span class="gain"> ＋${t.items_gain.map((g) => g.name).join('、')}</span>` : '';
      const loss = t.items_loss.length ? `<span class="loss"> －${t.items_loss.join('、')}</span>` : '';
      d.innerHTML = `<div class="t">${t.story_time || '?'}｜${ev || '（无事件摘要）'}</div>${loc}${gain}${loss}`;
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
  tmTabTl.classList.add('active'); tmTabInv.classList.remove('active'); tmTabHs.classList.remove('active');
  tmTimeline.classList.remove('hidden'); tmInventory.classList.add('hidden'); tmHistSearch.classList.add('hidden');
});
tmTabInv.addEventListener('click', () => {
  tmTabInv.classList.add('active'); tmTabTl.classList.remove('active'); tmTabHs.classList.remove('active');
  tmInventory.classList.remove('hidden'); tmTimeline.classList.add('hidden'); tmHistSearch.classList.add('hidden');
  loadInventory();
});
tmTabHs.addEventListener('click', () => {
  tmTabHs.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active');
  tmHistSearch.classList.remove('hidden'); tmTimeline.classList.add('hidden'); tmInventory.classList.add('hidden');
  document.getElementById('hs-input').focus();
});

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
let opView = localStorage.getItem('rw-op-view') || '';
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
      localStorage.setItem('rw-op-view', v);
      viewNote.textContent = `✓ ${r.note}`;
    }
  } catch (e) { viewNote.textContent = `✗ ${e.message}`; }
  viewNote.classList.remove('hidden');
  viewBtn.disabled = false;
  setTimeout(() => viewNote.classList.add('hidden'), 6000);
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
    if (!r.error) { wdOutfit.value = ''; wdDay.value = ''; }
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
    const s = await (await fetch('/api/stats')).json();
    const c = s.current, t = s.total;
    statsBar.innerHTML = `模型 <b>${s.model}</b> | <b>${c.turns}</b> 轮 · <b>${c.calls}</b> 次调用 | LLM 总耗时 <b>${fmtDur(c.llmSec)}</b> | 首 token 平均 <b>${(c.firstTokenAvgMs / 1000).toFixed(1)}s</b> · <b>${c.tokPerSec}</b> tok/s | 缓存命中 <b>${c.cacheRate}%</b> | 输入 <b>${fmtTok(c.tokensIn)}</b> · 输出 <b>${fmtTok(c.tokensOut)}</b> tok | 全部: <b>${t.turns}</b> 轮 · <b>${fmtTok(t.tokensIn + t.tokensOut)}</b> tok`;
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

// ---------- 事件 ----------
els.send.addEventListener('click', send);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// ---------- 启动 ----------
document.getElementById('card-world').style.display = '';
renderSettings();
applySkin();
updatePeakBanner();
setInterval(updatePeakBanner, 60000);
loadTimeline();
loadStats();
loadModel();
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
