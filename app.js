// app.js —— 仅保留三个非绑定函数（其余已按域抽到 app/ 各模块）
// F-09 后本文件只剩这些；index.html 里它排在 10-bind.js 之前。
'use strict';

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
