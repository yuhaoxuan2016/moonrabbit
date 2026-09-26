// app/04-panels.js —— 侧栏卡片面板（各管理 UI 的 load/render 族）
// F 批自 app.js 整体搬迁，零逻辑改动（按函数名逐块切）。
// 注：本文件只放函数定义；顶层事件绑定留在 app.js，待 F-09 集中到 10-bind.js。
'use strict';

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
    d.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;border-left:4px solid ${safeColor(p.color)||'#639922'};background:var(--bg2);margin-bottom:6px;${isCurrent?'border:1px solid var(--accent)':''}`;
    d.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${escapeHtml(p.label||id)}${isCurrent?' <span style="color:var(--accent);font-size:11px">← 当前会话</span>':''}</div>${p.prefix?'<div style="font-size:11px;color:var(--muted,#888);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">'+escapeHtml(p.prefix)+'</div>':''}</div>${!isCurrent?'<button class="head-btn cp-apply-btn" data-id="'+escapeHtml(id)+'" style="padding:2px 8px;font-size:11px" title="应用到当前会话（改绑定）">🔗 应用</button>':''}<button class="head-btn cp-edit-btn" data-id="${escapeHtml(id)}" style="padding:2px 8px;font-size:11px">编辑</button>${p.isDefault?'':'<button class="head-btn cp-del-btn" data-id="'+escapeHtml(id)+'" style="padding:2px 8px;font-size:11px;color:var(--danger)">删</button>'}`;
    box.appendChild(d);
  }
  // 应用按钮：把配置档应用到当前会话（改绑定）
  box.querySelectorAll('.cp-apply-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cid = App.chatId;
      if (!cid) { toast('请先打开一个会话'); return; }
      if (!confirm(`将配置档「${btn.dataset.id}」应用到当前会话？`)) return;
      try {
        const r = await fetch('/api/chat-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply', id: btn.dataset.id, profile: { chatId: cid } }) });
        const d = await r.json();
        if (d.ok) { App.currentChatProfileId = btn.dataset.id; loadChatProfileManage(); loadChatList(); toast('已应用：当前会话改用「' + btn.dataset.id + '」配置档'); }
        else toast('应用失败：' + (d.error || '未知错误'));
      } catch (e) { toast('应用失败：' + e.message); }
    });
  });
  box.querySelectorAll('.cp-edit-btn').forEach(btn => btn.addEventListener('click', () => editChatProfile(btn.dataset.id)));
  box.querySelectorAll('.cp-del-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm(`确认删除配置档「${btn.dataset.id}」？`)) return;
    await fetch('/api/chat-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: btn.dataset.id }) });
    loadChatProfileManage();
  }));
}

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
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg2);margin-bottom:6px';
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${escapeHtml(p.name)}</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${escapeHtml([p.personality,p.appearance?.slice(0,30)].filter(Boolean).join(' · '))||'暂无描述'}</div></div><button class="head-btn npc-avatar-btn" data-name="${escapeHtml(p.name)}" title="上传/更换该角色头像">🖼 头像</button><button class="head-btn npc-export-btn" data-name="${escapeHtml(p.name)}" style="padding:2px 8px;font-size:11px" title="导出为酒馆角色卡 PNG">📤</button><button class="head-btn npc-edit-btn" data-name="${escapeHtml(p.name)}" style="padding:2px 8px;font-size:11px">编辑</button><button class="head-btn npc-del-btn" data-name="${escapeHtml(p.name)}" style="padding:2px 8px;font-size:11px;color:var(--danger)">删</button>`;
      box.appendChild(el);
    }
    box.querySelectorAll('.npc-edit-btn').forEach(btn => btn.addEventListener('click', () => editNpcProfile(btn.dataset.name)));
    box.querySelectorAll('.npc-del-btn').forEach(btn => btn.addEventListener('click', async () => { if (!confirm(`确认删除「${btn.dataset.name}」？`)) return; await fetch('/api/npc-profiles/'+encodeURIComponent(btn.dataset.name),{method:'DELETE'}); loadNpcProfiles(); }));
    box.querySelectorAll('.npc-export-btn').forEach(btn => btn.addEventListener('click', () => exportNpcCard(btn.dataset.name)));
  } catch (e) { box.textContent = '加载失败'; }
}

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
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg2);margin-bottom:6px';
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${escapeHtml(s.name)}</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${s.location?escapeHtml(s.location)+' · ':''}${Number(s.physicalFeatures?.length)||0} 个特征</div></div><button class="head-btn scene-edit-btn" data-name="${escapeHtml(s.name)}" style="padding:2px 8px;font-size:11px">编辑</button><button class="head-btn scene-del-btn" data-name="${escapeHtml(s.name)}" style="padding:2px 8px;font-size:11px;color:var(--danger)">删</button>`;
      box.appendChild(el);
    }
    box.querySelectorAll('.scene-edit-btn').forEach(btn => btn.addEventListener('click', () => editSceneProfile(btn.dataset.name)));
    box.querySelectorAll('.scene-del-btn').forEach(btn => btn.addEventListener('click', async () => { if (!confirm(`确认删除「${btn.dataset.name}」？`)) return; await fetch('/api/scenes/'+encodeURIComponent(btn.dataset.name),{method:'DELETE'}); loadSceneProfiles(); }));
  } catch (e) { box.textContent = '加载失败'; }
}

async function loadExpressions() {
  try {
    const r = await fetch('/api/expressions'); const d = await r.json();
    App.expressionsCache = d.expressions || {};
    App.expressionConfigCache = d.config || { emotionMap: {}, enableAutoSwitch: true };
    const dropdown = document.getElementById('expr-char-dropdown');
    if (dropdown) {
      // 2026-09-03：原为硬编码角色名常量（已改为中性规则），
      // 角色完全由用户自定义 → 直接用已有表情目录的角色，无则提示空。
      const chars = Object.keys(App.expressionsCache);
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
    el.style.cssText = 'position:relative;border-radius:6px;overflow:hidden;aspect-ratio:1;background:var(--bg2)';
    el.innerHTML = `<img src="${escapeHtml(expr.url)}" alt="${escapeHtml(expr.name)}" style="width:100%;height:100%;object-fit:cover"><div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;padding:2px 4px;text-align:center">${escapeHtml(expr.name)}</div><button class="head-btn expr-del-btn" data-char="${encodeURIComponent(charName)}" data-file="${encodeURIComponent(expr.file)}" title="删除此表情" style="position:absolute;top:2px;right:2px;padding:0 6px;font-size:11px;background:rgba(0,0,0,0.6);color:var(--danger);border:1px solid rgba(240,163,163,0.4);border-radius:4px;display:none">✕</button>`;
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
        if (d.ok) loadExpressions(); else toast('删除失败：' + (d.error || '未知错误'));
      } catch (err) { toast('删除失败：' + err.message); }
    });
  });
}

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
      el.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg2);margin-bottom:6px';
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${escapeHtml(rule.name||rule.id)}</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px;font-family:monospace">${escapeHtml(rule.pattern)}</div></div><label style="font-size:11px"><input type="checkbox" class="regex-toggle" data-id="${escapeHtml(rule.id)}" ${rule.enabled?'checked':''}> 启用</label><button class="head-btn regex-edit-btn" data-id="${escapeHtml(rule.id)}" style="padding:2px 8px;font-size:11px">编辑</button><button class="head-btn regex-del-btn" data-id="${escapeHtml(rule.id)}" style="padding:2px 8px;font-size:11px;color:var(--danger)">删</button>`;
      box.appendChild(el);
    }
    box.querySelectorAll('.regex-toggle').forEach(cb => cb.addEventListener('change', async () => { const rule = d.rules.find(r => r.id === cb.dataset.id); if (rule) { rule.enabled = cb.checked; await fetch('/api/regex-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', rule }) }); loadRegexRules(); } }));
    box.querySelectorAll('.regex-edit-btn').forEach(btn => btn.addEventListener('click', () => editRegexRule(d.rules.find(r => r.id === btn.dataset.id))));
    box.querySelectorAll('.regex-del-btn').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('确认删除？')) return; await fetch('/api/regex-rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', rule: { id: btn.dataset.id } }) }); loadRegexRulesUI(); loadRegexRules(); }));
  } catch (e) { box.textContent = '加载失败'; }
}

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
    el.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:var(--bg2);margin-bottom:4px;font-size:12px';
    const kws = (entry.keywords || []).slice(0, 3).join(', ');
    el.innerHTML = `<div style="flex:1;min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(entry.name||id)}${entry.constant?' <span style="color:var(--accent)">[常驻]</span>':''}</div><div style="font-size:11px;color:var(--muted,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(kws||'无关键词')}</div></div><label style="font-size:11px;flex:none"><input type="checkbox" class="lb-toggle" data-id="${escapeHtml(id)}" ${entry.enabled!==false?'checked':''}> 启用</label><button class="head-btn lb-edit-btn" data-id="${escapeHtml(id)}" style="padding:2px 6px;font-size:11px;flex:none">编辑</button><button class="head-btn lb-del-btn" data-id="${escapeHtml(id)}" style="padding:2px 6px;font-size:11px;color:var(--danger);flex:none">删</button>`;
    box.appendChild(el);
  }
  box.querySelectorAll('.lb-toggle').forEach(cb => cb.addEventListener('change', async () => { const e = App.lorebookEntriesCache[cb.dataset.id]; if (e) { e.enabled = cb.checked; await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', id: cb.dataset.id, entry: e }) }); } }));
  box.querySelectorAll('.lb-edit-btn').forEach(btn => btn.addEventListener('click', () => editLorebookEntry(btn.dataset.id, App.lorebookEntriesCache[btn.dataset.id])));
  box.querySelectorAll('.lb-del-btn').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('确认删除？')) return; await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: btn.dataset.id }) }); delete App.lorebookEntriesCache[btn.dataset.id]; renderLorebookList(); }));
}

async function loadWorldbooksUI() {
  const box = document.getElementById('wb-books');
  if (!box) return;
  try {
    const r = await fetch('/api/worldbooks?chatId=' + encodeURIComponent(App.chatId || ''));
    const d = await r.json();
    App.wbBooks = d.books || [];
    App.wbActive = d.active || [];
    App.wbOff = d.off || [];
    const sess = document.getElementById('wb-session');
    if (sess) sess.textContent = App.chatId
      ? '📍 本会话：' + (App.chatTitle || App.chatId) + ' —— 以下开关只作用于本会话'
      : '📍 会话加载中…（世界书按会话生效，加载完自动刷新）';
    renderWbBooks();
  } catch (e) { box.textContent = '加载失败'; }
}

function renderWbBooks() {
  const box = document.getElementById('wb-books');
  if (!box) return;
  box.innerHTML = '';
  if (!App.wbBooks.length) { box.textContent = '（暂无世界书 · 点「＋ 新建世界书」）'; return; }
  for (const b of App.wbBooks) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 2px';
    const isGlobal = b.scope === 'global';
    const checked = !!b.active;
    const stateTxt = b.entryCount + ' 条 · ' + (b.enabled ? '启用' : '已停用') + (b.sessionOff ? ' · 本会话已关' : '');
    const tip = isGlobal ? '勾选＝本会话启用；取消＝本会话停用（不影响其他会话）' : '勾选＝本会话启用';
    row.innerHTML = '<input type="checkbox" class="wb-active" data-id="' + safeHtml(b.id) + '" ' + (checked ? 'checked' : '') + ' style="flex:none" title="' + tip + '"><div style="flex:1;min-width:0" title="' + safeHtml(b.name) + '"><div style="font-weight:500;white-space:normal;word-break:break-word;line-height:1.35">' + safeHtml(b.name) + (isGlobal ? ' <span style="color:var(--muted);font-size:11px">[全局]</span>' : '') + '</div><div style="font-size:11px;color:var(--muted)">' + stateTxt + '</div></div><button class="head-btn wb-toggle" data-id="' + safeHtml(b.id) + '" style="padding:2px 8px;font-size:11px;flex:none" title="书级总开关：对所有会话生效">' + (b.enabled ? '⏸ 停用全书' : '▶ 启用全书') + '</button><button class="head-btn wb-edit" data-id="' + safeHtml(b.id) + '" style="padding:2px 8px;font-size:11px;flex:none">编辑</button><button class="head-btn wb-del" data-id="' + safeHtml(b.id) + '" style="padding:2px 8px;font-size:11px;color:var(--danger);flex:none">删</button>';
    box.appendChild(row);
  }
  box.querySelectorAll('.wb-active').forEach(cb => cb.addEventListener('change', async () => {
    const id = cb.dataset.id;
    const b = App.wbBooks.find(x => x.id === id) || {};
    let active = (App.wbActive || []).slice();
    let off = (App.wbOff || []).slice();
    if (b.scope === 'global') {
      if (cb.checked) off = off.filter(x => x !== id);
      else if (!off.includes(id)) off.push(id);
    } else {
      if (cb.checked) { if (!active.includes(id)) active.push(id); }
      else active = active.filter(x => x !== id);
    }
    App.wbActive = active; App.wbOff = off;
    await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'set-active', chatId: App.chatId || '', active, off }) });
    loadWorldbooksUI();
  }));
  box.querySelectorAll('.wb-toggle').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const b = App.wbBooks.find(x => x.id === id) || {};
    await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'toggle-book', bookId: id, enabled: !b.enabled }) });
    loadWorldbooksUI();
  }));
  box.querySelectorAll('.wb-edit').forEach(btn => btn.addEventListener('click', () => openWbEditor(btn.dataset.id)));
  box.querySelectorAll('.wb-del').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.id;
    wbConfirm('删除世界书', '确定删除「' + id + '」？会同时删除对应的 json 文件。', async () => {
      await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete-book', bookId: id }) });
      if (App.wbCurrent === id) closeWbEditor();
      loadWorldbooksUI();
    });
  }));
}

function renderWbEntries() {
  const box = document.getElementById('wb-entries');
  if (!box) return;
  box.innerHTML = '';
  const kw = (document.getElementById('wb-entry-search')?.value || '').trim().toLowerCase();
  let list = Object.entries(App.wbEntries);
  if (kw) list = list.filter(([, e]) => (e.name || '').toLowerCase().includes(kw) || (e.keywords || []).some(k => String(k).toLowerCase().includes(kw)));
  if (!list.length) { box.textContent = kw ? '（无匹配条目）' : '（暂无条目）'; return; }
  list.sort((a, b) => (b[1].priority || 0) - (a[1].priority || 0));
  for (const [eid, e] of list) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 2px';
    const mode = e.constant ? '强制注入' : '关键词';
    const kws = (e.keywords || []).join('、') || '—';
    const off = e.enabled === false;
    // 固定位置的「启用」复选框（名字再长也看得见状态）
    row.innerHTML = '<input type="checkbox" class="wb-e-sel" data-id="' + safeHtml(eid) + '" style="flex:none"><div style="flex:1;min-width:0;opacity:' + (off ? '0.5' : '1') + '" title="' + safeHtml((e.name || eid) + '\n关键词：' + kws) + '"><div style="font-weight:500;white-space:normal;word-break:break-word;line-height:1.35">' + safeHtml(e.name || eid) + ' <span style="color:var(--accent);font-size:11px">[' + mode + ']</span></div><div style="font-size:11px;color:var(--muted);white-space:normal;word-break:break-word;line-height:1.3">' + safeHtml(kws) + ' · P' + (e.priority || 0) + '</div></div><label style="font-size:11px;flex:none;display:flex;align-items:center;gap:3px;color:' + (off ? 'var(--danger)' : 'inherit') + '" title="勾选＝本条参与注入"><input type="checkbox" class="wb-e-toggle" data-id="' + safeHtml(eid) + '"' + (off ? '' : ' checked') + '>启用</label><button class="head-btn wb-e-edit" data-id="' + safeHtml(eid) + '" style="padding:2px 6px;font-size:11px;flex:none">编辑</button><button class="head-btn wb-e-del" data-id="' + safeHtml(eid) + '" style="padding:2px 6px;font-size:11px;color:var(--danger);flex:none">删</button>';
    box.appendChild(row);
  }
  // 行内「启用」开关（免开弹窗）
  box.querySelectorAll('.wb-e-toggle').forEach(cb => cb.addEventListener('change', async () => {
    const eid = cb.dataset.id;
    const e = App.wbEntries[eid];
    if (!e) return;
    cb.disabled = true;
    const r = await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save-entry', bookId: App.wbCurrent, entryId: eid, entry: { ...e, enabled: cb.checked } }) });
    const d = await r.json();
    cb.disabled = false;
    if (d.error) { toast(d.error); cb.checked = !cb.checked; return; }
    App.wbEntries[eid] = d.entry;
    renderWbEntries();
    loadWorldbooksUI();
  }));
  box.querySelectorAll('.wb-e-edit').forEach(btn => btn.addEventListener('click', () => editWbEntry(btn.dataset.id, App.wbEntries[btn.dataset.id])));
  box.querySelectorAll('.wb-e-del').forEach(btn => btn.addEventListener('click', () => {
    const eid = btn.dataset.id;
    wbConfirm('删除条目', '确定删除条目「' + eid + '」？', async () => {
      await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete-entry', bookId: App.wbCurrent, entryId: eid }) });
      delete App.wbEntries[eid]; renderWbEntries(); loadWorldbooksUI();
    });
  }));
}

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
  // 2026-09-03 安全修复 M-12：节点名/边标签原为未转义拼进 SVG，且用内联 onclick 拼 id
  // （含 ' 即注入 JS 或直接语法报错）→ 改为转义 + data-gnode 事件委托（口径一致）
  for (const e of edges) { const f = positions[e.from], t = positions[e.to]; if (!f || !t) continue; svgContent += `<line x1="${f.x}" y1="${f.y}" x2="${t.x}" y2="${t.y}" stroke="var(--muted)" stroke-width="${Number(e.weight) || 1}"/>`; if (e.label) svgContent += `<text x="${(f.x+t.x)/2}" y="${(f.y+t.y)/2-6}" text-anchor="middle" fill="var(--text)" font-size="11">${safeHtml(e.label)}</text>`; }
  for (const n of nodes) { const p = positions[n.id]; if (!p) continue; const c = n.type==='character'?'#a78bfa':n.type==='location'?'#6ee7a0':'#f0a35e'; svgContent += `<circle cx="${p.x}" cy="${p.y}" r="20" fill="${c}" stroke="var(--border)" stroke-width="1" style="cursor:pointer" data-gnode="${safeHtml(n.id)}"/>`; svgContent += `<text x="${p.x}" y="${p.y+30}" text-anchor="middle" fill="var(--text)" font-size="11">${safeHtml(n.name)}</text>`; }
  svg.innerHTML = svgContent;
  svg.onclick = (ev) => { const c = ev.target.closest('[data-gnode]'); if (c) editGraphNode(c.dataset.gnode); };
}

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
          const timeStr = s.story_time ? `<span style="color:var(--accent)">${safeHtml(s.story_time)}</span>` : '';
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

async function loadVecStatus() {
  const box = document.getElementById('vec-status');
  if (!box) return;
  if (!App.chatId) { box.textContent = '无会话'; return; }
  try {
    const d = await (await fetch(`/api/vec/status?chatId=${encodeURIComponent(App.chatId)}`)).json();
    if (!d.ok) { box.textContent = '状态读取失败'; return; }
    const kindLabel = { event: '事件', msg: '对话', summary: '摘要' };
    if (!d.built) {
      box.innerHTML = `<span style="color:var(--warning)">尚未建立索引</span>　可索引内容：<b>${d.pending}</b> 块<br>
        <span style="color:var(--muted)">${d.config.hasKey ? '已检测到 API Key' : '⚠️ 未配置 embedding Key（点 ⚙️ 设置填写，或配置辅助 API / 环境变量）'}</span>`;
      return;
    }
    const kinds = Object.entries(d.byKind).map(([k, n]) => `${kindLabel[k] || k} ${n}`).join(' / ');
    const stale = d.pending > d.total;
    box.innerHTML = `已索引 <b>${d.total}</b> 块（${kinds}）<br>
      <span style="color:var(--muted)">建立于 ${String(d.at).slice(0, 19).replace('T', ' ')}　模型 ${safeHtml(d.model)}</span><br>
      ${stale ? `<span style="color:var(--warning)">⚠️ 有 ${d.pending - d.total} 块新内容未入索引，建议重建</span><br>` : ''}
      自动注入：<b style="color:${d.config.autoInject ? 'var(--success)' : 'var(--muted)'}">${d.config.autoInject ? '开启' : '关闭'}</b>
      （TopK ${d.config.injectTopK}，最低相关度 ${d.config.minScore}）`;
  } catch (e) { box.textContent = '状态读取异常：' + e.message; }
}

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
      el.style.cssText = `display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;background:var(--bg2);margin-bottom:6px;${id===App.activePersonaCache?'border:2px solid var(--accent)':''}`;
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500;font-size:13px">${escapeHtml(p.name)}${id===App.activePersonaCache?' <span style="color:var(--accent)">[当前]</span>':''}</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${escapeHtml(p.description||'暂无描述')}</div></div>${id!==App.activePersonaCache?`<button class="head-btn persona-activate" data-id="${escapeHtml(id)}" style="padding:2px 8px;font-size:11px">切换</button>`:''}<button class="head-btn persona-edit" data-id="${escapeHtml(id)}" style="padding:2px 8px;font-size:11px">编辑</button>${!p.isDefault?`<button class="head-btn persona-del" data-id="${escapeHtml(id)}" style="padding:2px 8px;font-size:11px;color:var(--danger)">删</button>`:''}`;
      box.appendChild(el);
    }
    box.querySelectorAll('.persona-activate').forEach(btn => btn.addEventListener('click', async () => { await fetch('/api/personas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'activate', id: btn.dataset.id }) }); loadPersonasUI(); }));
    box.querySelectorAll('.persona-edit').forEach(btn => btn.addEventListener('click', () => editPersona(btn.dataset.id)));
    box.querySelectorAll('.persona-del').forEach(btn => btn.addEventListener('click', async () => { if (!confirm('确认删除？')) return; await fetch('/api/personas', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', id: btn.dataset.id }) }); loadPersonasUI(); }));
  } catch (e) { box.textContent = '加载失败'; }
}

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
      el.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:var(--bg2);margin-bottom:4px;font-size:12px';
      el.innerHTML = `<div style="flex:1">${escapeHtml(item.content)}</div><button class="head-btn agenda-complete" data-id="${escapeHtml(item.id)}" style="padding:2px 6px;font-size:11px">✓</button><button class="head-btn agenda-del" data-id="${escapeHtml(item.id)}" style="padding:2px 6px;font-size:11px;color:var(--danger)">✕</button>`;
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

async function loadReportListUI() {
  const box = document.getElementById('report-list');
  if (!box || !App.chatId) { if (box) box.textContent = '请先打开对话'; return; }
  try {
    const r = await fetch('/api/report/list?chatId=' + encodeURIComponent(App.chatId)); const d = await r.json();
    box.innerHTML = '';
    if (!d.reports?.length) { box.textContent = '（暂无报告）'; return; }
    for (const report of d.reports.slice(0, 10)) {
      const el = document.createElement('div');
      el.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:var(--bg2);margin-bottom:4px;font-size:12px;cursor:pointer';
      el.innerHTML = `<div style="flex:1">${escapeHtml(report.filename)}</div><span style="font-size:11px;color:var(--muted,#888)">${escapeHtml(String(report.ts || '').slice(0, 16))}</span>`;
      el.onclick = async () => { const r2 = await fetch('/api/report/' + encodeURIComponent(App.chatId) + '/' + encodeURIComponent(report.filename)); const d2 = await r2.json(); if (d2.content) showReportPreview(d2.content, report.filename); };
      box.appendChild(el);
    }
  } catch (e) { box.textContent = '加载失败'; }
}

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
      el.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;background:var(--bg2);margin-bottom:4px;font-size:12px';
      el.innerHTML = `<div style="flex:1"><div style="font-weight:500">第${Number(note.position) || 0}条消息后</div><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">${escapeHtml(note.content)}</div></div><label style="font-size:11px;flex:none"><input type="checkbox" class="ann-toggle" data-id="${escapeHtml(note.id)}" ${note.enabled?'checked':''}> 启用</label><button class="head-btn ann-edit" data-id="${escapeHtml(note.id)}" style="padding:2px 6px;font-size:11px;flex:none">编辑</button><button class="head-btn ann-del" data-id="${escapeHtml(note.id)}" style="padding:2px 6px;font-size:11px;color:var(--danger);flex:none">删</button>`;
      box.appendChild(el);
    }
    box.querySelectorAll('.ann-toggle').forEach(cb => cb.addEventListener('change', async () => { await fetch('/api/annotations/' + encodeURIComponent(App.chatId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update', note: { id: cb.dataset.id, enabled: cb.checked } }) }); }));
    box.querySelectorAll('.ann-edit').forEach(btn => btn.addEventListener('click', () => editAnnotation(notes.find(n => n.id === btn.dataset.id))));
    box.querySelectorAll('.ann-del').forEach(btn => btn.addEventListener('click', async () => { await fetch('/api/annotations/' + encodeURIComponent(App.chatId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete', note: { id: btn.dataset.id } }) }); loadAnnotationsUI(); }));
  } catch (e) { box.textContent = '加载失败'; }
}

async function loadBookmarksUI() {
  const box = document.getElementById('bookmark-list');
  if (!box) return;
  if (!App.chatId) { box.textContent = '请先打开对话'; return; }
  await withLoading(box, async () => {
    const d = await fetchJson('/api/bookmarks/' + encodeURIComponent(App.chatId));
    const marks = d.marks || [];
    App.bookmarksCache = marks;
    syncBookmarkButtons();
    box.innerHTML = '';
    if (!marks.length) { box.textContent = '（暂无书签，在气泡点 🔖 添加）'; return; }
    for (const bm of marks) {
      const el = document.createElement('div');
      el.className = 'bm-item';
      const who = bm.role === 'user' ? '用户' : 'AI';
      el.innerHTML = `<span class="bm-seq">#${safeHtml(bm.seq)}</span>
        <span class="bm-label" title="点击跳转">${safeHtml(bm.label || '(无摘要)')}</span>
        <span class="bm-who">${who}</span>
        <button class="head-btn bm-del" data-id="${safeHtml(bm.id)}" title="删除该书签">✕</button>`;
      const jump = () => jumpToSeq(bm.seq);
      el.querySelector('.bm-label').addEventListener('click', jump);
      el.querySelector('.bm-seq').addEventListener('click', jump);
      el.querySelector('.bm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch('/api/bookmarks/' + encodeURIComponent(App.chatId), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'delete', mark: { id: bm.id } }),
        });
        loadBookmarksUI();
      });
      box.appendChild(el);
    }
  }, { rows: 3 });
}

function renderTimelineNav() {
  const nav = document.getElementById('timeline-nav');
  if (!nav) return;
  const wraps = [...els.messages.querySelectorAll('.msg-wrap[data-seq]')];
  if (wraps.length < 6) { nav.classList.add('hidden'); return; }
  nav.classList.remove('hidden');
  const bmSet = new Set((App.bookmarksCache || []).map(b => Number(b.seq)));
  nav.innerHTML = '';
  for (const w of wraps) {
    const seq = Number(w.dataset.seq);
    const tick = document.createElement('div');
    tick.className = 'tn-tick' + (bmSet.has(seq) ? ' bm' : (w.classList.contains('user') ? ' user' : ''));
    tick.dataset.seq = String(seq);
    const preview = (w.querySelector('.bubble')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    tick.title = `#${seq}${bmSet.has(seq) ? ' 🔖' : ''} ${preview}`;
    tick.addEventListener('click', () => {
      w.scrollIntoView({ behavior: 'smooth', block: 'center' });
      w.classList.add('msg-search-hit');
      setTimeout(() => w.classList.remove('msg-search-hit'), 1200);
    });
    nav.appendChild(tick);
  }
  updateTimelineCurrent();
}
