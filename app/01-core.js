// app/01-core.js —— 共享工具（toast / 确认弹窗 / 请求 / 文本净化 / markdown）
// F-01 自 app.js 整体搬迁，零逻辑改动。依赖 app/00-state.js（按序先加载）。
'use strict';

// ===== Toast 轻量提示（2026-09-01）=====
// 替代阻塞式 window.alert()：不打断沉浸感，也不会在 headless 截图时卡住页面。
// 用法：toast('已保存') / toast('保存失败：xxx', 'err') / toast(msg, 'warn', 6000)
// 类型自动推断：以 ✅ 开头→ok；含「失败/错误/无效/不存在」→err；含「请先/暂无」→warn。
// 点击可立即关闭；多条纵向堆叠；超过 4 条时自动移除最旧的一条。
function toast(msg, type, ms) {
  const text = String(msg ?? '').trim();
  if (!text) return;
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  if (!type) {
    if (/^[✅✓]/.test(text)) type = 'ok';
    else if (/失败|错误|无效|不存在|出错|异常/.test(text)) type = 'err';
    else if (/^请先|^请输入|^请选择|暂无|还没有|为空/.test(text)) type = 'warn';
    else type = '';
  }
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = text;
  const close = () => {
    if (el.dataset.leaving) return;
    el.dataset.leaving = '1';
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  };
  el.addEventListener('click', close);
  host.appendChild(el);
  while (host.children.length > 4) host.firstChild.remove();
  setTimeout(close, ms || (type === 'err' ? 5000 : 3200));
}
window.toast = toast;

// ===== UI-4 无障碍：title → aria-label 自动同步（2026-09-02）=====
// 原问题：气泡操作栏等处 37 个纯图标按钮（📋❝📌✏️✂️✕🔊🎨）只有 title，
// 屏幕阅读器读不出用途、键盘 Tab 导航也没有语义。
// 做法：用 MutationObserver 全局兜底——凡有 title 无 aria-label 的按钮自动补上，
// 无需逐个改 25+ 处创建代码（也覆盖将来新增的按钮）。
(function initAriaSync() {
  const sync = (root) => {
    const scope = root && root.querySelectorAll ? root : document;
    for (const el of scope.querySelectorAll('button[title]:not([aria-label]), [role="button"][title]:not([aria-label])')) {
      const t = el.getAttribute('title');
      if (t) el.setAttribute('aria-label', t);
    }
  };
  sync(document);
  // 动态创建的按钮（气泡操作栏/弹窗等）也自动补
  try {
    if (document.body) {
      new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) if (n.nodeType === 1) sync(n.matches?.('button[title]') ? n.parentNode : n);
        }
      }).observe(document.body, { childList: true, subtree: true });
    }
  } catch (e) { /* 老浏览器降级：仅首次同步 */ }
})();

// ===== 自定义确认弹窗（2026-09-02 FN-2）=====
// 替代原生 await confirmDialog()：①不阻塞页面（流式回复进行中也能弹）②视觉与主题统一
// ③危险操作可用红色强调。复用 .modal-overlay/.modal-box（已有全局 ESC/遮罩关闭委托）。
// 用法：if (!await confirmDialog('要删除吗？', { danger: true })) return;
//      if (!await confirmDialog('⚠️ 危险操作', { danger: true, okText: '确认删除' })) return;
function confirmDialog(message, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const danger = !!o.danger;
    // 消息里的换行转 <br>，保留原 confirm 的多行表达力
    const body = safeHtml(String(message || '')).replace(/\n/g, '<br>');
    overlay.innerHTML = `<div class="modal-box u-modal-sm">
      <div class="cfm-body">${body}</div>
      <div class="cfm-actions">
        <button class="btn-sm u-btn-lg cfm-cancel">${safeHtml(o.cancelText || '取消')}</button>
        <button class="btn-sm u-btn-lg cfm-ok${danger ? ' danger' : ''}">${safeHtml(o.okText || '确定')}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    }
    overlay.querySelector('.cfm-ok').addEventListener('click', () => done(true));
    overlay.querySelector('.cfm-cancel').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.addEventListener('keydown', onKey, true);   // 捕获阶段，优先于全局 ESC 委托
    overlay.querySelector('.cfm-ok').focus();
  });
}
window.confirmDialog = confirmDialog;

// ===== 加载态 + 错误详情统一封装（2026-09-02 UI-2/FN-3）=====
// 原问题：37 个 load* 函数里 35 个 fetch 期间无任何反馈（点了像卡住），
// 且失败只显示"加载失败"三字无原因（排障没线索）。
// 用法：await withLoading(box, async () => { ...原加载逻辑... }, { rows: 3 });
async function withLoading(el, fn, opts) {
  if (!el) { try { return await fn(); } catch (e) { console.error('[withLoading] 无容器', e); return; } }
  const rows = (opts && opts.rows) || 3;
  const prev = el.innerHTML;
  el.innerHTML = `<div class="skeleton-wrap">${'<div class="skeleton-line"></div>'.repeat(rows)}</div>`;
  try {
    return await fn();
  } catch (e) {
    // 错误详情：区分 HTTP 状态 / 网络异常 / 解析失败，给出可排障的信息
    const msg = e && e.message ? e.message : String(e);
    el.innerHTML = `<div class="load-error">加载失败<div class="load-error-detail">${safeHtml(msg)}</div>
      <button class="load-retry">↻ 重试</button></div>`;
    el.querySelector('.load-retry')?.addEventListener('click', () => withLoading(el, fn, opts));
    console.error('[加载失败]', msg, e);
  }
}
// fetch 包装：非 2xx 抛出带状态码的错误（否则 .json() 会静默失败或抛无意义的解析错）
async function fetchJson(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText || ''}`.trim() + ` · ${url.split('?')[0]}`);
  try {
    return await r.json();
  } catch (e) {
    throw new Error('响应不是合法 JSON（后端可能返回了错误页）');
  }
}

// ===== 弹窗全局 ESC 关闭（2026-09-02 外观阶段B 收尾）=====
// 此前 33 个弹窗只有点遮罩能关、按 ESC 关不掉（体验缺口）。
// 用一处全局监听覆盖所有弹窗：关闭最上层的 .modal-overlay（后插入的在 DOM 后面 = 视觉最上层），
// 不改动 33 处弹窗结构（避免逐个重构的风险）。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const overlays = document.querySelectorAll('.modal-overlay');
  if (!overlays.length) return;
  const top = overlays[overlays.length - 1];
  // 输入中（textarea/input 内）按 ESC 也应能关弹窗，故不排除输入焦点
  top.remove();
  e.stopPropagation();
});

// 弹窗遮罩点击关闭（兜底）：33 个弹窗里 5 个漏写了 overlay.onclick，用全局委托统一补齐。
// 只在点击目标 === overlay 本身（即遮罩空白区，非弹窗内容）时关闭，与各弹窗自带逻辑一致、不冲突。
document.addEventListener('click', (e) => {
  if (e.target instanceof Element && e.target.classList.contains('modal-overlay')) {
    e.target.remove();
  }
});


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
const CHAR_PALETTE = ['#a78bfa', '#f87171', 'var(--info)', '#f5c97b', '#f9a8d4', 'var(--success)', '#fb923c', '#c084fc', '#67e8f9', '#5eead4', '#f0abfc', '#fda4af', '#fde68a', '#818cf8', '#d1d5db', '#fbbf24'];
function nameColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return CHAR_PALETTE[h % CHAR_PALETTE.length];
}

App.history = [];          // [{role, content, seq}]
App.msgSeq = 0;            // 消息序号（重roll/删除定位用）
App.streaming = false;

// ---------- 渲染 ----------
// 无立绘：一律首字徽章（本版无任何角色图片素材）
function avatarHtml(name) {
  const ch = String(name || '?').slice(0, 1).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  /* ⭐ S5（2026-09-06）：有自定义头像的角色显示图片（启动/上传后由 loadAvatarCache 刷新映射） */
  const custom = (window.avatarCustomCache || {})[name];
  if (custom) return `<img class="avatar-img" src="${custom}" alt="${ch}" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'avatar-badge',style:'background:${nameColor(name)}',textContent:'${ch}'}))">`;
  return `<span class="avatar-badge" style="background:${nameColor(name)}">${ch}</span>`;
}
/* 头像映射缓存：GET /api/avatar/list → { 角色名: url } */
function loadAvatarCache() {
  fetch('/api/avatar/list').then((r) => r.json()).then((d) => {
    if (!d.ok) return;
    window.avatarCustomCache = {};
    for (const f of d.files || []) window.avatarCustomCache[f.name] = f.url;
  }).catch(() => {});
}
loadAvatarCache();

function parseSegments(text) {
  const segs = [];
  let cur = null;
  const lines = text.split('\n');
  const push = () => { if (cur && cur.text.trim()) segs.push(cur); cur = null; };
  for (const raw of lines) {
    const line = raw.trimEnd();
    /* ⭐ m0 混合式兜底（2026-09-07）：AI 常输出「角色名（动作）：台词」——m1 名字类不含括号、
       m2 要求整行以）结尾，两条都不中 → 整段落进旁白累加器（角色丢头像/丢气泡，内部空行原样显示）。
       这里先吃掉混合式，角色名与台词各归其位，动作存 seg.action 渲染为斜体动作行。 */
    const m0 = /^([\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z][\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z·]{0,10})[（(]([^）)]{1,60})[）)]\s*[：:]\s*(.*)$/.exec(line);
    const m1 = /^([\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z][\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z·]{0,10})[：:]\s*(.*)$/.exec(line);
    const m2 = /^([\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z][\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7afA-Za-z·]{0,10})[（(](.+)[）)]$/.exec(line);
    if (m0) {
      push();
      segs.push({ char: m0[1], action: m0[2], text: m0[3], actionOnly: false });
    } else if (m1) {
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
  return segs.filter((s) => s.text.trim() || (s.action && s.action.trim()));
}

// XSS 防护：转义 HTML 特殊字符（含引号，可安全用于属性上下文）
function safeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeHtml(s) {
  return safeHtml(s);
}
// 颜色白名单（2026-09-03 安全修复）：转义不拦 `;`，颜色值直插 style 时仍可注入任意 CSS
// （外链背景、遮挡点击区）。仅放行 #hex / rgb(a) / 纯字母颜色名，非法回落 null。
function safeColor(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
  if (/^rgba?\(\s*[\d.\s,%]+\)$/.test(s)) return s;
  if (/^[a-zA-Z]{3,20}$/.test(s)) return s;
  return null;
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
