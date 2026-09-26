// app/02-render.js —— 消息容器与气泡渲染（重roll / 版本回溯 / 编辑 / 截断 / 分段渲染）
// F-02 自 app.js 整体搬迁，零逻辑改动。依赖 00-state（App/els）与 01-core（escapeHtml 等）。
'use strict';

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
        if (!t) { toast('该消息无文本可朗读'); return; }
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
        if (!t) { toast('该消息无文本可配图'); return; }
        openIllustration(t.slice(0, 300));
      });
      bar.appendChild(illBtn);
    }
    // ===== F6 气泡内一键复制 / 引用（2026-09-02）=====
    const cpBtn = document.createElement('button');
    cpBtn.className = 'ma-btn';
    cpBtn.textContent = '📋';
    cpBtn.title = '复制该条文本';
    cpBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const t = (wrap.querySelector('.bubble')?.textContent || '').trim();
      if (!t) { toast('该消息无文本可复制'); return; }
      try {
        await navigator.clipboard.writeText(t);
        cpBtn.textContent = '✅';
        setTimeout(() => { cpBtn.textContent = '📋'; }, 1200);
      } catch (err) { toast('复制失败（浏览器未授权剪贴板）', 'err'); }
    });
    bar.appendChild(cpBtn);
    const qtBtn = document.createElement('button');
    qtBtn.className = 'ma-btn';
    qtBtn.textContent = '❝';
    qtBtn.title = '引用该条内容到输入框（继续往下写）';
    qtBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = (wrap.querySelector('.bubble')?.textContent || '').trim();
      if (!t) { toast('该消息无文本可引用'); return; }
      const quoted = t.split('\n').map(l => '> ' + l).join('\n');
      const cur = els.input.value;
      els.input.value = quoted + '\n\n' + (cur ? cur : '');
      els.input.focus();
      els.input.setSelectionRange(els.input.value.length, els.input.value.length);
      toast('已引用到输入框');
    });
    bar.appendChild(qtBtn);
    // ===== 消息书签（2026-09-02 NEW-2）=====
    const bmBtn = document.createElement('button');
    bmBtn.className = 'ma-btn bm-btn';
    bmBtn.dataset.seq = seq;
    bmBtn.textContent = '🔖';
    bmBtn.title = '加书签 / 取消书签';
    if (App.bookmarksCache?.some?.(b => Number(b.seq) === Number(seq))) bmBtn.classList.add('on');
    bmBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!App.chatId) { toast('请先打开对话'); return; }
      const label = (wrap.querySelector('.bubble')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      try {
        const d = await (await fetch('/api/bookmarks/' + encodeURIComponent(App.chatId), {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'toggle', mark: { seq, label, role: (App.history.find((m) => m.seq === seq)?.role === 'user') ? 'user' : 'assistant' } }),   /* F-4 修复：role 判在 .msg-wrap 上恒为 assistant，改按 history 实际角色 */
        })).json();
        if (d.ok) {
          bmBtn.classList.toggle('on', !!d.marked);
          toast(d.marked ? '🔖 已加书签' : '已取消书签');
          loadBookmarksUI();
        } else { toast(d.error || '操作失败', 'err'); }
      } catch (err) { toast('书签操作异常：' + err.message, 'err'); }
    });
    bar.appendChild(bmBtn);
    // ===== 从此分叉（2026-09-02）：复制该条及之前的消息到新会话 =====
    const forkBtn = document.createElement('button');
    forkBtn.className = 'ma-btn';
    forkBtn.textContent = '⤵';
    forkBtn.title = '从此分叉：把该条及之前的消息复制为新会话（原会话不变）';
    forkBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await forkFromSeq(seq);
    });
    bar.appendChild(forkBtn);
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
  // 2026-09-09 方案 C：链语义 = 全部版本（含当前显示版）。重roll 时旧版已在链中（首次则入链），
  // 新生成的回复由 generate 收尾时入链（见 pushVersionToChain），保证位次连续。
  const oldMsg = App.history[idx];
  let anchorSeq = seq;
  for (let i = idx - 1; i >= 0; i--) { if (App.history[i].role === 'user') { anchorSeq = App.history[i].seq; break; } }
  if (oldMsg && oldMsg.role === 'assistant') {
    const chain = (rerollVersions[anchorSeq] = rerollVersions[anchorSeq] || []);
    if (!chain.some((v) => v.content === oldMsg.content)) chain.push({ content: oldMsg.content, ts: Date.now() });
  }
  App.anchorForNextGen = anchorSeq;   // 供 generate 收尾时把新回复入链
  App.history = App.history.slice(0, idx);          // 截断：该条及其后全部作废（旧文本不进 AI 上下文）
  // 同步清理回合记录：删除 seq >= n 的记账（旧回复的账本不残留）
  fetch('/api/timeline/truncate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: App.chatId, seq, mode: 'gte' }),
  }).catch(() => {});
  // 旧气泡保留为「旧版本」对比样式（不进上下文；切换版本统一走气泡底部 ‹ n/N ›）
  // 2026-09-09 方案 C：移除「↩ 恢复此版」按钮——与 ‹ › 切换器语义重复，双入口易状态不同步。
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
      tag.title = '重roll 前的回复（不进上下文，仅对比；用下方 ‹ › 切换版本）';
      bar.appendChild(tag);
      const del = document.createElement('button');
      del.className = 'ma-btn del';
      del.textContent = '✕ 关闭对比';
      del.title = '仅关闭这个对比气泡；该版本仍在 ‹ › 版本链中可切换';
      del.addEventListener('click', () => { wrap.remove(); });
      bar.appendChild(del);
    }
  }
  generate();
}

// 恢复旧版本：把链中某一版放回对话尾部，成为当前显示版
// 2026-09-09 方案 C 重构：版本链语义统一为「链 = 全部版本（含当前显示版）」，
// 位次由内容反查（见 attachVersionSwiper）。此前语义混乱（链=历史版，当前版不在链）
// 导致每切一次就往链里补一份「退位版」，序号虚高（2 版切一次变 1/3、再切变 3/4）。
function restoreVersion(anchorSeq, verIdx, oldSeq) {
  if (App.streaming) return;
  const versions = rerollVersions[anchorSeq];
  if (!versions || !versions[verIdx]) return;
  const content = versions[verIdx].content;
  const anchorIdx = App.history.findIndex((m) => m.seq === anchorSeq);
  if (anchorIdx < 0) return;
  // 链已含全部版本 → 只切换 history 指针，链本身不动（避免重复入链导致序号虚高）
  App.history = App.history.slice(0, anchorIdx + 1);
  // 清理锚点后的回合记录（切换后旧回复的账本不残留）
  fetch('/api/timeline/truncate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: App.chatId, seq: anchorSeq + 1, mode: 'gte' }),
  }).catch(() => {});
  // 目标版放回原位（新 seq，避免与已存消息冲突）
  const newSeq = ++App.msgSeq;
  App.history.push({ role: 'assistant', content, seq: newSeq });
  saveChat();
  // DOM：目标气泡转正（移除 alt-version 样式），并移除其后所有气泡
  const oldWrap = els.messages.querySelector(`.msg-wrap[data-seq="${oldSeq}"]`);
  if (oldWrap) {
    // 2026-09-03 修复 M-15：原缺此行 → 气泡 data-seq 仍是旧值，
    // 而 history 里已换成 newSeq → ✕/↻ 用 findIndex 查不到（<0 静默 return），
    // 书签/时间轴也会记到已不存在的 seq 上。
    oldWrap.dataset.seq = newSeq;
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
    // 重建气泡内容（显示该版文本；走 renderMarkdown 以支持图片渲染）
    const bub = oldWrap.querySelector('.bubble');
    if (bub) { bub.innerHTML = renderMarkdown(stripTurnTags(content)); }
    // 重建版本切换器：位次由 attachVersionSwiper 按内容反查，此处不传 curIdx
    attachVersionSwiper(oldWrap, newSeq);
    // seq 变了 → 书签高亮与时间轴刻度需同步
    if (typeof syncBookmarkButtons === 'function') syncBookmarkButtons();
    if (typeof renderTimelineNav === 'function') renderTimelineNav();
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
    // F-9 修复：编辑只针对正文——原 content 尾部的记账标签区块（<storyevent>/<items>/<cycle>/<notes> 等）原样保留，
    //   不再因编辑从 history（=LLM 上下文）中永久丢失；显示层由 rebuildMsgWrap 内部处理。
    const tagRe = /<(?:storyevent|items|cycle|notes)\b[^>]*>[\s\S]*?<\/(?:storyevent|items|cycle|notes)>/gi;
    const tags = (String(App.history[idx].content || '').match(tagRe) || []).join('\n');
    App.history[idx].content = tags ? text + '\n' + tags : text;
    saveChat();
    rebuildMsgWrap(wrap, App.history[idx].role, stripTurnTags(App.history[idx].content), seq);
  });
  const cancel = document.createElement('button');
  cancel.className = 'ma-btn del';
  cancel.textContent = '取消';
  cancel.addEventListener('click', () => rebuildMsgWrap(wrap, App.history[idx].role, stripTurnTags(App.history[idx].content), seq));   // F-9 修复：取消也用剥离版渲染（旧版直接渲染含标签原文）
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
    av.style.borderColor = 'var(--info)';
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
    .replace(/<storyevent>[\s\S]*?<\/storyevent>/gi, '')
    .replace(/<items>[\s\S]*?<\/items>/gi, '')
    .replace(/^【更新】[^\n]*$/gm, '');
  for (const rule of App.regexRulesCache) { if (!rule.enabled) continue; try { result = result.replace(new RegExp(rule.pattern, rule.flags || 'g'), rule.replacement || ''); } catch (e) { /* 跳过 */ } }
  /* ⭐ 空行压缩（2026-09-07）：.bubble 是 white-space: pre-wrap，每个 \n 都原样可见。
     上面剥离标签块只删内容不收拾周围换行 + AI 自己输出的多余空行 → 气泡里成片空白。
     3+ 连续换行压成一个空行；单空行保留（段落间距）。 */
  result = result.replace(/\n{3,}/g, '\n\n');
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
    /* ⭐ 混合式动作行（2026-09-07）：seg.action 来自 parseSegments 的 m0
       「角色名（动作）：台词」——动作独立成斜体灰行置于台词之上，不与台词混排、也不丢失。 */
    if (seg.action && seg.action.trim()) {
      const actNode = document.createElement('div');
      actNode.className = 'action';
      actNode.innerHTML = `（${renderMarkdown(seg.action.trim())}）`;
      bub.appendChild(actNode);
    }
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
  // F1 Swipe 版本切换器（2026-09-02）
  attachVersionSwiper(wrap, seq);
  return wrap;
}

// 给 assistant 气泡挂版本切换器：‹ 当前/总数 ›（F1）
// curIdx: 当前显示的是第几版（0..versions.length-1 = 历史版本；null = 最新版）
// 2026-09-03 修复 M-16：原标签写死 `${total}/${total}` 且 › 永久 disabled → 切旧版后仍显示 N/N
// 给 assistant 气泡挂版本切换器：‹ 当前/总数 ›，点箭头原地切换版本
// 2026-09-09 方案 C：链语义 = 全部版本（含当前显示版）；位次由「当前气泡内容」在链中反查，
// 不再依赖调用方传 curIdx（此前 curIdx 语义在 reroll/restore 两条路径下不一致，导致序号错乱）。
function attachVersionSwiper(wrap, seq) {
  if (!wrap || seq == null) return;
  const idx = App.history.findIndex((m) => m.seq === seq);
  if (idx < 0) return;
  let anchorSeq = null;
  for (let i = idx - 1; i >= 0; i--) { if (App.history[i].role === 'user') { anchorSeq = App.history[i].seq; break; } }
  if (anchorSeq == null) return;
  const versions = rerollVersions[anchorSeq];
  if (!Array.isArray(versions) || !versions.length) return;
  const curContent = App.history[idx].content;
  // 位次反查：内容匹配 → 该下标；找不到（理论不该发生）→ 视为最后一版
  let curIdx = versions.findIndex((v) => v.content === curContent);
  if (curIdx < 0) curIdx = versions.length - 1;
  const total = versions.length;
  const cur = curIdx + 1;
  wrap.querySelector('.ver-swiper')?.remove();
  const sw = document.createElement('div');
  sw.className = 'ver-swiper';
  const prev = document.createElement('button');
  prev.className = 'ma-btn';
  prev.textContent = '‹';
  prev.disabled = cur <= 1;
  prev.title = prev.disabled ? '已是最早版本' : '上一个版本';
  prev.addEventListener('click', (e) => {
    e.stopPropagation();
    if (prev.disabled) return;
    restoreVersion(anchorSeq, curIdx - 1, seq);
  });
  const label = document.createElement('span');
  label.className = 'ver-label';
  label.textContent = `${cur}/${total}`;
  label.title = `共 ${total} 个版本，正在看第 ${cur} 个`;
  const next = document.createElement('button');
  next.className = 'ma-btn';
  next.textContent = '›';
  next.disabled = cur >= total;
  next.title = next.disabled ? '已是最新版本' : '下一个版本';
  next.addEventListener('click', (e) => {
    e.stopPropagation();
    if (next.disabled) return;
    restoreVersion(anchorSeq, curIdx + 1, seq);
  });
  sw.appendChild(prev); sw.appendChild(label); sw.appendChild(next);
  const bub = wrap.querySelector('.bubble');
  if (bub) bub.appendChild(sw);
}

// 把版本压入链（按内容去重）——generate 收尾与重roll 共用，保证链 = 全部版本
function pushVersionToChain(anchorSeq, content) {
  if (anchorSeq == null || !content) return;
  const chain = (rerollVersions[anchorSeq] = rerollVersions[anchorSeq] || []);
  if (!chain.some((v) => v.content === content)) chain.push({ content, ts: Date.now() });
}

// ===== 分段渲染（2026-09-02 FN-1：长对话不再全量渲染）=====
// 适配：无摘要压缩/旁注/书签/时间轴机制，故移除相应调用（只保留本函数核心）。
const RENDER_BATCH = 80;

function renderHistorySlice(count) {
  const hiddenSet = App.renderHidden || new Set();
  const summaryText = App.renderSummaryText || '';
  const end = App.renderCursor;                    // 本次渲染区间的右端（不含）
  const start = Math.max(0, end - count);          // 左端
  if (end <= 0) return;

  // 记录渲染前的滚动锚点（追加到顶部后保持视觉位置不跳）
  const box = els.messages;
  const prevH = box.scrollHeight, prevTop = box.scrollTop;

  // 先移除旧的「加载更早」按钮（稍后按需重建）
  document.getElementById('load-earlier-bar')?.remove();

  // 渲染 [start, end) —— 用文档片段暂存，保证插入顺序正确（要插到最前面）
  const frag = document.createDocumentFragment();
  const origMessages = els.messages;
  els.messages = frag;                             // 临时接管渲染目标
  let skippedCount = 0;
  try {
    for (let i = start; i < end; i++) {
      const m = App.history[i];
      if (!m) continue;
      if (hiddenSet.has(m.seq)) { skippedCount++; continue; }
      if (skippedCount > 0) { skippedCount = 0; }   // 无摘要折叠，仅重置计数
      if (m.role === 'user') renderUser(m.content, m.seq);
      else if (m.role === 'assistant') {
        if (m.thinking && App.prefs.showThinking !== false) renderThinking(m.thinking);
        renderAssistant(m.content, m.seq);
      }
    }
  } finally {
    els.messages = origMessages;                   // 无论如何都要还原，否则后续渲染全错
  }
  box.insertBefore(frag, box.firstChild);
  App.renderCursor = start;

  // 仍有更早的消息 → 顶部放加载按钮
  if (start > 0) {
    const bar = document.createElement('div');
    bar.id = 'load-earlier-bar';
    bar.className = 'load-earlier-bar';
    const n = Math.min(RENDER_BATCH, start);
    bar.innerHTML = `<button class="load-earlier-btn">⬆ 加载更早的 ${n} 条<span class="le-rest">（还有 ${start} 条）</span></button>`;
    bar.querySelector('.load-earlier-btn').addEventListener('click', () => renderHistorySlice(RENDER_BATCH));
    box.insertBefore(bar, box.firstChild);
  }

  // 首次渲染滚到底；追加更早内容时保持原视觉位置
  if (end === App.history.length) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevH);
  renderTimelineNav();       // 时间轴：消息集合变了重建刻度
}


function renderUser(content, seq) {
  const wrap = makeWrap('user', seq);
  const row = document.createElement('div');
  row.className = 'msg user';
  const av = document.createElement('div');
  av.className = 'avatar';
  av.style.borderColor = 'var(--info)';
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
