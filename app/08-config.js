// app/08-config.js —— API 预设 / 配置档案 / 模型与端点 / 会话配置档
// F 批自 app.js 整体搬迁，零逻辑改动（括号配对切块）。
// 注：本文件只放函数定义；顶层事件绑定留在 app.js，待 F-09 集中到 10-bind.js。
'use strict';

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
    // 2026-09-03 修复 M-14：全局 ESC 监听（L143）只 top.remove() 不 resolve，
    // 走 ESC 关闭时本 Promise 永不落定 → newChat() 永久 await，新建会话静默失效。
    let settled = false;
    let mo = null;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      if (mo) { mo.disconnect(); mo = null; }
      if (overlay.isConnected) overlay.remove();
      resolve(v);
    };
    mo = new MutationObserver(() => { if (!overlay.isConnected) settle(null); });
    mo.observe(document.body, { childList: true });
    const list = overlay.querySelector('#cp-list');
    // 当前会话的配置档置顶（按对话过滤显示）
    const sortedIds = [App.currentChatProfileId, ...ids.filter(i => i !== App.currentChatProfileId)];
    for (const id of sortedIds) {
      const p = profiles[id];
      if (!p) continue;
      const isCurrent = id === App.currentChatProfileId;
      const btn = document.createElement('button');
      btn.className = 'btn-sm';
      btn.style.cssText = `padding:10px 16px;text-align:left;border-left:4px solid ${safeColor(p.color)||'#639922'};background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:6px;cursor:pointer;${isCurrent?'border-color:var(--accent);background:var(--bg2)':''}`;
      btn.innerHTML = `<div style="font-weight:500">${escapeHtml(p.label||id)}${isCurrent?' <span style="color:var(--accent);font-size:11px">← 当前会话使用</span>':''}</div>${p.prefix?'<div style="font-size:12px;color:var(--muted);margin-top:2px">'+escapeHtml(p.prefix.slice(0,50))+'...</div>':''}`;
      btn.onclick = () => { settle(id); };
      list.appendChild(btn);
    }
    overlay.querySelector('#cp-cancel').onclick = () => { settle(null); };
    overlay.onclick = (e) => { if (e.target === overlay) { settle(null); } };
  });
}

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

function migrateKey(oldKey, newKey) {
  try {
    if (!localStorage.getItem(newKey) && localStorage.getItem(oldKey)) {
      localStorage.setItem(newKey, localStorage.getItem(oldKey));
      localStorage.removeItem(oldKey);
    }
  } catch (e) { /* ignore */ }
}

function editChatProfile(id) {
  const p = App.chatProfilesCache[id] || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">编辑配置档：${escapeHtml(id)}</div><div style="font-size:12px;color:var(--muted,#888);margin-bottom:10px">💡 配置档只负责「切换标记 + 首条模板」；排除项（【排除当前状态】等）统一写在会话常驻设定里。</div><label class="api-field">显示名称<input id="ep-label" type="text" value="${escapeHtml(p.label||id)}" style="width:100%"></label><label class="api-field">颜色<input id="ep-color" type="color" value="${escapeHtml(p.color||'#639922')}"></label><label class="api-field">首条消息模板路径<input id="ep-firstmsg" type="text" value="${escapeHtml(p.firstMsg||'')}" placeholder="文件路径" style="width:100%"></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="ep-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="ep-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#ep-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#ep-save').onclick = async () => {
    await fetch('/api/chat-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'save', id, profile: { label: overlay.querySelector('#ep-label').value.trim().slice(0,40), color: overlay.querySelector('#ep-color').value, firstMsg: overlay.querySelector('#ep-firstmsg').value.trim(), isDefault: p.isDefault||false } }) });
    overlay.remove(); loadChatProfileManage();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
