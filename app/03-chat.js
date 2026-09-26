// app/03-chat.js —— 收发与生成 / 会话 CRUD / 导入导出
// F-03 自 app.js 整体搬迁，零逻辑改动。依赖 00-state、01-core、02-render。
// 注：本文件只放函数定义；顶层事件绑定统一留在 app.js，F-09 再集中到 10-bind.js。
'use strict';

async function send() {
  const content = els.input.value.trim();
  if (!content || App.streaming) return;
  // 发送即取消自动保存防抖（防 3s 后以发送前旧快照 PUT 覆盖新数据）
  clearTimeout(App.autoSaveTimer);
  // 高峰时段强提醒：官方直连渠道 + 高峰时间 + 发送前确认（可设置关闭）
  if (App.peakEligible && App.prefs.peakConfirm !== false && isPeakHours(new Date())) {
    if (!confirm('⚠️ 当前为工作日高峰时段（9:00-12:00 / 14:00-18:00）\nAPI 费率较高、可能限流变卡；周末与法定节假日全天为低谷价。\n\n继续发送吗？')) {
      return;
    }
  }
  els.input.value = '';
  const seq = ++App.msgSeq;
  renderUser(content, seq);
  App.history.push({ role: 'user', content, seq });
  saveChat();
  await generate();
}

async function generate() {
  App.streaming = true;
  els.send.disabled = true;
  els.typing.classList.remove('hidden');
  const extra = App.pendingContext;
  App.pendingContext = '';
  if (extra) saveAttachPending('').catch(() => {});   // 附加资料已随本轮消费 → 清除持久化（2026-08-30）
  els.manAttachNote.classList.add('hidden');
  const seq = ++App.msgSeq;

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
        messages: App.history,
        chatId: App.chatId,
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
        } else if (ev.type === 'replace') {
          // agent 打回重试后的终稿（默认关闭时不会出现）：整段替换当前气泡
          acc = sanitizeText(ev.content || '');
          tempBub.textContent = stripTurnTags(acc);
          els.messages.scrollTop = els.messages.scrollHeight;
        } else if (ev.type === 'selfcheck') {
          // agent 生成后自检（只报不写）：在思考区给一行提示，不改正文
          renderThinking('⚠️ 自查提示：' + String(ev.note || '').replace(/\n+/g, ' '));
        } else if (ev.type === 'thinking') {
          thinkAcc += sanitizeText(ev.text);
        } else if (ev.type === 'tools') {
          renderThinking(`🔧 ${(ev.trace || []).join('；')}`);
        } else if (ev.type === 'group-plan') {
          const who = (ev.speakers || []).join('、');
          if (who || ev.narrator) renderThinking(`🎬 本轮发言：${who}${ev.narrator ? (who ? ' ＋旁白' : '旁白') : ''}`);
        } else if (ev.type === 'group-speaking') {
          renderThinking(`… ${ev.name} 正在回应`);
        } else if (ev.type === 'group-roster') {
          renderThinking(`👥 ${ev.tier === 'new' ? '新角色入场' : '角色入场'}：${(ev.added || []).join('、')}`);
        } else if (ev.type === 'group-error') {
          renderThinking(`⚠️ ${ev.name} 发言失败：${ev.error}`);
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
    if (thinkAcc.trim() && App.prefs.showThinking !== false) {
      renderThinking(thinkAcc.trim());
    }
    if (acc.trim()) {
      renderAssistant(acc.trim(), seq);
      // 思考记录一并存进 history（刷新/切会话后恢复显示）
      App.history.push({ role: 'assistant', content: acc.trim(), seq, thinking: thinkAcc.trim() || undefined });
      // 2026-09-09 方案 C：重roll 产生的新回复也入版本链（链=全部版本），
      // 保证 ‹ › 位次连续、切回旧版后还能切回来。非重roll 轮次 App.anchorForNextGen 为空 → 不入链。
      if (App.anchorForNextGen != null) {
        pushVersionToChain(App.anchorForNextGen, acc.trim());
        App.anchorForNextGen = null;
        attachVersionSwiper(els.messages.querySelector(`.msg-wrap[data-seq="${seq}"]`), seq);
      }
      // 记账标签自检（2026-08-30 修复「剧情记忆是摆设」）：AI 未输出 storyevent/items → 提醒
      if (!/<storyevent>/i.test(acc) && !/<items>/i.test(acc)) {
        renderThinking('⚠️ 本轮 AI 未输出记账标签（storyevent/items）——剧情记忆未更新；后端已将标签指令重申置底，若持续出现请在「剧情记忆」手动补记或重发。');
      }
    }
  } catch (e) {
    tempWrap.remove();
    renderAssistant(`（叙事者提示：${e.message}）`, seq);
  } finally {
    App.streaming = false;
    // 2026-09-09 方案 C：生成失败/中止时清理重roll锚点，防残留污染下一轮普通对话的入链判断
    App.anchorForNextGen = null;
    els.send.disabled = false;
    els.typing.classList.add('hidden');
    els.input.focus();
    saveChat();       // 会话自动保存（归档）
    loadTimeline();   // 剧情记忆：刷新时间线/物品栏/换装/情绪/地点（AI 回答后全量刷新）
    loadInventory();
    loadCurrentWardrobe();
    loadEmotions();
    loadLocationsUI();
    loadStats();      // 会话统计
    refreshVecStaleBadge();   // 新回合可能让向量索引过期，更新角标提醒
  }
}

async function saveChat() {
  if (!App.chatId) return;
  const firstUser = App.history.find((m) => m.role === 'user');
  const title = App.chatTitle || (firstUser ? firstUser.content.slice(0, 24) : '新对话');
  // 失败自动重试 1 次（500ms 后）；仍失败 → 状态栏提示（不静默丢数据）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch('/api/chats/' + App.chatId, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, messages: App.history, versions: rerollVersions }),
      });
      if (r.ok) { App.chatTitle = title; return; }
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
    fetch('/api/chats/' + App.chatId, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, messages: App.history }),
    }).catch(() => {});
  }, 3000);
}

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
  if (!App.chatId || !App.history.length) { toast('当前会话为空，无内容可导出'); return; }
  const firstUser = App.history.find((m) => m.role === 'user');
  const title = App.chatTitle || (firstUser ? firstUser.content.slice(0, 24) : '新对话');
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  if (!md) {
    downloadBlob(`${safeTitle}.json`, JSON.stringify({ id: App.chatId, title, exportedAt: new Date().toISOString(), messages: App.history }, null, 2), 'application/json');
  } else {
    const lines = [`# ${title}`, '', `> 导出时间：${new Date().toLocaleString()}`, ''];
    for (const m of App.history) {
      const who = m.role === 'user' ? '你' : 'AI';
      lines.push(`## ${who}`, '', String(m.content || ''), '');
    }
    downloadBlob(`${safeTitle}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
  }
}

async function loadChatList() {
  const box = document.getElementById('chat-list');
  try {
    const { chats } = await (await fetch('/api/chats')).json();
    box.innerHTML = '';
    if (!chats.length) box.textContent = '（暂无历史会话）';   /* F-7 修复：不再提前 return——否则会话全部归档后「已归档」分组渲染不到，恢复入口死路 */
    else for (const c of chats) {
      const d = document.createElement('div');
      d.className = 'chat-item' + (c.id === App.chatId ? ' active' : '');
      const time = escapeHtml((c.updatedAt || '').slice(5, 16).replace('T', ' '));
      const pc = safeColor(c.profileColor);
      const profileDot = pc ? `<span class="ci-profile-dot" style="background:${pc}" title="${escapeHtml(c.profileLabel||'默认')}"></span>` : '';
      d.innerHTML = `${profileDot}<span class="ci-pin${c.pinned ? ' on' : ''}" title="${c.pinned ? '取消置顶' : '置顶'}">📌</span><span class="ci-title"></span><span class="ci-rename" title="重命名">✏️</span><span class="ci-time">${time}</span><span class="ci-archive" title="归档">📦</span><span class="ci-del" title="删除">×</span>`;
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
          if (c.id === App.chatId) App.chatTitle = name;   // 当前会话标题同步，后续 saveChat 沿用
        } catch (err) { toast('重命名失败：' + err.message); }
        loadChatList();
      });
      d.querySelector('.ci-archive').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (App.streaming) { toast('生成中，请稍后再归档'); return; }   // F-1 修复：流式期间归档会把生成中数据写错
        if (!confirm(`归档会话「${c.title}」？\n归档后会话将隐藏，可在侧栏底部「已归档」中恢复。`)) return;
        await fetch('/api/chats/' + c.id, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hidden: true }),
        });
        if (c.id === App.chatId) { App.chatId = null; localStorage.removeItem(CUR_CHAT_KEY); }
        loadChatList();
      });
      d.querySelector('.ci-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`删除会话「${c.title}」？`)) return;
        await fetch('/api/chats/' + c.id, { method: 'DELETE' });
        if (c.id === App.chatId) { App.chatId = null; localStorage.removeItem(CUR_CHAT_KEY); }
        loadChatList();
      });
      box.appendChild(d);
    }
  } catch (e) { box.textContent = '会话列表读取失败'; }

  // 已归档会话分组（折叠）
  try {
    const { chats: archived } = await (await fetch('/api/chats?archived=true')).json();
    if (archived && archived.length > 0) {
      const section = document.createElement('div');
      section.className = 'archived-section';
      section.innerHTML = `
        <div class="archived-header" style="cursor:pointer;padding:8px 4px;color:var(--muted,#888);font-size:12px;display:flex;align-items:center;gap:4px;border-top:1px solid var(--border,#333);margin-top:8px">
          <span class="archived-arrow" style="transition:transform .2s">▶</span>
          <span>已归档 (${archived.length})</span>
        </div>
        <div class="archived-list" style="display:none;max-height:300px;overflow-y:auto"></div>
      `;
      const header = section.querySelector('.archived-header');
      const list = section.querySelector('.archived-list');
      const arrow = section.querySelector('.archived-arrow');

      header.addEventListener('click', () => {
        const open = list.style.display === 'none';
        list.style.display = open ? 'block' : 'none';
        arrow.style.transform = open ? 'rotate(90deg)' : '';
      });

      for (const c of archived) {
        const d = document.createElement('div');
        d.className = 'chat-item archived';
        d.style.opacity = '0.6';
        const time = escapeHtml((c.updatedAt || '').slice(5, 16).replace('T', ' '));
        d.innerHTML = `<span class="ci-title" style="cursor:pointer"></span><span class="ci-time">${time}</span><span class="ci-restore" title="恢复" style="cursor:pointer;font-size:14px;margin-left:auto">♻️</span>`;
        d.querySelector('.ci-title').textContent = c.title;
        d.querySelector('.ci-restore').addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch('/api/chats/unarchive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId: c.id }) });
          loadChatList();
        });
        list.appendChild(d);
      }
      box.appendChild(section);
    }
  } catch (e) { /* 忽略归档加载错误 */ }
}

async function newChat() {
  if (App.streaming) return; // F-1 修复（2026-09-05 守卫）：流式生成期间禁止新建会话，防回复写错会话
  if (App.history.length) await saveChat();   // 旧对话自动归档
  App.pendingContext = '';   // 清空上一会话的附加资料
  await loadChatProfiles();
  const profileId = await showChatProfilePicker();
  if (!profileId) return;
  const profile = App.chatProfilesCache[profileId] || {};
  try {
    const { id } = await (await fetch('/api/chats', { method: 'POST' })).json();
    App.chatId = id;
    App.chatTitle = '';
    await fetch('/api/chat-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'apply', id: profileId, profile: { chatId: id } }) });
    App.currentChatProfileId = profileId;
    localStorage.setItem(CUR_CHAT_KEY, id);
    els.messages.innerHTML = '';
    App.history = [];
    for (const k in rerollVersions) delete rerollVersions[k];   // F-2 修复：新建会话清空版本缓存（防旧链残留跨会话注入）
    // 无内置世界书目录，firstMsg 模板加载不适用（已移除 /api/file 调用）
    renderAssistant('（新对话开始。在右侧「世界设定」里填写你的世界观/角色/规则（可选），然后直接开始对话。多角色场景按「角色名：台词」分段显示头像。）');
    loadChatList();
    loadChatProfileManage();   // 配置档按会话刷新（新会话标记跟随）
    loadTimeline();   // 剧情记忆按会话隔离，切会话后刷新
    refreshVecStaleBadge();   // 按会话检查向量索引是否过期
    loadBookmarksUI();   // 书签按会话加载（NEW-2）
    loadInventory();
    loadSessionNote();   // 会话常驻设定按会话加载（新会话为空）
    loadAgendaUI();      // 剧情备忘按会话加载（M8/M10）
    loadReportListUI();  // 报告列表按会话加载（M8/M10）
    loadAnnotationsUI(); // 旁注按会话加载（M8/M10）
    toggleSidebar(false);   // 移动端：新建会话后收起抽屉
  } catch (e) { /* 忽略 */ }
}

async function openChat(id) {
  if (App.streaming) return; // F-1 修复（2026-09-05 守卫）：流式生成期间禁止切换会话，防数据写错会话
  const mySeq = ++openChatSeq;
  if (App.history.length) await saveChat();
  App.pendingContext = '';   // 清空上一会话的附加资料
  loadAttachPending();       // 恢复本会话「已附加」状态（2026-08-30 修复重启丢失；本轮消费后清除）
  try {
    const c = await (await fetch('/api/chats/' + id)).json();
    // F-6 修复：回填最近 system prompt 供上下文指示器估算（失败静默，指示器仅少一项）
    fetch('/api/prompt/latest?chatId=' + encodeURIComponent(id)).then((r) => r.json()).then((pd) => { if (pd && pd.latest && pd.latest.system) { App.lastSystemPrompt = pd.latest.system; updateTokenEstimate(); } }).catch(() => {});
    if (c.error) return;
    App.chatId = c.id;
    App.chatTitle = c.title;
    // ⭐ 世界书按会话生效：切/开会话后必须重载，否则面板停留在上一会话的启用状态
    if (typeof loadWorldbooksUI === 'function') loadWorldbooksUI();
    App.currentChatProfileId = c.chatProfile || 'main';
    localStorage.setItem(CUR_CHAT_KEY, id);
    els.messages.innerHTML = '';
    App.history = Array.isArray(c.messages) ? c.messages : [];
    /* F-2 修复（2026-09-05）：切会话清空重 roll 版本缓存 + 从会话落盘恢复版本链。
       旧版既不清空也不恢复 → ①重载后任意一次保存把服务端已存版本链覆盖成 {}（全灭）；
       ②旧链残留致 B 会话按 seq 撞键显示 A 的假版本切换器、restoreVersion 跨会话注入。 */
    for (const k in rerollVersions) delete rerollVersions[k];
    if (c.versions && typeof c.versions === 'object') {
      for (const [anchorSeq, list] of Object.entries(c.versions)) {
        if (Array.isArray(list) && list.length) rerollVersions[anchorSeq] = list;
      }
    }
    // ⭐ 分段加载（2026-09-02 FN-1）：长对话全量渲染会卡，改为只渲染最近 RENDER_BATCH 条。
    for (const m of App.history) {   // 先统一补 seq（分段渲染也要保证 seq 完整）
      if (!m.seq) m.seq = ++App.msgSeq;
      else App.msgSeq = Math.max(App.msgSeq, m.seq);
    }
    /* 2026-09-09 方案 C 兼容：旧数据的链语义是「历史版（不含当前显示版）」，新语义为
       「全部版本（含当前）」。此处把每条回复的当前内容补入对应链（按内容去重），
       使新旧数据统一，位次反查才能正确。必须在 seq 回填之后执行（锚点查找依赖 seq）。 */
    for (let mi = 0; mi < App.history.length; mi++) {
      const m = App.history[mi];
      if (m.role !== 'assistant' || m.seq == null) continue;
      let aSeq = null;
      for (let i = mi - 1; i >= 0; i--) { if (App.history[i].role === 'user') { aSeq = App.history[i].seq; break; } }
      if (aSeq != null && rerollVersions[aSeq]) pushVersionToChain(aSeq, m.content);
    }
    App.renderCursor = App.history.length;
    App.renderHidden = new Set();
    App.renderSummaryText = '';
    renderHistorySlice(RENDER_BATCH);
    loadChatList();
    loadChatProfileManage();   // 配置档按会话刷新（切换对话后「← 当前会话」标记跟随）
    loadTimeline();   // 剧情记忆按会话隔离，切会话后刷新
    refreshVecStaleBadge();   // 按会话检查向量索引是否过期
    loadBookmarksUI();   // 书签按会话加载（NEW-2）
    loadInventory();
    loadCurrentWardrobe();
    loadSessionNote();   // 会话常驻设定按会话加载
    loadInjections();    // 自定义注入槽按会话刷新（API 弹窗开着时同步显示当前会话值）
    loadStats();   // 统计栏按对话口径刷新（缓存命中）
    loadAgendaUI();      // 剧情备忘按会话加载（M8/M10）
    loadReportListUI();  // 报告列表按会话加载（M8/M10）
    loadAnnotationsUI(); // 旁注按会话加载（M8/M10）
    toggleSidebar(false);   // 移动端：切换会话后收起抽屉
  } catch (e) { /* 忽略 */ }
}
