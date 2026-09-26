// app/06-timeline.js —— 剧情记忆 / 时间线 / 物品栏 / 换装 / 书签
// F 批自 app.js 整体搬迁，零逻辑改动（括号配对切块）。
// 注：本文件只放函数定义；顶层事件绑定留在 app.js，待 F-09 集中到 10-bind.js。
'use strict';

async function loadEmotions() {
  const box = document.getElementById('em-list');
  const nameInput = document.getElementById('em-name');
  try {
    const { emotions } = await (await fetch(`/api/emotions?chatId=${encodeURIComponent(App.chatId || '')}`)).json();
    const names = Object.keys(emotions || {});
    box.innerHTML = '';
    if (!names.length) {
      box.innerHTML = '（暂无情绪记录）';
      return;
    }
    for (const n of names) {
      const d = document.createElement('div');
      d.className = 'em-item';
      d.innerHTML = `<span class="em-name">${escapeHtml(n)}</span><span class="em-text">${escapeHtml(emotions[n])}</span>`;
      box.appendChild(d);
    }
    if (nameInput) nameInput.value = names[0] || '';
  } catch (e) { box.textContent = '情绪读取失败：' + e.message; }
}

async function loadTimeline() {
  try {
    const { turns } = await (await fetch(`/api/timeline?limit=15&chatId=${encodeURIComponent(App.chatId || '')}`)).json();
    tmTimeline.innerHTML = turns.length ? '' : '（暂无回合记录）';
    for (const t of turns) {
      const d = document.createElement('div');
      d.className = 'tm-item';
      const ev = (t.event || '').slice(0, 60);
      const loc = t.location ? `<span class="loc">${escapeHtml(t.location)}</span>` : '';
      // 2026-09-03 MINOR-8：items_gain 可能未返回/为空数组，.length 直接抛 TypeError → 先判空
      const gain = Array.isArray(t.items_gain) && t.items_gain.length ? `<span class="gain"> ＋${t.items_gain.map((g) => escapeHtml(g.name)).join('、')}</span>` : '';
      const loss = t.items_loss.length ? `<span class="loss"> －${t.items_loss.map(escapeHtml).join('、')}</span>` : '';
      const emo = t.emotion && Object.keys(t.emotion).length ? `<span class="emotag"> 💗${Object.entries(t.emotion).map(([n, v]) => `${escapeHtml(n)}=${escapeHtml(v)}`).join('、')}</span>` : '';
      d.innerHTML = `<div class="t">${escapeHtml(t.story_time || '?')}｜${escapeHtml(ev || '（无事件摘要）')}</div>${loc}${gain}${loss}${emo}`;
      if (t.id) {
        const act = document.createElement('div');
        act.className = 'tm-actions';
        const edit = document.createElement('button');
        edit.className = 'ma-btn';
        edit.textContent = '✏️ 改';
        edit.title = '修改该条时间线记录';
        edit.addEventListener('click', () => openTmItemEdit(d, t, 'edit'));
        const ins = document.createElement('button');
        ins.className = 'ma-btn';
        ins.textContent = '＋ 插';
        ins.title = '在该条之后补充一条时间线记录';
        ins.addEventListener('click', () => openTmItemEdit(d, t, 'insert'));
        const del = document.createElement('button');
        del.className = 'ma-btn del';
        del.textContent = '✕ 删';
        del.title = '删除该条回合记录';
        del.addEventListener('click', async () => {
          if (!confirm('删除该条回合记录？')) return;
          try {
            await fetch('/api/timeline/delete', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chatId: App.chatId, id: t.id }),
            });
            loadTimeline();
            loadInventory();
          } catch (e) { /* 忽略 */ }
        });
        act.append(edit, ins, del);
        d.appendChild(act);
      }
      tmTimeline.appendChild(d);
    }
  } catch (e) { tmTimeline.textContent = '时间线读取失败'; }
}

function openTmItemEdit(itemEl, t, mode) {
  if (App.tmItemEditBox && App.tmItemEditBox.parentNode) App.tmItemEditBox.remove();
  const label = mode === 'edit' ? '✏️ 修改时间线记录' : '＋ 在该条之后补充时间线记录';
  const box = document.createElement('div');
  box.className = 'tm-edit tm-item-edit';
  box.innerHTML = `
    <div class="tm-edit-title">${label}</div>
    <div class="em-row"><input data-f="story_time" type="text" placeholder="时间（如：8/9 早上）"><input data-f="location" type="text" placeholder="地点（可留空）"></div>
    <div class="em-row"><input data-f="characters" type="text" placeholder="在场角色（顿号分隔，可留空）"><input data-f="costume" type="text" placeholder="着装变化（可留空）"></div>
    <div class="em-row"><input data-f="atmosphere" type="text" placeholder="氛围（可留空）"><input data-f="event" type="text" placeholder="事件一句话（可留空）"></div>
    <div class="em-row"><button class="tm-ai-btn ma-btn">✨ AI 补全</button><button class="head-btn">✅ 保存</button><button class="tm-cancel-btn ma-btn">取消</button><span class="tm-item-note"></span></div>`;
  if (mode === 'edit') {
    box.querySelector('[data-f="story_time"]').value = t.story_time || '';
    box.querySelector('[data-f="location"]').value = t.location || '';
    box.querySelector('[data-f="characters"]').value = (t.characters || []).join('、');
    box.querySelector('[data-f="costume"]').value = t.costume || '';
    box.querySelector('[data-f="atmosphere"]').value = t.atmosphere || '';
    box.querySelector('[data-f="event"]').value = t.event || '';
  }
  const note = box.querySelector('.tm-item-note');
  const collect = () => ({
    chatId: App.chatId,
    story_time: box.querySelector('[data-f="story_time"]').value.trim(),
    location: box.querySelector('[data-f="location"]').value.trim(),
    characters: box.querySelector('[data-f="characters"]').value.trim(),
    costume: box.querySelector('[data-f="costume"]').value.trim(),
    atmosphere: box.querySelector('[data-f="atmosphere"]').value.trim(),
    event: box.querySelector('[data-f="event"]').value.trim(),
  });
  box.querySelector('.head-btn').addEventListener('click', async () => {
    const p = collect();
    if (!p.story_time && !p.event) { note.textContent = '至少填时间或事件'; return; }
    try {
      const body = mode === 'edit' ? { ...p, id: t.id } : { ...p, afterId: t.id };
      const r = await (await fetch(mode === 'edit' ? '/api/timeline/update' : '/api/timeline/insert', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })).json();
      note.textContent = r.ok ? (mode === 'edit' ? '✓ 已保存，刷新中…' : '✓ 已补充，刷新中…') : `✗ ${r.error || '失败'}`;
      if (r.ok) setTimeout(() => loadTimeline(), 400);
    } catch (e) { note.textContent = '✗ ' + e.message; }
  });
  box.querySelector('.tm-ai-btn').addEventListener('click', () => {
    const hint = [...box.querySelectorAll('input[data-f]')].map((i) => i.value.trim()).filter(Boolean).join('；');
    aiFillTimeline(box, box.querySelector('.tm-item-note'), hint);
  });
  box.querySelector('.tm-cancel-btn').addEventListener('click', () => box.remove());
  itemEl.insertAdjacentElement('afterend', box);
  App.tmItemEditBox = box;
  box.querySelector('input').focus();
}

async function aiFillTimeline(box, note, hint) {
  if (!note) return;
  note.textContent = '✨ AI 整理中…';
  try {
    const r = await (await fetch('/api/timeline/ai-fill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: App.chatId, hint: String(hint || '') }),
    })).json();
    if (!r.ok) { note.textContent = '✗ ' + (r.error || 'AI 补全失败，请手动填写'); return; }
    const f = r.fields || {};
    const set = (k, v) => { const el = box?.querySelector(`[data-f="${k}"]`); if (el) el.value = v || ''; };
    set('story_time', f.story_time);
    set('location', f.location);
    set('characters', (f.characters || []).join('、'));
    set('costume', f.costume);
    set('atmosphere', f.atmosphere);
    set('event', f.event);
    // 自动写入 turns
    const hasData = f.story_time || f.event || f.costume || (f.items_gain||[]).length || Object.keys(f.emotion||{}).length || f.location_detail;
    if (hasData) {
      try {
        await fetch('/api/timeline/manual', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: App.chatId, ...f, characters: Array.isArray(f.characters) ? f.characters.join('、') : f.characters }),
        });
        loadTimeline(); loadInventory(); loadCurrentWardrobe(); loadEmotions(); loadLocationsUI();
      } catch (e) { /* 写入失败不阻塞 */ }
    }
    const parts = [];
    if (f.story_time || f.event) parts.push('时间线');
    if (f.costume) parts.push('换装');
    if ((f.items_gain||[]).length || (f.items_loss||[]).length) parts.push(`物品${(f.items_gain||[]).length + (f.items_loss||[]).length}条`);
    if (Object.keys(f.emotion||{}).length) parts.push(`情绪${Object.keys(f.emotion).length}条`);
    if (f.location_detail) parts.push('地点');
    note.textContent = parts.length ? `✨ 已补全并写入：${parts.join('、')}` : '✨ AI 未提取到有效数据，请手动填写';
  } catch (e) { note.textContent = '✗ ' + e.message; }
}

async function loadInventory() {
  try {
    const { inventory, recent } = await (await fetch(`/api/inventory?chatId=${encodeURIComponent(App.chatId || '')}`)).json();
    tmInventory.innerHTML = '';
    if (inventory.length) {
      const head = document.createElement('div');
      head.innerHTML = '<b>当前物品栏：</b>';
      tmInventory.appendChild(head);
      const list = document.createElement('div');
      list.innerHTML = inventory.map((i) => `<span class="chip">${escapeHtml(i.name)}${i.count > 1 ? ` ×${i.count}` : ''}${i.holder ? `（${escapeHtml(i.holder)}）` : ''}</span>`).join(' ');
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

function setTmTabVis(active) {
  const map = { tl: [tmTimeline, tmEditTl], inv: [tmInventory, tmEditInv], wd: [tmWardrobe], em: [tmEmotions], auto: [tmAuto], loc: [tmLocations], vec: [document.getElementById('tm-vec')] };
  for (const [k, els] of Object.entries(map)) {
    els.forEach(el => { if (el) el.classList.toggle('hidden', k !== active); });
  }
}

async function loadCurrentWardrobe() {
  const box = document.getElementById('wd-current');
  if (!box) return;
  try {
    const { wardrobes } = await (await fetch(`/api/wardrobe/current?chatId=${encodeURIComponent(App.chatId || '')}`)).json();
    const names = Object.keys(wardrobes || {});
    box.innerHTML = names.length
      ? '当前着装：' + names.map((n) => `<span class="chip">${escapeHtml(n)}：${escapeHtml(wardrobes[n])}</span>`).join(' ')
      : '当前着装：未记录（换装后自动更新）';
  } catch (e) { box.textContent = '当前着装：读取失败'; }
}

async function forkFromSeq(seq) {
  if (App.streaming) { toast('生成中，请稍后再分叉'); return; }
  if (!App.chatId) { toast('请先打开对话'); return; }
  const idx = App.history.findIndex(m => m.seq === seq);
  if (idx < 0) { toast('未找到该消息'); return; }
  const keep = App.history.slice(0, idx + 1);
  const ok = await confirmDialog(
    `⤵ 从这里分叉出新会话？

新会话将包含前 ${keep.length} 条消息（到 seq ${seq} 为止）。
` +
    `当前会话保持不变，你可以在两条线上分别继续。`,
    { okText: '创建分支' }
  );
  if (!ok) return;
  try {
    await saveChat();
    const { id } = await (await fetch('/api/chats', { method: 'POST' })).json();
    if (!id) { toast('创建分支会话失败', 'err'); return; }
    const baseTitle = App.chatTitle || (keep.find(m => m.role === 'user')?.content || '新对话').slice(0, 16);
    const forkTitle = `${baseTitle} · 分支@${seq}`;
    const forkVersions = {};
    for (const [anchor, list] of Object.entries(rerollVersions)) {
      if (Number(anchor) <= Number(seq)) forkVersions[anchor] = list;
    }
    const r = await fetch('/api/chats/' + id, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: forkTitle, messages: keep, versions: forkVersions }),
    });
    if (!r.ok) { toast('写入分支内容失败', 'err'); return; }
    if (App.currentChatProfileId) {
      try {
        await fetch('/api/chat-profiles', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'apply', id: App.currentChatProfileId, profile: { chatId: id } }),
        });
      } catch (e) { /* 不阻断 */ }
    }
    // ⭐ 同步常驻设定四槽（分支应继承分叉点前的设定；2026-09-18）
    try {
      const oldNote = await (await fetch('/api/op/note', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId: App.chatId, get: true }),
      })).json();
      if (oldNote && oldNote.slots && Object.keys(oldNote.slots).length) {
        await fetch('/api/op/note', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chatId: id, slots: oldNote.slots }),
        });
      }
    } catch (e) { /* 常驻设定同步失败不阻断分叉 */ }
    // ⭐ 同步剧情记忆 turns（分叉点之前的回合记录；时间线/物品栏/情绪都由它派生）
    try {
      await fetch('/api/fork/turns', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromChatId: App.chatId, toChatId: id, upToSeq: seq }),
      });
    } catch (e) { /* 剧情记忆同步失败不阻断分叉 */ }
    toast(`✅ 已创建分支（${keep.length} 条）：${forkTitle}`);
    await loadChatList();
    const goNow = await confirmDialog('分支已创建。现在切换过去吗？', { okText: '切换到分支', cancelText: '留在当前' });
    if (goNow) await openChat(id);
  } catch (e) {
    toast('分叉失败：' + e.message, 'err');
  }
}

function syncBookmarkButtons() {
  const set = new Set((App.bookmarksCache || []).map(b => Number(b.seq)));
  for (const btn of document.querySelectorAll('.bm-btn')) {
    btn.classList.toggle('on', set.has(Number(btn.dataset.seq)));
  }
}
