// app/05-settings.js —— 设定 / 自定义注入 / 常驻设定 / 皮肤与背景
// F 批自 app.js 整体搬迁，零逻辑改动（括号配对切块）。
// 注：本文件只放函数定义；顶层事件绑定留在 app.js，待 F-09 集中到 10-bind.js。
'use strict';

async function loadInjections() {
  try {
    const r = await (await fetch('/api/op/inject?chatId=' + encodeURIComponent(App.chatId || ''))).json();
    if (r.ok) {
      document.getElementById('inject-prefix').value = r.prefix || '';
      document.getElementById('inject-suffix').value = r.suffix || '';
    }
  } catch (e) { /* 忽略 */ }
}

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

async function saveAttachPending(text) {
  await fetch('/api/op/attach-pending', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: App.chatId || '', text: String(text || '') }),
  });
}

async function loadAttachPending() {
  // 打开会话时恢复「已附加」状态（本轮消费后由 saveAttachPending('') 清除）
  if (!App.chatId) { App.pendingContext = ''; return; }
  try {
    const r = await (await fetch('/api/op/attach-pending?chatId=' + encodeURIComponent(App.chatId))).json();
    const t = (r && r.text || '').trim();
    App.pendingContext = t;
    if (t) els.manAttachNote.classList.remove('hidden');
  } catch (e) { /* 忽略 */ }
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
