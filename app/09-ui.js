// app/09-ui.js —— 快捷键 / 命令面板 / 搜索 / 折叠状态 / 主题 / 导览 / 统计 / 编辑弹窗
// F 批自 app.js 整体搬迁，零逻辑改动（括号配对切块）。
// 注：本文件只放函数定义；顶层事件绑定留在 app.js，待 F-09 集中到 10-bind.js。
'use strict';

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
    statsBar.innerHTML = `模型 <b>${escapeHtml(s.model)}</b> | 本对话 ${chatTxt} | 累计 <b>${Number(c.turns) || 0}</b> 轮 · 缓存 <b>${Number(c.cacheRate) || 0}%</b> · <b>${fmtTok(c.tokensIn + c.tokensOut)}</b> tok | 全部 <b>${Number(t.turns) || 0}</b> 轮 · 缓存 <b>${Number(t.cacheRate) || 0}%</b> · <b>${fmtTok(t.tokensIn + t.tokensOut)}</b> tok | ${costTxt}`;
  } catch (e) { /* 忽略 */ }
}

function isPeakHours(d) {
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (OFFPEAK_HOLIDAYS.has(key)) return false;   // 法定节假日全天空闲价（即使落在工作日）
  const day = d.getDay();            // 0=周日 6=周六
  if (day === 0 || day === 6) return false;   // 周末全天为低谷价（调休上班的周末同样按空闲价）
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

function updatePeakBanner() {
  const b = document.getElementById('peak-banner');
  if (b) b.classList.toggle('hidden', !(App.peakEligible && isPeakHours(new Date())));
}

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

function maybeStartTour() {
  if (localStorage.getItem(TOUR_KEY)) return;
  App.tourIdx = 0;
  document.getElementById('tour-overlay').classList.remove('hidden');
  tourShow();
}

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
  el.innerHTML = `<span>约 ${inputTokens.toLocaleString()} tok</span> · <span>上下文 ${(contextTokens/1000).toFixed(1)}K/${(maxCtx/1000).toFixed(0)}K</span> · <span style="color:${pct>80?'var(--danger)':pct>60?'#f0d080':'var(--muted,#888)'}">余量 ${(remaining/1000).toFixed(1)}K</span>`;
}

function openShortcutPanel() {
  if (document.getElementById('shortcut-panel')) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'shortcut-panel';
  const rows = SHORTCUT_LIST.map(([k, d]) =>
    `<div style="display:flex;justify-content:space-between;gap:16px;padding:6px 0;border-bottom:1px solid var(--border)">
      <span style="font-family:ui-monospace,Consolas,monospace;color:var(--accent);white-space:nowrap">${safeHtml(k)}</span>
      <span style="color:var(--muted);text-align:right">${safeHtml(d)}</span>
    </div>`).join('');
  overlay.innerHTML = `<div class="modal-box u-modal-sm">
    <div style="font-size:15px;font-weight:500;margin-bottom:12px">⌨️ 快捷键速查</div>
    ${rows}
    <div class="u-row-end" style="margin-top:16px"><button id="sc-close" class="btn-sm u-btn-lg">关闭</button></div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#sc-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

function toggleSidebar(open) {
  if (sidebarEl) sidebarEl.classList.toggle('open', open);
  if (sidebarOverlay) sidebarOverlay.classList.toggle('open', open);
}

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

function initMsgSearch() {
  const chatInner = els.messages && els.messages.parentNode;
  if (!chatInner || chatInner.querySelector('.msg-search-bar')) return;   // 已初始化
  // 样式内联注入（两版通用，不依赖 style.css）
  if (!document.getElementById('msg-search-style')) {
    const st = document.createElement('style');
    st.id = 'msg-search-style';
    st.textContent = `
      .msg-search-bar{display:flex;align-items:center;gap:8px;padding:4px 10px;background:var(--card);border:1px solid var(--border);border-radius:10px;margin:6px 10px 2px;}
      .msg-search-bar.hidden{display:none;}
      .msg-search-toggle{background:var(--card);border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:2px 10px;font-size:13px;cursor:pointer;flex:none;opacity:.75;}
      .msg-search-toggle:hover{opacity:1;color:var(--accent);border-color:var(--accent);}
      .msg-search-inputs{display:flex;align-items:center;gap:8px;flex:1;min-width:0;}
      .msg-search-inputs.hidden{display:none;}
      .msg-search-bar input{flex:1;min-width:0;background:var(--bg2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:5px 9px;font-size:13px;outline:none;}
      .msg-search-bar input:focus{border-color:var(--accent);}
      .msg-search-info{color:var(--muted);font-size:12px;white-space:nowrap;}
      .msg-search-bar button{background:var(--card);border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:3px 9px;font-size:12px;cursor:pointer;flex:none;}
      .msg-search-bar button:hover{color:var(--accent);border-color:var(--accent);}
      .msg-wrap.msg-search-hit{outline:2px solid var(--accent);outline-offset:-2px;border-radius:10px;}
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

function editRegexRule(rule) {
  if (!rule) rule = { id: 'rule_' + Date.now(), name: '', pattern: '', replacement: '', flags: 'g', enabled: true };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">编辑过滤规则</div><label class="api-field">名称<input id="rr-name" type="text" value="${escapeHtml(rule.name||'')}" style="width:100%"></label><label class="api-field">正则表达式<input id="rr-pattern" type="text" value="${escapeHtml(rule.pattern||'')}" style="width:100%;font-family:monospace"></label><label class="api-field">替换为<input id="rr-replacement" type="text" value="${escapeHtml(rule.replacement||'')}" style="width:100%"></label><label class="api-field">标志<input id="rr-flags" type="text" value="${escapeHtml(rule.flags||'g')}" style="width:80px"></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="rr-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="rr-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#rr-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#rr-save').onclick = async () => {
    await fetch('/api/regex-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', rule: { id: rule.id, name: overlay.querySelector('#rr-name').value.trim(), pattern: overlay.querySelector('#rr-pattern').value, replacement: overlay.querySelector('#rr-replacement').value, flags: overlay.querySelector('#rr-flags').value, enabled: rule.enabled !== false } }) });
    overlay.remove(); loadRegexRulesUI(); loadRegexRules();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

function editLorebookEntry(id, entry) {
  const isNew = !id;
  if (!entry) entry = { name: '', keywords: [], content: '', enabled: true, priority: 0, constant: false, matchMode: 'any' };
  if (isNew) id = 'entry_' + Date.now();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:550px;max-height:85vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${isNew?'新建':'编辑'}设定条目</div><label class="api-field">名称<input id="lb-name" type="text" value="${escapeHtml(entry.name||'')}" style="width:100%"></label><label class="api-field">关键词（逗号分隔）<input id="lb-keywords" type="text" value="${escapeHtml((entry.keywords||[]).join(', '))}" style="width:100%"></label><label class="api-field">内容<textarea id="lb-content" class="world-setting" rows="6" style="width:100%">${escapeHtml(entry.content||'')}</textarea></label><div style="display:flex;gap:12px;margin-top:8px"><label><input type="checkbox" id="lb-enabled" ${entry.enabled!==false?'checked':''}> 启用</label><label><input type="checkbox" id="lb-constant" ${entry.constant?'checked':''}> 常驻注入</label></div><div style="display:flex;gap:12px;margin-top:8px"><label class="api-field">优先级<input id="lb-priority" type="number" value="${entry.priority||0}" style="width:80px"></label><label class="api-field">匹配模式<select id="lb-matchmode"><option value="any" ${entry.matchMode==='any'?'selected':''}>任一关键词</option><option value="all" ${entry.matchMode==='all'?'selected':''}>全部关键词</option></select></label></div><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="lb-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="lb-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
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

async function openWbEditor(bookId) {
  try {
    const r = await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'get', bookId }) });
    const d = await r.json();
    if (d.error) { toast(d.error); return; }
    App.wbCurrent = bookId;
    App.wbEntries = d.entries || {};
    const ed = document.getElementById('wb-editor');
    const title = document.getElementById('wb-editor-title');
    if (ed) ed.style.display = '';
    if (title) title.textContent = '📖 ' + (d.book.name || bookId) + '（' + (d.book.scope === 'global' ? '全局' : '按会话') + '）· ' + Object.keys(App.wbEntries).length + ' 条';
    renderWbEntries();
  } catch (e) { toast('加载失败'); }
}

function closeWbEditor() {
  App.wbCurrent = null; App.wbEntries = {};
  const ed = document.getElementById('wb-editor');
  if (ed) ed.style.display = 'none';
}

function editWbEntry(eid, entry) {
  if (!App.wbCurrent) { toast('请先选择一本世界书'); return; }
  const isNew = !eid;
  if (!entry) entry = { name: '', keywords: [], content: '', enabled: true, priority: 50, constant: false, matchMode: 'any' };
  if (isNew) eid = 'e_' + Date.now();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = '<div class="modal-box" style="max-width:560px;max-height:85vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">' + (isNew ? '新建' : '编辑') + '世界书条目</div><label class="api-field">名称<input id="wb-name" type="text" value="' + safeHtml(entry.name || '') + '" style="width:100%"></label><label class="api-field">关键词（逗号分隔；每个 ≥2 字）<input id="wb-keywords" type="text" value="' + safeHtml((entry.keywords || []).join(', ')) + '" style="width:100%"></label><label class="api-field">内容<textarea id="wb-content" class="world-setting" rows="8" style="width:100%">' + safeHtml(entry.content || '') + '</textarea></label><div style="display:flex;gap:12px;margin-top:8px"><label class="api-field">注入方式<select id="wb-constant"><option value="0"' + (!entry.constant ? ' selected' : '') + '>关键词匹配</option><option value="1"' + (entry.constant ? ' selected' : '') + '>强制注入（每轮）</option></select></label><label class="api-field">匹配模式<select id="wb-matchmode"><option value="any"' + (entry.matchMode !== 'all' && entry.matchMode !== 'every' ? ' selected' : '') + '>任一关键词</option><option value="all"' + (entry.matchMode === 'all' || entry.matchMode === 'every' ? ' selected' : '') + '>全部关键词</option></select></label></div><div style="display:flex;gap:12px;margin-top:8px"><label class="api-field">优先级<input id="wb-priority" type="number" value="' + safeHtml(entry.priority || 0) + '" style="width:90px"></label><label style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="wb-enabled"' + (entry.enabled !== false ? ' checked' : '') + '> 启用</label></div><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="wb-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="wb-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>';
  document.body.appendChild(overlay);
  overlay.querySelector('#wb-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#wb-save').onclick = async () => {
    const payload = {
      name: overlay.querySelector('#wb-name').value.trim().slice(0, 60),
      keywords: overlay.querySelector('#wb-keywords').value.split(',').map(s => s.trim()).filter(Boolean),
      content: overlay.querySelector('#wb-content').value,
      constant: overlay.querySelector('#wb-constant').value === '1',
      matchMode: overlay.querySelector('#wb-matchmode').value,
      priority: Number(overlay.querySelector('#wb-priority').value) || 0,
      enabled: overlay.querySelector('#wb-enabled').checked,
    };
    const r = await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save-entry', bookId: App.wbCurrent, entryId: eid, entry: payload }) });
    const d = await r.json();
    if (d.error) { toast(d.error); return; }
    App.wbEntries[eid] = d.entry; overlay.remove(); renderWbEntries(); loadWorldbooksUI();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

function wbModal(title, bodyHtml, onOk, okText) {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = '<div class="modal-box" style="max-width:560px;max-height:85vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">' + safeHtml(title) + '</div>' + bodyHtml + '<div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button class="btn-sm wbdlg-cancel" style="padding:6px 16px">关闭</button><button class="btn-sm wbdlg-ok" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">' + safeHtml(okText || '确定') + '</button></div></div>';
  document.body.appendChild(ov);
  ov.querySelector('.wbdlg-cancel').onclick = () => ov.remove();
  ov.querySelector('.wbdlg-ok').onclick = () => onOk(ov);
  ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
  return ov;
}

function wbConfirm(title, text, onOk) {
  wbModal(title, '<div style="font-size:13px;line-height:1.7">' + safeHtml(text) + '</div>', (ov) => { ov.remove(); onOk(); }, '确定');
}

async function wbBatch(ids, enabled) {
  if (!App.wbCurrent) { toast('请先选择一本世界书'); return; }
  const r = await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'batch-enable', bookId: App.wbCurrent, ids, enabled }) });
  const d = await r.json();
  if (d.error) { toast(d.error); return; }
  await openWbEditor(App.wbCurrent);
}

function wbSelectedIds() {
  return Array.from(document.querySelectorAll('.wb-e-sel')).filter(cb => cb.checked).map(cb => cb.dataset.id);
}

function editGraphNode(nodeId) {
  const node = App.graphDataCache.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">编辑角色</div><label class="api-field">名称<input id="gn-name" type="text" value="${escapeHtml(node.name)}" style="width:100%"></label><label class="api-field">类型<select id="gn-type"><option value="character" ${node.type==='character'?'selected':''}>角色</option><option value="location" ${node.type==='location'?'selected':''}>地点</option><option value="faction" ${node.type==='faction'?'selected':''}>势力</option></select></label><label class="api-field">描述<textarea id="gn-desc" class="world-setting" rows="2" style="width:100%">${escapeHtml(node.description||'')}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="gn-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="gn-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button><button id="gn-delete" class="btn-sm" style="padding:6px 16px;color:var(--danger)">删除</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#gn-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#gn-save').onclick = async () => { await fetch('/api/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'updateNode', node: { id: nodeId, name: overlay.querySelector('#gn-name').value.trim(), type: overlay.querySelector('#gn-type').value, description: overlay.querySelector('#gn-desc').value } }) }); overlay.remove(); loadGraphUI(); };
  overlay.querySelector('#gn-delete').onclick = async () => { if (!confirm('确认删除？')) return; await fetch('/api/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'deleteNode', node: { id: nodeId } }) }); overlay.remove(); loadGraphUI(); };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

async function refreshVecStaleBadge() {
  const badge = document.getElementById('vec-stale-badge');
  if (!badge || !App.chatId) return;
  try {
    const d = await (await fetch(`/api/vec/status?chatId=${encodeURIComponent(App.chatId)}`)).json();
    const stale = d.ok && d.built && (Number(d.pending) - Number(d.total)) >= VEC_STALE_THRESHOLD;
    badge.classList.toggle('hidden', !stale);
    if (stale) badge.title = `向量索引有 ${d.pending - d.total} 块新内容未收录，建议到「🔍 语义」tab 重建索引`;
  } catch (e) { badge.classList.add('hidden'); }   // 查询失败不打扰
}

async function doVecSearch() {
  const q = document.getElementById('vec-query')?.value.trim();
  const out = document.getElementById('vec-results');
  if (!out) return;
  if (!q) { toast('请输入搜索内容'); return; }
  if (!App.chatId) { toast('无会话'); return; }
  out.innerHTML = '<div style="color:var(--muted);padding:8px">检索中…</div>';
  try {
    const r = await fetch('/api/vec/search', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, query: q, topK: 8 }),
    });
    const d = await r.json();
    if (!d.ok) { out.innerHTML = `<div style="color:var(--danger);padding:8px">${safeHtml(d.error || '检索失败')}</div>`; return; }
    if (!d.hits.length) { out.innerHTML = '<div style="color:var(--muted);padding:8px">无匹配结果</div>'; return; }
    const kindLabel = { event: '事件', msg: '对话', summary: '摘要' };
    out.innerHTML = d.hits.map(h => {
      const pct = (h.score * 100).toFixed(0);
      const color = h.score >= 0.6 ? 'var(--success)' : (h.score >= 0.4 ? 'var(--accent)' : 'var(--muted)');
      return `<div style="padding:6px 8px;margin-bottom:6px;background:var(--bg2);border-radius:6px;border-left:2px solid ${color}">
        <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:2px">
          <span style="color:var(--accent);font-size:11px">${kindLabel[h.kind] || h.kind}${h.role ? '·' + (h.role === 'user' ? '用户' : 'AI') : ''}${h.seq != null ? ' #' + h.seq : ''}</span>
          <span style="color:${color};font-size:11px">${pct}%</span>
        </div>
        <div style="color:var(--text);line-height:1.5">${safeHtml(String(h.text).slice(0, 400))}</div>
      </div>`;
    }).join('');
  } catch (e) { out.innerHTML = `<div style="color:var(--danger);padding:8px">检索异常：${safeHtml(e.message)}</div>`; }
}

function editPersona(id) {
  const p = App.personasCache[id] || { name: '', description: '' };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${id?'编辑':'新建'}玩家身份</div><label class="api-field">名称<input id="pe-name" type="text" value="${escapeHtml(p.name||'')}" style="width:100%"></label><label class="api-field">描述<textarea id="pe-desc" class="world-setting" rows="3" style="width:100%">${escapeHtml(p.description||'')}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="pe-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="pe-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#pe-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#pe-save').onclick = async () => { await fetch('/api/personas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', id: id||undefined, persona: { name: overlay.querySelector('#pe-name').value.trim(), description: overlay.querySelector('#pe-desc').value } }) }); overlay.remove(); loadPersonasUI(); };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

function showReportPreview(content, title) {
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  // 2026-09-03 安全修复 M-11：title/content 原为未转义直插 innerHTML —— content 是 AI 生成的
  // 报告正文，含 <img onerror=...> 即执行任意 JS（可读取全部会话数据）。
  overlay.innerHTML = `<div class="modal-box" style="max-width:600px;max-height:80vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${safeHtml(title || '报告')}</div><div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${safeHtml(content)}</div><div style="margin-top:16px;display:flex;justify-content:flex-end"><button id="rp-close" class="btn-sm" style="padding:6px 16px">关闭</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#rp-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

function editAnnotation(note) {
  if (!note) note = { position: 3, content: '' };
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${note.id?'编辑':'添加'}旁注</div><label class="api-field">位置（在第几条消息后）<input id="an-pos" type="number" min="1" value="${note.position||3}" style="width:80px"></label><label class="api-field">内容<textarea id="an-content" class="world-setting" rows="3" style="width:100%">${escapeHtml(note.content||'')}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="an-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="an-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
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

async function addAnnotationInline() {
  if (!App.chatId) { toast('请先打开对话'); return; }
  const posEl = document.getElementById('ann-pos-input');
  const cEl = document.getElementById('ann-content-input');
  const content = (cEl?.value || '').trim();
  if (!content) { toast('请输入旁注内容'); cEl?.focus(); return; }
  const position = Number(posEl?.value) || (App.history?.length || 1);   // 留空则挂到最后一条
  try {
    const r = await fetch('/api/annotations/' + encodeURIComponent(App.chatId), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'add', note: { position, content } }),
    });
    const d = await r.json().catch(() => ({}));
    if (d && d.error) { toast('添加失败：' + d.error, 'err'); return; }
    if (cEl) { cEl.value = ''; cEl.focus(); }
    loadAnnotationsUI();
  } catch (e) { toast('请求失败：' + e.message, 'err'); }
}

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
