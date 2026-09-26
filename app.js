// app.js —— Moonrabbit 前端逻辑（多角色 RP / 互动小说界面）
'use strict';

// —— 共享工具（toast / confirmDialog / fetchJson / 文本净化 / renderMarkdown）已抽到 app/01-core.js（F-01）——

// —— 消息容器与气泡渲染（makeWrap / reroll / renderAssistant / renderUser / 分段渲染）已抽到 app/02-render.js（F-02）——

// ---------- 流式对话 ----------
// —— send 已抽到 app/03-chat.js（F-03）——

// —— generate 已抽到 app/03-chat.js（F-03）——

// 思考链折叠块
// —— renderThinking 已抽到 app/09-ui.js（F 批）——

// ---------- 会话管理（新对话 / 归档 / 恢复） ----------
const CUR_CHAT_KEY = 'currentChatId';
App.chatId = null;
App.currentChatProfileId = 'main';   // 当前会话绑定的配置档（按对话过滤显示用）
App.chatTitle = '';

// —— saveChat 已抽到 app/03-chat.js（F-03）——

// ---------- 会话导出（JSON 完整备份 / Markdown 可读版；随手备份） ----------
// —— downloadBlob 已抽到 app/03-chat.js（F-03）——
// —— exportChat 已抽到 app/03-chat.js（F-03）——
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
    toast('导入失败：' + e.message);
  }
});

// ---------- 存档点（💾 存档 / ↩ 读档，按会话；服务端存 data/savepoints/{chatId}/{ts}.json 完整副本） ----------
document.getElementById('savepoint-btn').addEventListener('click', async () => {
  if (!App.chatId) { toast('还没有会话，无法存档'); return; }
  if (!App.history.length) { toast('当前会话为空，无需存档'); return; }
  await saveChat();   // 先把最新对话落盘，再存副本
  const label = (prompt('存档备注（可留空）：', '') || '').trim().slice(0, 40);
  try {
    const r = await (await fetch('/api/savepoints/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, label }),
    })).json();
    if (!r.ok) throw new Error(r.error || '存档失败');
    toast('✅ ' + r.note);
  } catch (e) { toast('存档失败：' + e.message); }
});
document.getElementById('loadpoint-btn').addEventListener('click', async () => {
  if (!App.chatId) { toast('还没有会话，无法读档'); return; }
  try {
    const { ok, savepoints } = await (await fetch(`/api/savepoints/list?chatId=${encodeURIComponent(App.chatId)}`)).json();
    if (!ok || !savepoints || !savepoints.length) { toast('本会话还没有存档点'); return; }
    const choice = prompt(
      '选择要读取的存档点（输入序号，Enter 取消）：\n\n' +
      savepoints.map((s, i) => `${i + 1}. ${s.label || '（无备注）'} · ${new Date(s.ts).toLocaleString()} · ${s.count} 条消息`).join('\n'),
      '1'
    );
    const idx = Number(choice);
    if (!choice || !Number.isFinite(idx)) return;
    const sp = savepoints[idx - 1];
    if (!sp) { toast('序号无效'); return; }
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
  } catch (e) { toast('读档失败：' + e.message); }
});

// —— loadChatList 已抽到 app/03-chat.js（F-03）——

// ---------- 对话配置档选择器 ----------
App.chatProfilesCache = {};
// —— loadChatProfiles 已抽到 app/08-config.js（F 批）——
// —— showChatProfilePicker 已抽到 app/08-config.js（F 批）——

// —— newChat 已抽到 app/03-chat.js（F-03）——

let openChatSeq = 0;   // F-10 修复：会话切换请求序号（快速连点时丢弃过期响应）
// —— openChat 已抽到 app/03-chat.js（F-03）——

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
    App.currentMaxContext = Number(c.maxContext) || 0;   // F-6 修复：打开设置同步上下文预算
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
      App.currentMaxContext = Number(document.getElementById('api-context').value) || 0;   // F-6 修复：同步上下文预算（旧版死字段，指示器恒按 1M 高估）
      if (typeof updateTokenEstimate === 'function') updateTokenEstimate();
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
// —— loadInjections 已抽到 app/05-settings.js（F 批）——
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
      toast('保存失败：' + (r.error || '未知错误'));
    }
  } catch (e) { toast('保存失败：' + e.message); }
});

// ---------- API 采样预设（命名预设） ----------
const presetSelect = document.getElementById('preset-select');
// —— loadPresets 已抽到 app/08-config.js（F 批）——
// —— readPresetInputs 已抽到 app/08-config.js（F 批）——
// —— presetPost 已抽到 app/08-config.js（F 批）——
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

// —— loadProfiles 已抽到 app/08-config.js（F 批）——
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
      toast('档案切换失败：' + (r.error || '未知错误'));
      loadProfiles();
    }
  } catch (e) { toast('档案切换失败：' + e.message); loadProfiles(); }
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
      App.currentMaxContext = Number(r.maxContext) || 0;   // F-6 修复：切档案同步上下文预算
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
// —— ensureModelOption 已抽到 app/08-config.js（F 批）——
// —— loadModel 已抽到 app/08-config.js（F 批）——
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
      toast('模型切换失败：' + (r.error || '未知错误'));
      loadModel();
    }
  } catch (e) { toast('模型切换失败：' + e.message); loadModel(); }
});

// ---------- 皮肤 & 背景（主题 + 自定义调色板 + 背景 URL） ----------
const themeSelect = document.getElementById('theme-select');

// localStorage key 迁移：旧 rw- 前缀（早期版本）→ mr-（当前）
// —— migrateKey 已抽到 app/08-config.js（F 批）——
migrateKey('rw-custom-skin', 'mr-custom-skin');
migrateKey('rw-op-view', 'mr-op-view');
migrateKey('rw-op-expand', 'mr-op-expand');
migrateKey('rw-op-tools', 'mr-op-tools');
migrateKey('rw-tour-done-v1', 'mr-tour-done-v1');

// 自定义调色板：色相/饱和度/亮度 → HSL 派生 CSS 变量
const CUSTOM_SKIN_DEFAULT = { mode: 'dark', hue: 250, sat: 55, light: 45 };
App.customSkin = { ...CUSTOM_SKIN_DEFAULT };
try { App.customSkin = { ...CUSTOM_SKIN_DEFAULT, ...(JSON.parse(localStorage.getItem('mr-custom-skin')) || {}) }; } catch (e) { /* 首次 */ }
// —— saveCustomSkin 已抽到 app/05-settings.js（F 批）——

// —— applyCustomSkin 已抽到 app/05-settings.js（F 批）——

// —— applySkin 已抽到 app/05-settings.js（F 批）——
themeSelect.addEventListener('change', () => {
  App.prefs.theme = themeSelect.value;
  savePrefs();
  applySkin();
});

// 自定义调色板控件（仅 theme=custom 时显示）
// —— bindCustomSkin 已抽到 app/05-settings.js（F 批）——

// ---------- 显示设置（localStorage 持久化） ----------
const PREFS_KEY = 'moonrabbitPrefs';
App.prefs = { hlEnabled: true, theme: 'default', showThinking: true, peakConfirm: true, bgUrl: '' };
try {
  App.prefs = { ...App.prefs, ...(JSON.parse(localStorage.getItem(PREFS_KEY)) || {}) };
} catch (e) { /* 首次使用 */ }
// —— savePrefs 已抽到 app/05-settings.js（F 批）——

// —— renderSettings 已抽到 app/05-settings.js（F 批）——
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
const tmTabVec = document.getElementById('tm-tab-vec');
const tmTimeline = document.getElementById('tm-timeline');
const tmInventory = document.getElementById('tm-inventory');
const tmWardrobe = document.getElementById('tm-wardrobe');
const tmEmotions = document.getElementById('tm-emotions');
const tmAuto = document.getElementById('tm-auto');
const tmLocations = document.getElementById('tm-locations');
const tmExport = document.getElementById('tm-export');
const tmExportBox = document.getElementById('tm-export-box');
const tmCopyBtn = document.getElementById('tm-export-copy');
if (tmCopyBtn) tmCopyBtn.addEventListener('click', async () => {
  const text = tmCopyBtn.dataset.text || tmExportBox.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    tmCopyBtn.textContent = '✅ 已复制';
    setTimeout(() => { tmCopyBtn.textContent = '📋 复制'; }, 1500);
  } catch (e) {
    // 剪贴板 API 失败（非安全上下文/权限）：降级为选中文本提示手动复制
    tmCopyBtn.textContent = '⚠️ 已选中，按 Ctrl+C';
    const range = document.createRange();
    range.selectNodeContents(tmExportBox);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    setTimeout(() => { tmCopyBtn.textContent = '📋 复制'; }, 2500);
  }
});

// —— loadEmotions 已抽到 app/06-timeline.js（F 批）——
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

// —— loadTimeline 已抽到 app/06-timeline.js（F 批）——

// 时间线条目 修改/补充：行内编辑表单（edit=预填原值；insert=清空，插到该条之后）
App.tmItemEditBox = null;   // 当前展开的编辑容器（同一时间只开一个）
// —— openTmItemEdit 已抽到 app/06-timeline.js（F 批）——

// AI 智能补全：调用 /api/timeline/ai-fill（辅助 API 串行队列），把返回字段填入表单（box 内需带 data-f 输入框）
// —— aiFillTimeline 已抽到 app/06-timeline.js（F 批）——

// —— loadInventory 已抽到 app/06-timeline.js（F 批）——

const tmEditTl = document.querySelector('.tm-edit:not(#inv-edit)');  // 手动补记（时间线）编辑区
const tmEditInv = document.getElementById('inv-edit');                // 手动修改物品栏编辑区
// —— setTmTabVis 已抽到 app/06-timeline.js（F 批）——
tmTabTl.addEventListener('click', () => {
  tmTabTl.classList.add('active'); tmTabInv.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabLoc.classList.remove('active'); tmTabVec.classList.remove('active');
  setTmTabVis('tl');
});
tmTabInv.addEventListener('click', () => {
  tmTabInv.classList.add('active'); tmTabTl.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabLoc.classList.remove('active'); tmTabVec.classList.remove('active');
  setTmTabVis('inv');
  loadInventory();
});
tmTabWd.addEventListener('click', () => {
  tmTabWd.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabLoc.classList.remove('active'); tmTabVec.classList.remove('active');
  setTmTabVis('wd');
  loadCurrentWardrobe();
});
tmTabEm.addEventListener('click', () => {
  tmTabEm.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabLoc.classList.remove('active'); tmTabVec.classList.remove('active');
  setTmTabVis('em');
  loadEmotions();
});
tmTabAuto.addEventListener('click', () => {
  tmTabAuto.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabLoc.classList.remove('active'); tmTabVec.classList.remove('active');
  setTmTabVis('auto');
  loadStoryMemoryUI();
});
tmTabLoc.addEventListener('click', () => {
  tmTabLoc.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabVec.classList.remove('active');
  setTmTabVis('loc');
  loadLocationsUI();
});
tmTabVec.addEventListener('click', () => {
  tmTabVec.classList.add('active'); tmTabTl.classList.remove('active'); tmTabInv.classList.remove('active'); tmTabWd.classList.remove('active'); tmTabEm.classList.remove('active'); tmTabAuto.classList.remove('active'); tmTabLoc.classList.remove('active');
  setTmTabVis('vec');
  loadVecStatus();
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
    note.textContent = r.ok ? `✓ 已补记（${(r.rec && r.rec.story_time) || '时间未填'}）` : `✗ ${r.error || '失败'}`;
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
// —— loadCurrentWardrobe 已抽到 app/06-timeline.js（F 批）——


tmExport.addEventListener('click', async () => {
  try {
    const text = await (await fetch(`/api/timeline/export?chatId=${encodeURIComponent(App.chatId || '')}`)).text();
    tmExportBox.classList.remove('hidden');
    tmExportBox.textContent = text;
    tmExportBox.scrollTop = 0;
    // 一键复制（2026-08-30：拖拽手柄修复后文本也可直接选中，复制按钮双保险）
    if (tmCopyBtn) {
      tmCopyBtn.classList.remove('hidden');
      tmCopyBtn.dataset.text = text;
      tmCopyBtn.textContent = '📋 复制';
    }
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
    meta.innerHTML = `<b>${escapeHtml(l.chatId)}</b> · ${t.toLocaleString()} · 历史 ${Number(l.historyCount) || 0} 条 · 工具：${escapeHtml((l.tools || []).join('、')) || '无'}`;
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

// 工具桥：自由勾选工具（本版 = 仅联网）
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
// —— fmtDur 已抽到 app/09-ui.js（F 批）——
// —— fmtTok 已抽到 app/09-ui.js（F 批）——
// —— fmtCost 已抽到 app/09-ui.js（F 批）——
// —— loadStats 已抽到 app/09-ui.js（F 批）——

// ---------- 高峰时段提示条（官方直连渠道 + 高峰时间才生效） ----------
App.peakEligible = true;   // 端点是否为 DeepSeek 官方直连（峰谷定价渠道）
// 法定节假日表：全天按空闲价计费（节假日日历优先于星期几 · DeepSeek 2026-09-19 说明）——每年按国务院放假安排更新
const OFFPEAK_HOLIDAYS = new Set([
  '2026-09-25', '2026-09-26', '2026-09-27',   // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',   // 国庆
]);
// —— isPeakHours 已抽到 app/09-ui.js（F 批）——
// —— updatePeakBanner 已抽到 app/09-ui.js（F 批）——

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
// —— tourShow 已抽到 app/09-ui.js（F 批）——
// —— tourDone 已抽到 app/09-ui.js（F 批）——
document.getElementById('tour-next').addEventListener('click', () => {
  if (App.tourIdx < tourSteps.length - 1) { App.tourIdx += 1; tourShow(); } else tourDone();
});
document.getElementById('tour-prev').addEventListener('click', () => {
  if (App.tourIdx > 0) { App.tourIdx -= 1; tourShow(); }
});
document.getElementById('tour-skip').addEventListener('click', tourDone);
// —— maybeStartTour 已抽到 app/09-ui.js（F 批）——

// ---------- 事件 ----------
els.send.addEventListener('click', send);
// Token 预估
// —— estimateTokens 已抽到 app/09-ui.js（F 批）——
// —— updateTokenEstimate 已抽到 app/09-ui.js（F 批）——
App.lastSystemPrompt = '';
App.currentMaxContext = 1048576;
els.input.addEventListener('input', updateTokenEstimate);
// 变量提示按钮
document.getElementById('var-hint-btn')?.addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:420px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">变量模板</div><table style="width:100%;font-size:13px;border-collapse:collapse"><tr style="border-bottom:1px solid var(--border)"><td style="padding:6px;font-weight:500">变量</td><td style="padding:6px;font-weight:500">替换为</td></tr><tr><td style="padding:6px;font-family:monospace">{{user}}</td><td style="padding:6px">用户名</td></tr><tr><td style="padding:6px;font-family:monospace">{{char}}</td><td style="padding:6px">当前角色名</td></tr><tr><td style="padding:6px;font-family:monospace">{{time}}</td><td style="padding:6px">当前时间</td></tr><tr><td style="padding:6px;font-family:monospace">{{date}}</td><td style="padding:6px">当前日期</td></tr><tr><td style="padding:6px;font-family:monospace">{{chatId}}</td><td style="padding:6px">会话 ID</td></tr><tr><td style="padding:6px;font-family:monospace">{{turnCount}}</td><td style="padding:6px">消息数</td></tr><tr><td style="padding:6px;font-family:monospace">{{lastMessage}}</td><td style="padding:6px">最后用户消息</td></tr></table><div style="margin-top:16px;display:flex;justify-content:flex-end"><button id="var-close" class="btn-sm" style="padding:6px 16px">关闭</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#var-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});
// 剧情建议
document.getElementById('suggestions-btn')?.addEventListener('click', async () => {
  if (!App.chatId) { toast('请先创建或打开一个对话'); return; }
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
      card.style.cssText = 'padding:12px;border-radius:8px;background:var(--bg2);border:1px solid var(--border)';
      const safeTitle = escapeHtml(sg.title || '未命名');
      const safeMood = sg.mood ? '氛围：' + escapeHtml(sg.mood) : '';
      const safeDetail = escapeHtml(sg.detail || '');
      card.innerHTML = `<div style="font-weight:500;font-size:13px;margin-bottom:4px">${safeTitle}</div><div style="font-size:12px;color:var(--muted,#888);margin-bottom:6px">${safeMood}</div><div style="font-size:13px;display:none" class="sg-detail">${safeDetail}</div><div style="display:flex;gap:6px;margin-top:8px"><button class="btn-sm sg-expand" style="padding:4px 10px;font-size:11px">展开</button><button class="btn-sm sg-use" style="padding:4px 10px;font-size:11px;background:var(--accent);color:#fff;border:none;border-radius:4px">采用</button></div>`;
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
      <input id="recall-query" style="flex:1;padding:8px;border-radius:6px;background:var(--bg2);color:var(--text);border:1px solid var(--border)" placeholder="搜索聊天历史…" autofocus>
      <button id="recall-search" class="btn-sm" style="padding:8px 16px;background:var(--accent);color:#fff;border-radius:6px;border:none;cursor:pointer">搜索</button>
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
        card.style.cssText = 'padding:8px;margin-bottom:6px;border-radius:6px;background:var(--bg2);border:1px solid var(--border);cursor:pointer';
        // 2026-09-03 MINOR-8：检索命中项非空字段（content/score）可能缺失，.length/.toFixed 直接抛
        const content = String(item.content || '');
        const preview = content.length > 200 ? content.slice(0, 200) + '…' : content;
        card.innerHTML = `<div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="color:var(--accent);font-size:11px">${String(item.chatTitle || item.chatId).replace(/</g,'&lt;')}</span><span style="color:var(--muted,#888);font-size:11px">相关度 ${(item.score ?? 0).toFixed(2)}</span></div><div style="font-size:12px;white-space:pre-wrap;word-break:break-word">${preview.replace(/</g,'&lt;')}</div>`;
        card.onclick = () => { els.input.value = (els.input.value ? els.input.value + '\n' : '') + content.slice(0, 500); overlay.remove(); els.input.focus(); };
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
// —— openIllustration 已抽到 app/07-media.js（F 批）——
// 语音朗读：TTS 合成
document.getElementById('tts-btn')?.addEventListener('click', () => { openTts(); });

// 朗读指定文本（seq 为空时由调用方已传 text）
// —— openTts 已抽到 app/07-media.js（F 批）——
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
      if (file.size > 1024 * 1024) { toast('图片过大（>1MB），请压缩后粘贴'); continue; }
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
      // 2026-09-03 MINOR 修复：原漏 versions → 直接关页会把已落盘的重 roll 版本链覆盖成空
      body: JSON.stringify({ title, messages: App.history, versions: rerollVersions }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* best effort */ }
});
// 全局快捷键：Ctrl+Shift+F 聚焦世界设定（本版无检索框）

// ===== 快捷键速查面板（2026-09-02 F4）=====
const SHORTCUT_LIST = [
  ['Ctrl / ⌘ + Enter', '发送消息'],
  ['Ctrl + Shift + F', '聚焦世界设定输入框'],
  ['Esc', '关闭当前弹窗 / 关闭检索'],
  ['Enter', '（检索框内）跳到下一个匹配'],
  ['?', '打开本速查表'],
];
// —— openShortcutPanel 已抽到 app/09-ui.js（F 批）——
document.addEventListener('keydown', (e) => {
  if (e.key !== '?') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  e.preventDefault();
  openShortcutPanel();
});

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
// —— toggleSidebar 已抽到 app/09-ui.js（F 批）——
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
  saveAttachPending(text).catch(() => {});   // 持久化（2026-08-30 修复重启/刷新丢失）
  els.manAttachBox.classList.add('hidden');
  els.manAttachInput.value = '';
  els.manAttachNote.classList.remove('hidden');
});
// ---------- 待注入附加资料持久化（2026-08-30 修复：重启/刷新后恢复，不再丢失） ----------
// —— saveAttachPending 已抽到 app/05-settings.js（F 批）——
// —— loadAttachPending 已抽到 app/05-settings.js（F 批）——

// ---------- 会话常驻设定（📌 每轮注入 system，防遗忘；按会话隔离） ----------
// Task15 多槽位：其他 / 背景 / 关系 / 规则（页签切换编辑，保存时整包提交）
const NOTE_SLOTS_UI = ['其他', '背景', '关系', '规则'];
App.noteSlotsData = {};      // 内存槽位数据
App.noteSlotsPristine = {};  // 打开/加载时的原始槽位快照（取消时整体还原，防页签暂存无法撤销）
App.currentNoteSlot = '其他';

// —— noteSlotTab 已抽到 app/09-ui.js（F 批）——
// —— switchNoteSlot 已抽到 app/09-ui.js（F 批）——
// —— loadSessionNote 已抽到 app/05-settings.js（F 批）——
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
// —— initMsgSearch 已抽到 app/09-ui.js（F 批）——

// ---------- 对话配置档管理 UI ----------
// —— loadChatProfileManage 已抽到 app/04-panels.js（F 批）——
// —— editChatProfile 已抽到 app/08-config.js（F 批）——
document.getElementById('cp-add-btn')?.addEventListener('click', () => { const id = prompt('配置档 ID：'); if (id?.trim()) editChatProfile(id.trim()); });
loadChatProfileManage();

// ---------- NPC 档案管理 UI ----------
/* S5 头像弹窗（2026-09-06）：上传/更换/删除角色自定义头像 */
// —— openAvatarWin 已抽到 app/07-media.js（F 批）——
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.npc-avatar-btn');
  if (!b) return;
  openAvatarWin(b.dataset.name);
});
// —— loadNpcProfiles 已抽到 app/04-panels.js（F 批）——
// —— editNpcProfile 已抽到 app/07-media.js（F 批）——
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
        if (d.error) { toast('导入失败：' + d.error); return; }
        toast(`✅ 导入成功：${d.profile.name}\n已保存为角色档案`);
        loadNpcProfiles();
      } catch (e) { toast('请求失败：' + e.message); }
    };
    reader.readAsDataURL(file);
  };
  input.click();
});
// —— exportNpcCard 已抽到 app/07-media.js（F 批）——
loadNpcProfiles();

// ---------- 场景档案管理 UI ----------
// —— loadSceneProfiles 已抽到 app/04-panels.js（F 批）——
// —— editSceneProfile 已抽到 app/07-media.js（F 批）——
document.getElementById('scene-add-btn')?.addEventListener('click', () => editSceneProfile(null));
loadSceneProfiles();

// ---------- 表情系统管理 UI ----------
App.expressionsCache = {};
App.expressionConfigCache = { emotionMap: {}, enableAutoSwitch: true };
// 不预置角色名（2026-09-03）：角色列表完全来自用户已建的表情目录
// —— loadExpressions 已抽到 app/04-panels.js（F 批）——
// —— renderExpressionGrid 已抽到 app/04-panels.js（F 批）——
document.getElementById('expr-char-dropdown')?.addEventListener('change', (e) => renderExpressionGrid(e.target.value));
document.getElementById('expr-upload-btn')?.addEventListener('click', () => {
  const charName = document.getElementById('expr-char-dropdown')?.value;
  if (!charName) { toast('请先选择角色'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">添加表情到「${escapeHtml(charName)}」</div><label class="api-field">情绪名称<input id="exp-name" type="text" placeholder="开心" style="width:100%"></label><label class="api-field">图片<input id="exp-file" type="file" accept="image/*" style="width:100%"></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="exp-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="exp-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">上传</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#exp-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#exp-save').onclick = async () => {
    const name = overlay.querySelector('#exp-name').value.trim();
    const file = overlay.querySelector('#exp-file').files[0];
    if (!name || !file) { toast('请填写名称并选择图片'); return; }
    const reader = new FileReader();
    reader.onload = async () => { await fetch('/api/expressions/'+encodeURIComponent(charName), { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name,imageData:reader.result}) }); overlay.remove(); loadExpressions(); };
    reader.readAsDataURL(file);
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});
loadExpressions();

// ---------- 输出过滤器管理 UI ----------
// —— loadRegexRulesUI 已抽到 app/04-panels.js（F 批）——
// —— editRegexRule 已抽到 app/09-ui.js（F 批）——
document.getElementById('regex-add-btn')?.addEventListener('click', () => editRegexRule(null));
document.getElementById('regex-test-btn')?.addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">测试过滤规则</div><label class="api-field">正则表达式<input id="rt-pattern" type="text" style="width:100%;font-family:monospace"></label><label class="api-field">替换为<input id="rt-replacement" type="text" style="width:100%"></label><label class="api-field">测试文本<textarea id="rt-text" class="world-setting" rows="4" style="width:100%"></textarea></label><div id="rt-result" style="margin-top:8px;padding:8px;background:var(--bg2);border-radius:6px;font-size:13px;min-height:40px"></div><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="rt-close" class="btn-sm" style="padding:6px 16px">关闭</button><button id="rt-run" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">测试</button></div></div>`;
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
// —— loadLorebookUI 已抽到 app/04-panels.js（F 批）——
// —— renderLorebookList 已抽到 app/04-panels.js（F 批）——
document.getElementById('lb-search')?.addEventListener('input', () => renderLorebookList());
// —— editLorebookEntry 已抽到 app/09-ui.js（F 批）——
document.getElementById('lb-add-btn')?.addEventListener('click', () => editLorebookEntry(null));
// 从世界书导入设定触发器（支持自定义路径）
document.getElementById('lb-wb-btn')?.addEventListener('click', async () => {
  const defaultPath = '';   // G-F1（2026-09-05）：不再预填路径（本版无此目录，按预填导入必报错）
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:520px;max-height:85vh;display:flex;flex-direction:column">
    <div style="font-size:15px;font-weight:500;margin-bottom:8px">📥 从世界书导入设定触发器</div>
    <label class="api-field">世界书目录（绝对或相对路径）<input id="wb-path" type="text" value="${defaultPath}" style="width:100%" placeholder="如：./worldbook 或绝对路径"></label>
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
      <button id="wb-import" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px" disabled>导入选中</button>
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
        const constTag = e.constant ? ' <span style="color:var(--accent);font-size:10px">常驻</span>' : '';
        const existsTag = e.exists ? ' <span style="color:var(--danger);font-size:10px">已导入</span>' : '';
        return `<label style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:4px;cursor:pointer;background:var(--bg2);margin-bottom:3px">
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
  // 2026-09-03 修复 M-7：原为 `c.checked = c.disabled`，而 disabled 恰代表「已导入」→
  // 点「仅未导入」勾中的全是已导入项，导入时又过滤 `checked && !disabled` → 实际导入 0 条。
  overlay.querySelector('#wb-onlynew').onclick = () => checkboxes().forEach(c => { c.checked = !c.disabled; });
  overlay.querySelector('#wb-import').onclick = async () => {
    const ids = checkboxes().filter(c => c.checked && !c.disabled).map(c => c.dataset.id);
    if (!ids.length) { toast('请先勾选要导入的条目'); return; }
    const p = overlay.querySelector('#wb-path').value.trim();
    const ir = await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import-worldbook', entry: { ids, path: p || undefined } }) });
    const id = await ir.json();
    overlay.remove();
    loadLorebookUI();
    toast(`✅ 已导入 ${id.imported || 0} 条设定触发器`);
  };
});
document.getElementById('lb-scan-btn')?.addEventListener('click', async () => {
  const testText = prompt('输入测试文本：');
  if (testText === null) return;
  const r = await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scan', testText, entry: { chatId: App.chatId } }) });
  const d = await r.json();
  toast(`扫描结果：${d.matched||0} 条命中，注入 ${d.totalTokens||0} token（预算 ${d.budget||0}）`);
});
document.getElementById('lb-settings-btn')?.addEventListener('click', () => {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">设定触发器设置</div><label style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><input type="checkbox" id="lbs-enabled" ${App.lorebookSettingsCache.enabled!==false?'checked':''}> 启用设定触发器（关闭后整体不注入）</label><label class="api-field">Token 预算模式<select id="lbs-budget-mode"><option value="auto" ${App.lorebookSettingsCache.tokenBudget==='auto'?'selected':''}>自动（10% maxContext）</option><option value="custom" ${typeof App.lorebookSettingsCache.tokenBudget==='number'?'selected':''}>自定义</option><option value="unlimited" ${App.lorebookSettingsCache.tokenBudget==='unlimited'?'selected':''}>不限制</option></select></label><label class="api-field">自定义预算（token）<input id="lbs-budget-val" type="number" value="${typeof App.lorebookSettingsCache.tokenBudget==='number'?App.lorebookSettingsCache.tokenBudget:10000}" style="width:100%"></label><label class="api-field">自动模式比例（0.01-0.5）<input id="lbs-ratio" type="number" step="0.01" min="0.01" max="0.5" value="${App.lorebookSettingsCache.budgetRatio||0.1}" style="width:100%"></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="lbs-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="lbs-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
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

// ---------- 世界书（多本 · 按会话启用）UI ----------
// 与「设定触发器」并存：世界书是更结构化的一套（多本／每本一文件／按会话启用／书级总开关），
// 注入时两者合并为一条扫描链（服务端 scanWorldbooks）。
App.wbBooks = [];
App.wbActive = [];
App.wbOff = [];
App.wbCurrent = null;
App.wbEntries = {};
// —— loadWorldbooksUI 已抽到 app/04-panels.js（F 批）——
// —— renderWbBooks 已抽到 app/04-panels.js（F 批）——
// —— openWbEditor 已抽到 app/09-ui.js（F 批）——
// —— closeWbEditor 已抽到 app/09-ui.js（F 批）——
// —— renderWbEntries 已抽到 app/04-panels.js（F 批）——
// —— editWbEntry 已抽到 app/09-ui.js（F 批）——
document.getElementById('wb-add-entry')?.addEventListener('click', () => editWbEntry(null));
document.getElementById('wb-close-editor')?.addEventListener('click', closeWbEditor);
// 页内弹窗（统一走 modal-overlay，不依赖系统 prompt/alert/confirm）
// —— wbModal 已抽到 app/09-ui.js（F 批）——
// —— wbConfirm 已抽到 app/09-ui.js（F 批）——
document.getElementById('wb-new-btn')?.addEventListener('click', () => {
  wbModal('新建世界书',
    '<label class="api-field">名称<input id="wbn-name" type="text" placeholder="如：本作主线设定" style="width:100%"></label>' +
    '<label class="api-field">id（英文/数字/短横线，用作文件名）<input id="wbn-id" type="text" value="book-' + Date.now() + '" style="width:100%"></label>' +
    '<label class="api-field">作用域<select id="wbn-scope"><option value="chat">chat ＝ 按会话启用</option><option value="global">global ＝ 全局始终生效</option></select></label>',
    async (ov) => {
      const name = ov.querySelector('#wbn-name').value.trim();
      const id = ov.querySelector('#wbn-id').value.trim();
      const scope = ov.querySelector('#wbn-scope').value;
      if (!name) { toast('请填写世界书名称'); return; }
      if (!id) { toast('请填写 id'); return; }
      const r = await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create-book', book: { id, name, scope } }) });
      const d = await r.json();
      if (d.error) { toast(d.error); return; }
      ov.remove();
      await loadWorldbooksUI();
      openWbEditor(d.id);
    }, '创建');
});
// ⚙️ 注入设置（总开关 / Token 预算）
document.getElementById('wb-settings-btn')?.addEventListener('click', async () => {
  let st = {};
  try { st = (await (await fetch('/api/lorebook')).json()).settings || {}; } catch (e) { st = {}; }
  const mode = st.tokenBudget === 'unlimited' ? 'unlimited' : (typeof st.tokenBudget === 'number' ? 'custom' : 'auto');
  wbModal('世界书注入设置',
    '<label style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><input type="checkbox" id="wbs-enabled"' + (st.enabled !== false ? ' checked' : '') + '> 启用注入（关闭后设定触发器与世界书都不注入）</label>' +
    '<label class="api-field">Token 预算模式<select id="wbs-mode"><option value="auto"' + (mode === 'auto' ? ' selected' : '') + '>自动（maxContext × 比例）</option><option value="custom"' + (mode === 'custom' ? ' selected' : '') + '>自定义</option><option value="unlimited"' + (mode === 'unlimited' ? ' selected' : '') + '>不限制</option></select></label>' +
    '<label class="api-field">自定义预算（token）<input id="wbs-budget" type="number" value="' + (typeof st.tokenBudget === 'number' ? st.tokenBudget : (st.maxBudget || 10000)) + '" style="width:100%"></label>' +
    '<label class="api-field">自动模式比例（0.01-0.5）<input id="wbs-ratio" type="number" step="0.01" min="0.01" max="0.5" value="' + (st.budgetRatio || 0.1) + '" style="width:100%"></label>' +
    '<div style="font-size:11px;color:var(--muted,#888);margin-top:8px;line-height:1.6">· 「强制注入（每轮）」条目不受预算限制<br>· 其余条目按优先级排序后截断到预算内</div>',
    async (ov) => {
      const m = ov.querySelector('#wbs-mode').value;
      const tokenBudget = m === 'auto' ? 'auto' : m === 'unlimited' ? 'unlimited' : (Number(ov.querySelector('#wbs-budget').value) || 10000);
      const settings = { enabled: ov.querySelector('#wbs-enabled').checked, tokenBudget, budgetRatio: Number(ov.querySelector('#wbs-ratio').value) || 0.1 };
      const r = await fetch('/api/lorebook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'settings', settings }) });
      const d = await r.json();
      if (d.error) { toast(d.error); return; }
      ov.remove();
      toast('已保存：' + (settings.enabled ? '注入开启' : '⛔ 注入已关闭') + ' · 预算 ' + (tokenBudget === 'auto' ? '自动 ' + settings.budgetRatio : tokenBudget === 'unlimited' ? '不限制' : tokenBudget + ' tokens'));
      loadWorldbooksUI();
    }, '保存');
});
// 📥 从世界书目录导入条目 —— 复用「设定触发器」卡片的导入弹窗（同一份 frontmatter 导入器）
document.getElementById('wb-import-st-btn')?.addEventListener('click', () => {
  const btn = document.getElementById('lb-wb-btn');
  if (btn) btn.click(); else toast('导入入口不可用');
});
document.getElementById('wb-scan-btn')?.addEventListener('click', () => {
  wbModal('扫描测试',
    '<label class="api-field">测试文本<textarea id="wbs-text" class="world-setting" rows="3" style="width:100%" placeholder="含角色名/地点名，如：某角色站在旧居门口"></textarea></label><div style="font-size:11px;color:var(--muted,#888);margin-top:4px">结果分两组：①仅按你输入的测试文本 ②再叠加本会话最近 10 条消息（＝真实注入口径）</div><div id="wbs-result" style="margin-top:10px;font-size:12px;color:var(--muted,#888);white-space:pre-wrap;line-height:1.7"></div>',
    async (ov) => {
      const text = ov.querySelector('#wbs-text').value;
      const r = await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'scan', chatId: App.chatId || '', testText: text }) });
      const d = await r.json();
      if (d.error) { ov.querySelector('#wbs-result').textContent = d.error; return; }
      if (d.disabled) { ov.querySelector('#wbs-result').textContent = '设定触发器总开关已关闭（设置里「启用注入」）⇒ 不注入任何条目'; return; }
      const skipNote = d.skippedGlobal ? '本会话写了【排除设定触发器】⇒ 已跳过全局层，以下只含本会话启用的世界书\n\n' : '';
      const onlyList = (d.onlyNames || []).join('\n') || '（无）';
      const ctxList = (d.names || []).join('\n') || '（无）';
      ov.querySelector('#wbs-result').textContent = skipNote +
        '【仅按测试文本】命中 ' + (d.onlyMatched || 0) + ' 条 / 注入 ' + (d.onlyEntries || 0) + ' 条\n' + onlyList +
        '\n\n【含本会话最近 10 条上下文】命中 ' + (d.matched || 0) + ' 条 / 注入 ' + ((d.entries || []).length) + ' 条（预算 ' + (d.budget || 0) + ' tokens）\n' + ctxList;
    }, '扫描');
});
// 批量启用/关闭 + 导入条目
// —— wbBatch 已抽到 app/09-ui.js（F 批）——
// —— wbSelectedIds 已抽到 app/09-ui.js（F 批）——
document.getElementById('wb-select-all')?.addEventListener('change', (e) => {
  document.querySelectorAll('.wb-e-sel').forEach(cb => { cb.checked = e.target.checked; });
});
document.getElementById('wb-enable-sel')?.addEventListener('click', () => wbBatch(wbSelectedIds(), true));
document.getElementById('wb-disable-sel')?.addEventListener('click', () => wbBatch(wbSelectedIds(), false));
document.getElementById('wb-enable-all')?.addEventListener('click', () => wbBatch([], true));
document.getElementById('wb-disable-all')?.addEventListener('click', () => wbBatch([], false));
document.getElementById('wb-import-btn')?.addEventListener('click', () => {
  if (!App.wbCurrent) { toast('请先选择一本世界书'); return; }
  wbModal('导入条目',
    '<div style="font-size:12px;color:var(--muted,#888);margin-bottom:6px">粘贴 JSON（支持 {"entries":{...}} 或直接 {...} 形式），并入当前世界书</div><textarea id="wbi-json" class="world-setting" rows="8" style="width:100%" placeholder=\'{"entries":{"my-entry":{"name":"条目名","keywords":["关键词"],"content":"内容"}}}\'></textarea>',
    async (ov) => {
      const json = ov.querySelector('#wbi-json').value;
      if (!json.trim()) { toast('请粘贴 JSON'); return; }
      const r = await fetch('/api/worldbooks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import-entries', bookId: App.wbCurrent, json }) });
      const d = await r.json();
      if (d.error) { toast(d.error); return; }
      ov.remove();
      toast('已导入 ' + d.count + ' 条');
      await openWbEditor(App.wbCurrent); loadWorldbooksUI();
    }, '导入');
});
document.getElementById('wb-entry-search')?.addEventListener('input', () => renderWbEntries());
loadWorldbooksUI();

// ---------- 关系图谱管理 UI ----------
App.graphDataCache = { nodes: [], edges: [] };
// —— loadGraphUI 已抽到 app/04-panels.js（F 批）——
// —— renderGraph 已抽到 app/04-panels.js（F 批）——
// —— editGraphNode 已抽到 app/09-ui.js（F 批）——
document.getElementById('graph-add-node')?.addEventListener('click', async () => { const name = prompt('角色名称：'); if (!name?.trim()) return; await fetch('/api/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'addNode', node: { name: name.trim() } }) }); loadGraphUI(); });
document.getElementById('graph-add-edge')?.addEventListener('click', async () => {
  const nodes = App.graphDataCache.nodes; if (nodes.length < 2) { toast('至少需要 2 个角色'); return; }
  const from = prompt('从哪个角色？\n可选：' + nodes.map(n => n.name).join(', '));
  const to = prompt('到哪个角色？\n可选：' + nodes.map(n => n.name).join(', '));
  const label = prompt('关系标签（如：朋友/家人/敌人）：');
  if (!from || !to) return;
  const fn = nodes.find(n => n.name === from), tn = nodes.find(n => n.name === to);
  if (!fn || !tn) { toast('名称不匹配'); return; }
  await fetch('/api/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'addEdge', edge: { from: fn.id, to: tn.id, label: label || '' } }) }); loadGraphUI();
});
loadGraphUI();

// ---------- 剧情记忆管理 UI ----------
// —— loadStoryMemoryUI 已抽到 app/04-panels.js（F 批）——
document.getElementById('memory-refresh-btn')?.addEventListener('click', loadStoryMemoryUI);
document.getElementById('memory-config-btn')?.addEventListener('click', async () => {
  const r = await fetch('/api/story-memory/config');
  const d = await r.json();
  const config = d.config || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="font-size:15px;font-weight:500;margin-bottom:12px">剧情记忆配置</div><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-scene" ${config.scene ? 'checked' : ''}> 场景档案注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-character" ${config.character ? 'checked' : ''}> 角色档案注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-relationship" ${config.relationship ? 'checked' : ''}> 关系档案注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-expression" ${config.expression ? 'checked' : ''}> 情绪注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-wardrobe" ${config.wardrobe !== false ? 'checked' : ''}> 着装注入</label><label style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><input type="checkbox" id="smc-inventory" ${config.inventory !== false ? 'checked' : ''}> 物品栏注入</label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="smc-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="smc-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
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

// ===== 向量语义检索面板（批E · 2026-09-18）=====
// 索引过期角标：不打开「🔍 语义」tab 也能看到提醒。
// 触发条件：已建过索引 且 待索引块数比已索引多出 VEC_STALE_THRESHOLD 以上（聊了不少新内容）。
const VEC_STALE_THRESHOLD = 20;
// —— refreshVecStaleBadge 已抽到 app/09-ui.js（F 批）——

// —— loadVecStatus 已抽到 app/04-panels.js（F 批）——

// —— doVecSearch 已抽到 app/09-ui.js（F 批）——

document.getElementById('vec-search-btn')?.addEventListener('click', doVecSearch);
document.getElementById('vec-query')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doVecSearch(); } });

document.getElementById('vec-build-btn')?.addEventListener('click', async () => {
  if (!App.chatId) { toast('无会话'); return; }
  const btn = document.getElementById('vec-build-btn');
  const old = btn.textContent;
  btn.textContent = '建索引中…（首次较慢）';
  btn.disabled = true;
  try {
    const d = await (await fetch('/api/vec/build', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId }),
    })).json();
    if (d.ok) {
      const kinds = Object.entries(d.byKind || {}).map(([k, n]) => `${k} ${n}`).join('/');
      toast(`✅ 索引完成：${d.total} 块（${kinds}）`);
    } else { toast(d.error || '建索引失败', 'err'); }
  } catch (e) { toast('建索引异常：' + e.message, 'err'); }
  btn.textContent = old;
  btn.disabled = false;
  loadVecStatus();
});

document.getElementById('vec-config-btn')?.addEventListener('click', async () => {
  const st = await (await fetch(`/api/vec/status?chatId=${encodeURIComponent(App.chatId || '')}`)).json().catch(() => ({}));
  const cfg = (st && st.config) || {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box u-modal-sm">
    <div style="font-size:15px;font-weight:500;margin-bottom:12px">🔍 语义检索设置</div>
    <label class="api-field">embedding 端点（OpenAI 兼容 <code>/embeddings</code>）
      <input id="vc-base" type="text" placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" value="${safeHtml(cfg.baseURL || '')}" style="width:100%">
    </label>
    <label class="api-field">embedding 模型名
      <input id="vc-model" type="text" value="${safeHtml(cfg.model || '')}" style="width:100%">
    </label>
    <label class="api-field">embedding API Key（留空则复用「辅助 API」的 Key / 环境变量）
      <input id="vc-key" type="password" placeholder="${cfg.hasKey ? '已配置（留空保持不变）' : 'sk-...'}" style="width:100%">
    </label>
    <label style="display:flex;align-items:center;gap:8px;margin:10px 0">
      <input type="checkbox" id="vc-auto" ${cfg.autoInject ? 'checked' : ''}> 自动注入（每轮用你的输入语义召回相关旧剧情给 AI）
    </label>
    <label class="api-field">召回条数 TopK
      <input id="vc-topk" type="number" min="1" max="12" step="1" value="${cfg.injectTopK ?? 4}">
    </label>
    <label class="api-field">最低相关度（0-1，低于此值不注入）
      <input id="vc-min" type="number" min="0" max="1" step="0.05" value="${cfg.minScore ?? 0.35}">
    </label>
    <div class="api-msg" style="margin-top:8px">⚠️ 自动注入会在每轮对话额外调用一次 embedding（有少量费用；本地端点则无）。索引本身只在点「建立/重建索引」时计算。</div>
    <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button id="vc-cancel" class="btn-sm" style="padding:6px 16px">取消</button>
      <button id="vc-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#vc-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#vc-save').onclick = async () => {
    const body = {
      baseURL: overlay.querySelector('#vc-base').value.trim(),
      model: overlay.querySelector('#vc-model').value.trim(),
      autoInject: overlay.querySelector('#vc-auto').checked,
      injectTopK: Number(overlay.querySelector('#vc-topk').value) || 4,
      minScore: Number(overlay.querySelector('#vc-min').value),
    };
    const k = overlay.querySelector('#vc-key').value.trim();
    if (k) body.apiKey = k;
    const d = await (await fetch('/api/vec/config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    if (d.ok) { toast('✅ 设置已保存'); overlay.remove(); loadVecStatus(); refreshVecStaleBadge(); }
    else { toast(d.error || '保存失败', 'err'); }
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
});

// ---------- 地点档案管理 UI（知识库格式，可导出 markdown 复用） ----------
App.locationDetailsCache = [];
// —— loadLocationsUI 已抽到 app/04-panels.js（F 批）——
document.getElementById('location-refresh-btn')?.addEventListener('click', loadLocationsUI);

// ---------- 玩家身份管理 UI ----------
App.personasCache = {};
App.activePersonaCache = '';
// —— loadPersonasUI 已抽到 app/04-panels.js（F 批）——
// —— editPersona 已抽到 app/09-ui.js（F 批）——
document.getElementById('persona-add-btn')?.addEventListener('click', () => editPersona(null));
loadPersonasUI();

// ---------- 剧情备忘管理 UI ----------
// —— loadAgendaUI 已抽到 app/04-panels.js（F 批）——
document.getElementById('agenda-add-btn')?.addEventListener('click', async () => { if (!App.chatId) { toast('请先打开对话'); return; } const content = prompt('备忘内容：'); if (!content?.trim()) return; await fetch('/api/agenda/' + encodeURIComponent(App.chatId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', item: { content: content.trim() } }) }); loadAgendaUI(); });

// ---------- 报告系统 UI ----------
// —— loadReportListUI 已抽到 app/04-panels.js（F 批）——
// —— showReportPreview 已抽到 app/09-ui.js（F 批）——
document.getElementById('report-overview-btn')?.addEventListener('click', async () => {
  if (!App.chatId) { toast('请先打开对话'); return; }
  const range = prompt('报告范围（last10/today/all）：', 'last10');
  if (!range) return;
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="text-align:center;padding:20px;color:var(--muted,#888)">正在生成回顾报告...</div></div>`; document.body.appendChild(overlay);
  try { const r = await fetch('/api/report/overview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: App.chatId, range }) }); const d = await r.json(); overlay.remove(); if (d.error) { toast('生成失败：' + d.error); return; } showReportPreview(d.content, '回顾报告'); loadReportListUI(); } catch (e) { overlay.remove(); toast('请求失败：' + e.message); }
});
document.getElementById('report-audit-btn')?.addEventListener('click', async () => {
  if (!App.chatId) { toast('请先打开对话'); return; }
  const range = prompt('报告范围（last10/today/all）：', 'last10');
  if (!range) return;
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="text-align:center;padding:20px;color:var(--muted,#888)">正在生成自检报告...</div></div>`; document.body.appendChild(overlay);
  try { const r = await fetch('/api/report/audit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: App.chatId, range }) }); const d = await r.json(); overlay.remove(); if (d.error) { toast('生成失败：' + d.error); return; } showReportPreview(d.content, '自检报告'); loadReportListUI(); } catch (e) { overlay.remove(); toast('请求失败：' + e.message); }
});
document.getElementById('report-retro-btn')?.addEventListener('click', async () => {
  if (!App.chatId) { toast('请先打开对话'); return; }
  if (!confirm('回溯分析会分批调用 AI 分析全部历史消息，可能消耗较多 token。继续？')) return;
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'; overlay.innerHTML = `<div class="modal-box" style="max-width:400px"><div style="text-align:center;padding:20px;color:var(--muted,#888)">正在回溯分析...</div></div>`; document.body.appendChild(overlay);
  try { const r = await fetch('/api/analyze/retro', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: App.chatId }) }); const d = await r.json(); overlay.remove(); if (d.error) { toast('分析失败：' + d.error); return; } showReportPreview(d.content, `回溯分析（${d.stats?.messages||0} 条消息，${d.stats?.batches||0} 批）`); loadReportListUI(); } catch (e) { overlay.remove(); toast('请求失败：' + e.message); }
});
loadReportListUI();

// ---------- 旁注管理 UI ----------
// —— loadAnnotationsUI 已抽到 app/04-panels.js（F 批）——
// —— editAnnotation 已抽到 app/09-ui.js（F 批）——
// 内联添加旁注（2026-09-03 补齐：DOM 补全后的「位置+内容+回车」快捷录入）
// —— addAnnotationInline 已抽到 app/09-ui.js（F 批）——
document.getElementById('ann-add-btn')?.addEventListener('click', addAnnotationInline);
document.getElementById('ann-content-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAnnotationInline(); } });
loadAnnotationsUI();

// ---------- 可折叠分组（card-group + 独立卡片 collapsible，状态存 localStorage） ----------
const FOLD_KEY = 'mr-sidebar-folded';
App.foldedCards = [];
try { App.foldedCards = JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); } catch (e) { App.foldedCards = []; }
// —— applyFoldedState 已抽到 app/09-ui.js（F 批）——
// —— saveFoldedState 已抽到 app/09-ui.js（F 批）——
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
// ---------- 侧栏面板切换（2026-09-02：31 卡片一长列 → 4 tab 分面板）----------
// 记住上次选的面板（localStorage），刷新后停在原处。
(function initSidebarPanels() {
  const KEY = 'rw-sidebar-panel';
  const tabs = [...document.querySelectorAll('.sb-tab')];
  const panels = [...document.querySelectorAll('.sb-panel')];
  if (!tabs.length) return;

  function activate(panelId, save) {
    // 切换前钩子（收藏面板用它把卡片搬回原位；未注册时为空操作）
    if (typeof window.__sbBeforePanelSwitch === 'function') window.__sbBeforePanelSwitch(panelId);
    for (const t of tabs) t.classList.toggle('active', t.dataset.panel === panelId);
    for (const p of panels) p.classList.toggle('hidden', p.id !== panelId);
    if (save) { try { localStorage.setItem(KEY, panelId); } catch (e) { /* 忽略 */ } }
    // 切换后钩子（收藏面板用它把收藏卡片搬进来）
    if (typeof window.__sbAfterPanelSwitch === 'function') window.__sbAfterPanelSwitch(panelId);
    document.getElementById('sidebar')?.scrollTo({ top: 0, behavior: 'smooth' });
  }
  for (const t of tabs) t.addEventListener('click', () => activate(t.dataset.panel, true));
  // 恢复上次面板
  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch (e) { /* 忽略 */ }
  if (saved && panels.some(p => p.id === saved)) activate(saved, false);
  // 暴露给搜索用：命中跨面板时自动切过去
  window.__sbActivatePanel = activate;
})();

// ---------- 侧栏功能搜索（2026-09-05 收官轮 G-D3 修复：HTML/CSS 09-02 已同步但本函数漏同步 → 死 UI）----------
// 匹配卡片标题；命中高亮、未命中隐藏。搜索时跳出面板限制（全部面板一起搜），清空后恢复。
(function initSidebarSearch() {
  const input = document.getElementById('sidebar-search');
  const clearBtn = document.getElementById('sidebar-search-clear');
  const wrap = document.getElementById('sidebar-search-wrap');
  const sidebar = document.getElementById('sidebar');
  if (!input || !sidebar) return;

  let tempExpanded = [];        // 搜索时临时展开的折叠卡片
  let panelBeforeSearch = '';   // 搜索前所在面板，清空后恢复

  const titleTextOf = (card) => {
    const t = card.querySelector(':scope > .card-title');
    return t ? t.textContent.replace(/[\u25be\u25b4]/g, '').trim().toLowerCase() : '';
  };
  const allPanels = () => [...sidebar.querySelectorAll('.sb-panel')];
  const panelShown = (p) => !p.classList.contains('hidden');   // 面板显隐走 .hidden 类

  function resetFilter() {
    sidebar.querySelectorAll('.card').forEach(c => c.classList.remove('search-hit', 'search-miss'));
    for (const c of tempExpanded) c.classList.add('collapsed');
    tempExpanded = [];
    wrap?.classList.remove('filtering');
    document.getElementById('sidebar-search-empty')?.remove();
    if (panelBeforeSearch && window.__sbActivatePanel) window.__sbActivatePanel(panelBeforeSearch, false);
    panelBeforeSearch = '';
  }

  function applyFilter(q) {
    if (!q) { resetFilter(); return; }
    if (!panelBeforeSearch) {
      const cur = allPanels().find(panelShown);
      panelBeforeSearch = cur ? cur.id : '';
    }
    sidebar.querySelectorAll('.card').forEach(c => c.classList.remove('search-hit', 'search-miss'));
    for (const c of tempExpanded) c.classList.add('collapsed');
    tempExpanded = [];
    document.getElementById('sidebar-search-empty')?.remove();
    wrap?.classList.add('filtering');
    // 搜索期间显示所有功能面板（⭐ 面板是克隆借位容器，隐藏）
    for (const p of allPanels()) p.classList.toggle('hidden', p.id === 'panel-fav');

    let hitCount = 0;
    for (const card of sidebar.querySelectorAll('.sb-panel > .card')) {
      const hit = titleTextOf(card).includes(q);
      card.classList.toggle('search-miss', !hit);
      card.classList.toggle('search-hit', hit);
      if (hit) {
        hitCount++;
        if (card.classList.contains('collapsed')) { card.classList.remove('collapsed'); tempExpanded.push(card); }
      }
    }
    if (!hitCount) {
      const tip = document.createElement('div');
      tip.id = 'sidebar-search-empty';
      tip.textContent = '没有匹配「' + q + '」的功能';
      sidebar.appendChild(tip);
    }
  }

  input.addEventListener('input', () => applyFilter(input.value.trim().toLowerCase()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); input.value = ''; resetFilter(); input.blur(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      sidebar.querySelector('.card.search-hit')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  clearBtn?.addEventListener('click', () => { input.value = ''; resetFilter(); input.focus(); });
})();

// ---------- 命令面板（Ctrl+K / ⌘K） ----------
// 与侧栏「🔍 搜功能」是两条路径：那个在原地筛卡片，这个是弹层直达 + 跨面板跳转 + 键盘流。
(function initCmdK() {
  const cmdk = document.getElementById('cmdk');
  const input = document.getElementById('cmdk-input');
  const list = document.getElementById('cmdk-list');
  const openBtn = document.getElementById('cmd-open');
  if (!cmdk || !input || !list) return;

  const paneLabel = { 'panel-chat': '💬 对话', 'panel-setting': '📖 设定', 'panel-data': '📊 数据', 'panel-system': '⚙ 系统', 'panel-fav': '⭐ 收藏' };
  const ACTIONS = [
    { label: '➕ 新建对话', k: '动作', run: () => { newChat(); } },
    { label: '🔁 刷新会话列表', k: '动作', run: () => { loadChatList(); } },
  ];

  let items = [];     // {title, k, pane, cardId, run}
  let selIdx = 0;

  function buildItems() {
    items = [];
    // 全部卡片（从 DOM 读标题 + 面板归属）；收藏面板是克隆借位容器，排除
    document.querySelectorAll('.sb-panel:not(#panel-fav) .card').forEach(card => {
      const pane = card.closest('.sb-panel')?.id || '';
      const t = card.querySelector(':scope > .card-title');
      let title = card.id;
      if (t) {
        // 克隆标题，剔除按钮/控件/折叠箭头/星标后取纯文字，得到卡片主标题
        const clone = t.cloneNode(true);
        clone.querySelectorAll('button, select, input, .fold-arrow, .card-fav, .sort-btns, .stale-badge, span[style], .badge').forEach(n => n.remove());
        title = (clone.textContent || '').replace(/[▾⬊★☆\s]+/g, ' ').trim();
        if (title.length > 26) title = title.slice(0, 26) + '…';
      }
      items.push({ title, k: paneLabel[pane] || pane, pane, cardId: card.id, run: () => gotoCard(pane, card.id) });
    });
    ACTIONS.forEach(a => items.push({ title: a.label, k: a.k, run: a.run }));
  }

  function gotoCard(pane, cardId) {
    if (window.__sbActivatePanel) window.__sbActivatePanel(pane, true);
    const el = document.getElementById(cardId);
    if (el) { el.classList.remove('collapsed'); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  let currentHits = [];
  function render(filter) {
    const q = (filter || '').trim().toLowerCase();
    currentHits = items.filter(it => !q || it.title.toLowerCase().includes(q) || it.k.toLowerCase().includes(q));
    if (!currentHits.length) { list.innerHTML = '<div class="cmdk-empty">没有匹配「' + safeHtml(filter || '') + '」的功能</div>'; currentHits = []; return; }
    if (selIdx >= currentHits.length) selIdx = currentHits.length - 1;
    if (selIdx < 0) selIdx = 0;
    list.innerHTML = '';
    const nodes = [];
    currentHits.forEach((it, i) => {
      const div = document.createElement('div');
      div.className = 'cmdk-item' + (i === selIdx ? ' sel' : '');
      div.innerHTML = '<span>' + safeHtml(it.title) + '</span><span class="k">' + safeHtml(it.k) + '</span>';
      div.addEventListener('click', () => { it.run(); close(); });
      list.appendChild(div);
      nodes.push(div);
    });
    // 滚进可视区的是 DOM 节点（currentHits 装的是条目对象，不能直接当元素用）
    nodes[selIdx]?.scrollIntoView({ block: 'nearest' });
  }

  function open() {
    buildItems(); selIdx = 0; input.value = '';
    cmdk.classList.add('show'); render('');
    input.focus();
  }
  function close() { cmdk.classList.remove('show'); }

  openBtn?.addEventListener('click', open);
  cmdk.addEventListener('click', (e) => { if (e.target === cmdk) close(); });
  input.addEventListener('input', () => { selIdx = 0; render(input.value); });
  input.addEventListener('keydown', (e) => {
    const hits = [...list.querySelectorAll('.cmdk-item')];
    if (e.key === 'ArrowDown') { e.preventDefault(); selIdx = Math.min(selIdx + 1, hits.length - 1); render(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); selIdx = Math.max(selIdx - 1, 0); render(input.value); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = currentHits[selIdx]; if (it) { it.run(); close(); } }
    else if (e.key === 'Escape') { close(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); cmdk.classList.contains('show') ? close() : open(); }
    else if (e.key === 'Escape') { close(); }
  });
})();

// ---------- agent 导演台（未经测试 · 实验性；默认关闭）----------
// 开关在「⚙ API → agent 助手」；本卡片负责与 agent 对话（Meta）、看认知包与禁忌。
(function initMetaUI() {
  const badge = document.getElementById('meta-badge');
  const input = document.getElementById('meta-input');
  const sendBtn = document.getElementById('meta-send-btn');
  const msgEl = document.getElementById('meta-msg');
  const histEl = document.getElementById('meta-history');
  const packEl = document.getElementById('meta-cogpack');
  const tabooEl = document.getElementById('meta-taboo-area');
  const gCb = document.getElementById('agent-global');
  const pcSel = document.getElementById('agent-perchat');
  if (!input || !sendBtn) return;

  const setMsg = (t, ok) => { if (msgEl) { msgEl.textContent = t || ''; msgEl.className = 'group-msg ' + (ok ? 'ok' : 'err'); } };
  function paintMode(d) {
    const on = !!(d && d.global);
    if (gCb) gCb.checked = on;
    if (pcSel) pcSel.value = (d && d.perChat && d.perChat[App.chatId]) || 'inherit';
    if (badge) { badge.textContent = on ? '开' : 'agent 未开启'; badge.className = 'badge ' + (on ? 'on' : 'off'); }
  }
  async function loadMode() {
    try { paintMode(await (await fetch('/api/agent-mode')).json()); } catch (e) { /* 忽略 */ }
  }
  async function postMode(body) {
    try {
      const d = await (await fetch('/api/agent-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
      paintMode(d);
      setMsg(d && d.ok ? '已保存' : ('保存失败：' + ((d && d.error) || '')), !!(d && d.ok));
    } catch (e) { setMsg('保存失败：' + e.message, false); }
  }
  gCb?.addEventListener('change', (e) => postMode({ global: !!e.target.checked }));
  pcSel?.addEventListener('change', (e) => postMode({ chatId: App.chatId, mode: e.target.value }));

  async function loadMeta() {
    if (!App.chatId) return;
    try {
      const d = await (await fetch('/api/meta?chatId=' + encodeURIComponent(App.chatId))).json();
      if (!d || !d.ok) return;
      const rows = (d.entries || []).slice().reverse().slice(0, 20).map((e) => {
        const who = e.role === 'user' ? '你' : 'agent';
        const cls = e.cls ? `[${escapeHtml(e.cls)}]` : '';
        const txt = escapeHtml(String(e.summary || e.raw || '').slice(0, 120));
        return `<div class="mh-row"><span class="mh-who">${who}</span>${cls} ${txt}</div>`;
      });
      if (histEl) histEl.innerHTML = rows.length ? rows.join('') : '（暂无）';
      if (packEl) {
        const cp = d.cogpack || {};
        const cand = (d.candidates || []).length;
        packEl.innerHTML = `角色可知 ${cp.knowledge || 0} 条 · 导演意图 ${cp.direction || 0} 条` + (cand ? ` · 未采纳候选 ${cand} 条` : '');
      }
    } catch (e) { /* 忽略 */ }
  }
  async function loadTaboos() {
    if (!tabooEl) return;
    try {
      const d = await (await fetch('/api/taboos')).json();
      const es = (d && d.entries) || [];
      if (!es.length) { tabooEl.textContent = '（暂无）'; return; }
      tabooEl.innerHTML = es.slice(0, 20).map((e) => {
        const st = { pending: '待确认', active: '已生效', resolved: '已归档' }[e.status] || e.status;
        const btn = e.status === 'pending' ? ` <button class="head-btn" style="padding:1px 8px;font-size:10px" data-tb-confirm="${escapeHtml(e.id)}">✅ 确认生效</button>` : '';
        return `<div class="meta-taboo-row ${e.status === 'pending' ? 'pending' : ''}"><span class="tb-rule">${escapeHtml(e.rule || '')}</span><span class="tb-st">${st}</span>${btn}</div>`;
      }).join('');
      tabooEl.querySelectorAll('[data-tb-confirm]').forEach((b) => b.addEventListener('click', async () => {
        try { await fetch('/api/taboos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'confirm', id: b.dataset.tbConfirm }) }); loadTaboos(); } catch (e) { /* 忽略 */ }
      }));
    } catch (e) { /* 忽略 */ }
  }
  async function sendMeta() {
    const text = String(input.value || '').trim();
    if (!text) return;
    if (!App.chatId) { setMsg('先打开一个会话', false); return; }
    sendBtn.disabled = true; setMsg('发送中…', true);
    try {
      const d = await (await fetch('/api/meta', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: App.chatId, text }) })).json();
      if (d && d.ok) { input.value = ''; setMsg('已记录（' + (d.cls || 'query') + '）' + (d.fix ? '；已给出修正草案，可在下方禁忌里确认入库' : ''), true); }
      else setMsg('发送失败：' + ((d && d.error) || ''), false);
    } catch (e) { setMsg('发送失败：' + e.message, false); }
    sendBtn.disabled = false;
    loadMeta(); loadTaboos();
  }
  sendBtn.addEventListener('click', sendMeta);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendMeta(); } });
  window.__metaReload = () => { loadMode(); loadMeta(); loadTaboos(); };
  loadMode(); loadMeta(); loadTaboos();
})();

// ---------- 侧栏收藏（⭐ 常用）：把高频卡片钉到第一个 tab，不用记它在哪个分类 ----------
// 实现方式：不移动 DOM（避免打乱面板结构与已绑定事件），而是**克隆引用**——
// 收藏面板里放的是原卡片的「移动占位」：切到 ⭐ 时把收藏的卡片临时 append 进来，切走时还原回原面板。
(function initSidebarFav() {
  const FAV_KEY = 'rw-sidebar-fav';
  const favPanel = document.getElementById('panel-fav');
  const sidebar = document.getElementById('sidebar');
  if (!favPanel || !sidebar) return;

  let favs = [];
  try { favs = JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { favs = []; }
  /* ⭐ 常驻制（2026-09-06）：收藏卡本体常驻 panel-fav（不因切分区搬回）；
     homeOf 持久化（重启后取消收藏仍知道回哪个面板）。 */
  const HOME_KEY = 'mr-sidebar-home';
  const homeLoad = () => { try { return JSON.parse(localStorage.getItem(HOME_KEY) || '{}'); } catch (e) { return {}; } };
  const homeOf = new Map(Object.entries(homeLoad()));
  const saveHome = () => { try { localStorage.setItem(HOME_KEY, JSON.stringify(Object.fromEntries(homeOf))); } catch (e) { /* 忽略 */ } };

  function saveFavs() { try { localStorage.setItem(FAV_KEY, JSON.stringify(favs)); } catch (e) { /* 忽略 */ } }

  // 给每张卡片标题挂 ☆ / ★ 按钮
  function mountStars() {
    for (const card of sidebar.querySelectorAll('.sb-panel > .card')) {
      const title = card.querySelector(':scope > .card-title');
      if (!title || title.querySelector('.card-fav')) continue;
      if (!homeOf.has(card.id)) homeOf.set(card.id, card.closest('.sb-panel')?.id || '');
      const btn = document.createElement('button');
      btn.className = 'card-fav' + (favs.includes(card.id) ? ' on' : '');
      btn.textContent = favs.includes(card.id) ? '★' : '☆';
      btn.title = favs.includes(card.id) ? '取消收藏' : '收藏到 ⭐ 常用';
      btn.setAttribute('aria-label', btn.title);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();   // 不触发卡片折叠
        const i = favs.indexOf(card.id);
        if (i >= 0) favs.splice(i, 1); else favs.push(card.id);
        saveFavs();
        const on = favs.includes(card.id);
        btn.classList.toggle('on', on);
        btn.textContent = on ? '★' : '☆';
        btn.title = on ? '取消收藏' : '收藏到 ⭐ 常用';
        /* ⭐ 常驻制（2026-09-06）：收藏→本体常驻 panel-fav；取消→搬回原面板 */
        if (on) {
          if (!homeOf.has(card.id)) homeOf.set(card.id, card.closest('.sb-panel')?.id || '');
          saveHome();
          const favP = document.getElementById('panel-fav');
          if (favP && card.parentElement !== favP) favP.appendChild(card);
          card.classList.remove('collapsed');
        } else {
          const home = document.getElementById(homeOf.get(card.id) || '');
          if (home) home.appendChild(card);
          homeOf.delete(card.id); saveHome();
        }
        if (typeof fillFav === 'function') fillFav();
        toast(on ? '已收藏（常驻 ⭐ 收藏页）' : '已取消收藏');
      });
      // 插到折叠箭头之前（箭头需保持在最右），无箭头时直接追加
      const arrow = title.querySelector('.fold-arrow, .group-arrow');
      if (arrow) title.insertBefore(btn, arrow);
      else title.appendChild(btn);
    }
  }

  // 切到 ⭐ 面板时：把收藏的卡片搬进来；切走时搬回原面板
  function fillFav() {
    favPanel.querySelector('#panel-fav-empty')?.remove();
    const valid = favs.filter(id => document.getElementById(id));
    if (!valid.length) {
      const tip = document.createElement('div');
      tip.id = 'panel-fav-empty';
      tip.innerHTML = '还没有收藏的功能<br><span style="opacity:.7">在任意卡片标题右侧点 ☆ 即可收藏</span>';
      favPanel.appendChild(tip);
      return;
    }
    for (const id of valid) {
      const card = document.getElementById(id);
      if (card && card.parentElement !== favPanel) favPanel.appendChild(card);
    }
  }
  /* ⭐ 常驻制：删除「切出 ⭐ 搬回原面板」——收藏卡常驻收藏页（取消收藏才搬回，见 mountStars click） */
  function restoreFav() { /* 已废除（常驻制） */ }

  mountStars();
  // 通过面板切换钩子进出 ⭐：离开时把卡片搬回原面板，进入时搬进来
  window.__sbBeforePanelSwitch = () => { /* 常驻制：切分区不搬回，收藏卡常驻 */ };
  window.__sbAfterPanelSwitch = (panelId) => {
    if (panelId === 'panel-fav') fillFav();
  };
  // 若刷新后停在 ⭐ 面板，补填一次
  if (!favPanel.classList.contains('hidden')) fillFav();
})();

applyFoldedState();

// ---------- 侧栏卡片拖拽排序（card-group + 独立卡片，顺序存 localStorage） ----------
(function initSidebarDragSort() {
  const SORT_KEY = 'mr-sidebar-order';
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  // 2026-09-03 修复 M-6：面板化后卡片已下沉到 .sb-panel 内，`:scope > .card` 取不到任何元素
  // （cards.length===0 直接 return）→ 整个拖拽排序静默失效。
  const CARD_SEL = '.sb-panel > .card';
  const cards = Array.from(sidebar.querySelectorAll(CARD_SEL));
  if (!cards.length) return;
  // 顺序按「所属面板」分别记录，避免跨面板串位
  const orderNow = () => {
    const o = {};
    for (const panel of sidebar.querySelectorAll('.sb-panel')) {
      o[panel.id] = Array.from(panel.querySelectorAll(':scope > .card')).map(x => x.id);
    }
    return o;
  };
  const saveOrder = () => { try { localStorage.setItem(SORT_KEY, JSON.stringify(orderNow())); } catch (e) { /* 忽略 */ } };

  // 恢复保存的顺序（按面板内部重排，不再插到 #sidebar 直属导致脱离 tab）
  try {
    const saved = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
    if (saved && !Array.isArray(saved) && typeof saved === 'object') {
      for (const [panelId, ids] of Object.entries(saved)) {
        const panel = document.getElementById(panelId);
        if (!panel || !Array.isArray(ids)) continue;
        for (const id of ids) {
          const el = document.getElementById(id);
          if (el && el.parentElement === panel) panel.appendChild(el);
        }
      }
    }
  } catch (e) { /* 忽略 */ }

  let dragEl = null;
  let dragOverEl = null;
  let dragArmed = false;   // mousedown 落在标题栏才武装（draggable 在拖拽中会被浏览器缓存，用标志兜底）

  // 拖拽手柄（修复 2026-08-30）：整卡 draggable=true 会让 Chrome 拖拽手势抢占鼠标选择，
  // 卡片内文本（导出框等）无法选中复制 → 改为「仅标题栏可拖」：
  // 默认 draggable=false（文本可正常选择），mousedown 落在 .card-title 时才临时启用拖拽。
  cards.forEach(c => {
    // 标题栏（含 .card-title；.group-toggle 是折叠按钮不参与拖拽——已有 stopPropagation 保护）
    const handle = c.querySelector('.card-title');
    c.draggable = false;
    if (handle) {
      handle.style.cursor = 'grab';
      handle.addEventListener('mousedown', () => { c.draggable = true; dragArmed = true; });
      window.addEventListener('mouseup', () => { c.draggable = false; dragArmed = false; }, { once: true });
    }
    c.addEventListener('dragstart', (e) => {
      // 仅标题栏启动拖拽；文本区 mousedown 时 draggable 为 false，不会走到这里
      if (!dragArmed) { e.preventDefault(); return; }
      dragEl = c;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', c.id); } catch (err) { /* 忽略 */ }
      c.classList.add('drag-sorting');
    });
    c.addEventListener('dragend', () => {
      if (dragEl) dragEl.classList.remove('drag-sorting');
      cards.forEach(x => x.classList.remove('drag-over'));
      dragEl = null; dragOverEl = null;
      c.draggable = false;   // 拖拽结束复位（title 上的 mouseup 有时不触发）
      dragArmed = false;
      saveOrder();   // M-6：按面板保存
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
      // 只允许同面板内排序：跨 tab 拖拽会让卡片落到别的面板里（切 tab 就消失）
      if (dragEl && dragEl !== c && dragEl.parentElement === c.parentElement) {
        const rect = c.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        if (after) c.after(dragEl); else c.before(dragEl);
        saveOrder();
      }
    });
    // group-toggle（分组头）不参与拖拽排序；card-title 现在是拖拽手柄，不放 stopPropagation（否则 dragstart 不冒泡到卡片）
    c.querySelector('.group-toggle')?.addEventListener('dragstart', (e) => e.stopPropagation());
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
  if (App.streaming) return; // 流式生成期间不响应跨标签页切换，防止数据写错会话
  if (e.key === CUR_CHAT_KEY && e.newValue !== App.chatId) {
    fetch('/api/chats/' + e.newValue).then((r) => r.json()).then((c) => {
      if (c && !c.error) openChat(e.newValue);   // 不再跳过空会话
    }).catch(() => {});
  } else if (e.key === PREFS_KEY || e.key === 'mr-custom-skin') {
    location.reload();   // 主题/背景/侧栏偏好：刷新应用
  }
});
maybeStartTour();
setInterval(loadStats, 15000);

// 会话恢复：有当前会话则打开（包括空会话），否则新建
(async () => {
  let saved = localStorage.getItem(CUR_CHAT_KEY);
  // 桌面壳（WebView2）里 localStorage 可能不落盘 → 回落到服务端记住的最后会话
  if (!saved) {
    try { saved = (await (await fetch('/api/last-chat')).json()).chatId || ''; } catch (e) { saved = ''; }
  }
  if (saved) {
    try {
      const c = await (await fetch('/api/chats/' + saved)).json();
      if (c && !c.error) { await openChat(saved); return; }   // 修复：不再跳过空会话
    } catch (e) { /* 继续新建 */ }
  }
  await newChat();
})();


// ===== 消息书签 UI（2026-09-02 NEW-2）=====


// ===== 从某条消息分叉出新会话（2026-09-02）=====
// —— forkFromSeq 已抽到 app/06-timeline.js（F 批）——

// —— loadBookmarksUI 已抽到 app/04-panels.js（F 批）——

// —— syncBookmarkButtons 已抽到 app/06-timeline.js（F 批）——

// 跳到指定 seq 的气泡（分段加载下若未渲染，先自动加载更早的直到出现）
function jumpToSeq(seq) {
  let wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  let guard = 0;
  while (!wrap && Number(App.renderCursor) > 0 && guard++ < 40) {
    renderHistorySlice(RENDER_BATCH);
    wrap = els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`);
  }
  if (!wrap) { toast('未找到该消息（可能已被删除或截断）', 'err'); return; }
  wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  wrap.classList.add('msg-search-hit');
  setTimeout(() => wrap.classList.remove('msg-search-hit'), 1800);
}


// ===== 消息时间轴导航（2026-09-02，去除旁注色分支）=====
// —— renderTimelineNav 已抽到 app/04-panels.js（F 批）——

function updateTimelineCurrent() {
  const nav = document.getElementById('timeline-nav');
  if (!nav || nav.classList.contains('hidden')) return;
  const box = els.messages;
  const mid = box.scrollTop + box.clientHeight / 2;
  let bestSeq = null, bestDist = Infinity;
  for (const w of els.messages.querySelectorAll('.msg-wrap[data-seq]')) {
    const c = w.offsetTop + w.offsetHeight / 2;
    const d = Math.abs(c - mid);
    if (d < bestDist) { bestDist = d; bestSeq = w.dataset.seq; }
  }
  for (const t of nav.children) t.classList.toggle('cur', t.dataset.seq === bestSeq);
}
(function bindTimelineScroll() {
  let raf = 0;
  els.messages?.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; updateTimelineCurrent(); });
  }, { passive: true });
})();

// ============ 群聊模式 ============
// 独立「＋ 群聊」入口建会话 + 侧栏面板随时调配置。
const Group = {
  cfg: { groupMode: false, roster: [], maxSpeakersPerTurn: 4 },
  els: {},
  async load(chatId) {
    if (!chatId) return;
    try {
      const d = await (await fetch('/api/group/' + encodeURIComponent(chatId))).json();
      if (d && d.ok) {
        this.cfg = { groupMode: !!d.groupMode, roster: d.roster || [],
          maxSpeakersPerTurn: d.maxSpeakersPerTurn || 4 };
        this.render();
      }
    } catch (e) { /* 会话无群聊配置属正常 */ }
  },
  async save(msg) {
    if (!App.chatId) return;
    try {
      const r = await fetch('/api/group/' + encodeURIComponent(App.chatId), {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(this.cfg),
      });
      const d = await r.json();
      this.tip(d && d.ok ? (msg || '已保存') : ('保存失败：' + ((d && d.error) || '未知')), !(d && d.ok));
      this.render();
    } catch (e) { this.tip('保存失败：' + e.message, true); }
  },
  tip(text, isErr) {
    const el = this.els.msg; if (!el) return;
    el.textContent = text; el.className = 'group-msg' + (isErr ? ' err' : ' ok');
    setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'group-msg'; } }, 2600);
  },
  render() {
    const e = this.els; if (!e.enable) return;
    e.enable.checked = !!this.cfg.groupMode;
    if (e.maxspk) e.maxspk.value = this.cfg.maxSpeakersPerTurn || 4;
    if (e.badge) {
      e.badge.textContent = this.cfg.groupMode ? ('群聊 · ' + (this.cfg.roster || []).length + ' 人') : '未开启';
      e.badge.className = 'badge' + (this.cfg.groupMode ? '' : ' off');
    }
    if (!e.roster) return;
    const list = this.cfg.roster || [];
    if (!list.length) { e.roster.innerHTML = '<div class="group-hint">（空 · 随剧情自动加入）</div>'; return; }
    const TIER = { npc: ['📝', '角色档案'], new: ['🆕', '全新角色'] };
    e.roster.innerHTML = list.map((r, i) => {
      const t = TIER[r.tier] || ['·', ''];
      return '<div class="group-role' + (r.muted ? ' muted' : '') + '">'
        + '<span class="gr-tier" title="' + t[1] + '">' + t[0] + '</span>'
        + '<span class="gr-name">' + escapeHtml(r.name) + '</span>'
        + '<label class="gr-mute"><input type="checkbox" data-gi="' + i + '" class="gr-mute-cb"' + (r.muted ? ' checked' : '') + '>禁言</label>'
        + '<input type="number" class="gr-lines" data-gi="' + i + '" min="1" max="6" value="' + (r.maxLines || 3) + '" title="每轮最多句数">'
        + '<button class="gr-del" data-gi="' + i + '" title="移出名单">✕</button>'
        + '</div>';
    }).join('');
    e.roster.querySelectorAll('.gr-mute-cb').forEach((cb) => cb.addEventListener('change', () => {
      this.cfg.roster[+cb.dataset.gi].muted = cb.checked; this.save('已更新');
    }));
    e.roster.querySelectorAll('.gr-lines').forEach((ip) => ip.addEventListener('change', () => {
      this.cfg.roster[+ip.dataset.gi].maxLines = Math.max(1, Math.min(6, +ip.value || 3)); this.save('已更新');
    }));
    e.roster.querySelectorAll('.gr-del').forEach((b) => b.addEventListener('click', () => {
      this.cfg.roster.splice(+b.dataset.gi, 1); this.save('已移出');
    }));
  },
  init() {
    const g = (id) => document.getElementById(id);
    this.els = { enable: g('group-enable'), maxspk: g('group-maxspk'),
      roster: g('group-roster'), badge: g('group-badge'), msg: g('group-msg'),
      addName: g('group-add-name'), addBtn: g('group-add-btn'), saveBtn: g('group-save-btn') };
    const e = this.els;
    if (e.enable) e.enable.addEventListener('change', () => { this.cfg.groupMode = e.enable.checked; this.save(e.enable.checked ? '群聊已开启' : '已关闭'); });
    if (e.maxspk) e.maxspk.addEventListener('change', () => { this.cfg.maxSpeakersPerTurn = Math.max(1, Math.min(8, +e.maxspk.value || 4)); this.save('已更新'); });
    if (e.addBtn) e.addBtn.addEventListener('click', () => {
      const n = (e.addName.value || '').trim(); if (!n) return;
      if ((this.cfg.roster || []).some((r) => r.name === n)) { this.tip('已在名单中', true); return; }
      this.cfg.roster = this.cfg.roster || [];
      this.cfg.roster.push({ name: n, muted: false, maxLines: 3, tier: 'new' });
      e.addName.value = ''; this.save('已加入：' + n);
    });
    if (e.addName) e.addName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') e.addBtn.click(); });
    if (e.saveBtn) e.saveBtn.addEventListener('click', () => this.save());
  },
};

// 「＋ 群聊」：建普通会话后立即开启群聊模式
async function newGroupChat() {
  if (App.streaming) return;
  const prev = App.chatId;
  await newChat();
  if (!App.chatId || App.chatId === prev) return;   // 用户在配置档选择处取消
  Group.cfg = { groupMode: true, roster: [], maxSpeakersPerTurn: 4 };
  await Group.save('群聊模式已开启');
  const card = document.getElementById('card-group');
  // 展开群聊面板：折叠态类名是 collapsed（saveFoldedState 依据 DOM 存 localStorage，
  // 必须一并保存，否则刷新后又被折叠回去）
  if (card) { card.classList.remove('collapsed'); saveFoldedState(); card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}

// 群聊：按钮绑定 + 会话切换时加载配置 + @ 自动补全
(function initGroupUI() {
  Group.init();
  const btn = document.getElementById('new-group-btn');
  if (btn) btn.addEventListener('click', newGroupChat);

  // 会话切换 → 同步群聊配置
  if (typeof openChat === 'function') {
    const _openChat = openChat;
    window.openChat = openChat = async function (id) {
      const r = await _openChat(id);
      Group.load(id);
      return r;
    };
  }
  if (App.chatId) Group.load(App.chatId);

  // @ 自动补全：只提示本会话 roster 内角色 + 旁白
  const input = document.getElementById('input');
  if (!input) return;
  let pop = null;
  const closePop = () => { if (pop) { pop.remove(); pop = null; } };
  input.addEventListener('input', () => {
    if (!Group.cfg.groupMode) { closePop(); return; }
    const pos = input.selectionStart || 0;
    const m = input.value.slice(0, pos).match(/@([^\s@]*)$/);
    if (!m) { closePop(); return; }
    const q = m[1];
    const names = ['旁白', ...(Group.cfg.roster || []).filter((r) => !r.muted).map((r) => r.name)];
    const hits = names.filter((n) => !q || n.includes(q)).slice(0, 8);
    if (!hits.length) { closePop(); return; }
    closePop();
    pop = document.createElement('div');
    pop.className = 'group-at-pop';
    pop.innerHTML = hits.map((n, i) => '<div class="gat-item' + (i === 0 ? ' active' : '') + '" data-n="' + escapeHtml(n) + '">' + escapeHtml(n) + '</div>').join('');
    const box = input.getBoundingClientRect();
    pop.style.left = box.left + 'px';
    pop.style.top = (box.top - Math.min(hits.length, 8) * 28 - 6) + 'px';
    pop.style.width = Math.min(box.width, 220) + 'px';
    document.body.appendChild(pop);
    pop.querySelectorAll('.gat-item').forEach((it) => it.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const name = it.dataset.n;
      input.value = input.value.slice(0, pos - q.length) + name + ' ' + input.value.slice(pos);
      input.focus();
      const np = pos - q.length + name.length + 1;
      input.setSelectionRange(np, np);
      closePop();
    }));
  });
  input.addEventListener('keydown', (ev) => {
    if (!pop) return;
    const items = [...pop.querySelectorAll('.gat-item')];
    const cur = items.findIndex((x) => x.classList.contains('active'));
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[cur] && items[cur].classList.remove('active');
      const ni = ev.key === 'ArrowDown' ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
      items[ni].classList.add('active');
    } else if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      (items[cur] || items[0]).dispatchEvent(new MouseEvent('mousedown'));
    } else if (ev.key === 'Escape') { closePop(); }
  });
  input.addEventListener('blur', () => setTimeout(closePop, 150));
})();
