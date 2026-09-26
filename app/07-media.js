// app/07-media.js —— 语音 / 插图 / 头像 / 场景档案
// F 批自 app.js 整体搬迁，零逻辑改动（括号配对切块）。
// 注：本文件只放函数定义；顶层事件绑定留在 app.js，待 F-09 集中到 10-bind.js。
'use strict';

function openIllustration(prefillText) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px;max-height:80vh;overflow-y:auto">
    <div style="font-size:15px;font-weight:500;margin-bottom:12px">🎨 场景插图</div>
    <label style="font-size:12px;color:var(--muted,#888)">场景描述（已自动提取最近对话，可修改）</label>
    <textarea id="ill-prompt" rows="3" style="width:100%;padding:8px;margin:4px 0 8px;border-radius:6px;background:var(--bg2);color:var(--text);border:1px solid var(--border);resize:vertical" placeholder="描述你想生成的场景…"></textarea>
    <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap">
      <button id="ill-auto" class="btn-sm" style="padding:4px 10px;margin-bottom:8px;font-size:12px">🔍 从对话提取</button>
      <button id="ill-enhance" class="btn-sm" style="padding:4px 10px;margin-bottom:8px;font-size:12px">✨ 提示词优化</button>
    </div>
    <label style="font-size:12px;color:var(--muted,#888)">风格</label>
    <select id="ill-style" style="width:100%;padding:6px;margin:4px 0 8px;border-radius:6px;background:var(--bg2);color:var(--text);border:1px solid var(--border)">
      <option value="">（跟随模型默认）</option>
      <option value="anime">动漫风格</option>
      <option value="realistic">写实风格</option>
      <option value="watercolor">水彩风格</option>
      <option value="sketch">素描风格</option>
    </select>
    <label style="font-size:12px;color:var(--muted,#888)">引擎</label>
    <select id="ill-engine" style="width:100%;padding:6px;margin:4px 0 8px;border-radius:6px;background:var(--bg2);color:var(--text);border:1px solid var(--border)">
      <option value="kolors">Kolors（免费）</option>
      <option value="zimage">Z-Image（¥0.30/张）</option>
      <option value="zturb">Z-Image-Turbo（¥0.10/张）</option>
      <option value="qwenimg">Qwen-Image（¥0.30/张）</option>
      <option value="ernie">ERNIE-Image（¥0.11/张）</option>
    </select>
    <label style="display:flex;align-items:center;gap:6px;margin:8px 0;font-size:12px;cursor:pointer;color:var(--muted,#888)">
      <input type="checkbox" id="ill-scenery-only" style="accent-color:var(--accent)">
      🎭 纯场景（无人物）— 过滤人物，只出环境/背景
    </label>
    <div id="ill-result" style="margin-top:12px;text-align:center"></div>
    <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button id="ill-generate" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border-radius:6px;border:none;cursor:pointer">生成</button>
      <button id="ill-config" class="btn-sm" style="padding:6px 16px">⚙️ 配置</button>
      <button id="ill-close" class="btn-sm" style="padding:6px 16px">关闭</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#ill-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  // 自动提取最近一条 AI 回复（非空文本）作为场景描述
  // 注意：消息文本在 .msg-wrap 内 .bubble；assistant wrap 无 .msg.user；.msg-text 实际不存在（勿用）
  const autoFillIll = () => {
    const promptBox = overlay.querySelector('#ill-prompt');
    if (!promptBox) { return; }
    if (prefillText) { promptBox.value = String(prefillText).slice(0, 300); return; }
    const wraps = Array.from(document.querySelectorAll('.msg-wrap'));
    const assistantWraps = wraps.filter(w => !w.querySelector('.msg.user'));
    for (let i = assistantWraps.length - 1; i >= 0; i--) {
      const t = (assistantWraps[i].querySelector('.bubble')?.textContent || '').trim();
      if (t) { promptBox.value = t.slice(0, 300); return; }
    }
    const anyBubble = [...document.querySelectorAll('.bubble')].reverse().map(b => (b.textContent||'').trim()).find(Boolean);
    if (anyBubble) promptBox.value = anyBubble.slice(0, 300);
  };
  autoFillIll();
  overlay.querySelector('#ill-auto').onclick = autoFillIll;
  // 提示词优化：把描述润色成英文生图提示词并回填
  overlay.querySelector('#ill-enhance').onclick = async () => {
    const promptBox = overlay.querySelector('#ill-prompt');
    const raw = promptBox.value.trim();
    if (!raw) { toast('请先输入或提取场景描述，再优化提示词'); return; }
    const style = overlay.querySelector('#ill-style').value;
    const btn = overlay.querySelector('#ill-enhance');
    const resBox = overlay.querySelector('#ill-result');
    const oldText = btn.textContent;
    btn.textContent = '优化中…';
    btn.disabled = true;
    try {
      const r = await fetch('/api/illustration/enhance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: raw, style }) });
      const d = await r.json();
      if (d.error) { resBox.innerHTML = `<div style="color:var(--danger);padding:12px">${safeHtml(d.error)}</div>`; return; }
      promptBox.value = d.enhanced;
      resBox.innerHTML = `<div style="color:var(--success);padding:12px;font-size:12px">✨ 已优化（${d.enhanced.length} 字符），可直接生成或继续修改</div>`;
    } catch (e) { resBox.innerHTML = `<div style="color:var(--danger);padding:12px">优化失败：${safeHtml(e.message)}</div>`; }
    finally { btn.textContent = oldText; btn.disabled = false; }
  };
  // 风格 → 英文提示词片段（该端点对英文提示更稳）
  const styleToEn = (s) => {
    const map = { anime: ', anime style, cel shading, vibrant colors', realistic: ', photorealistic, cinematic lighting, high detail', watercolor: ', watercolor painting style, soft colors', sketch: ', pencil sketch, monochrome, line art' };
    return map[s] || '';
  };
  overlay.querySelector('#ill-generate').onclick = async () => {
    const prompt = overlay.querySelector('#ill-prompt').value.trim();
    if (!prompt) { toast('请输入场景描述'); return; }
    const style = overlay.querySelector('#ill-style').value;
    const engine = overlay.querySelector('#ill-engine').value;
    const sceneryOnly = overlay.querySelector('#ill-scenery-only')?.checked || false;
    const resBox = overlay.querySelector('#ill-result');
    resBox.textContent = '生成中，约 5-15 秒…';
    try {
      const fullPrompt = prompt + styleToEn(style);
      const r = await fetch('/api/illustration/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: fullPrompt, style, engine, chatId: App.chatId, sceneryOnly }) });
      const d = await r.json();
      if (d.error) {
        resBox.innerHTML = `<div style="color:var(--danger);padding:12px">${safeHtml(d.error)}</div>`;
        if (d.needConfig) resBox.innerHTML += '<div style="font-size:12px;color:var(--muted,#888);margin-top:8px">点击「配置」按钮设置图片生成 API Key</div>';
        return;
      }
      if (d.image) {
        const isData = /^data:/.test(d.image);
        const src = isData ? d.image : (d.image.url || d.image);
        resBox.innerHTML = `<img src="${escapeHtml(src)}" style="max-width:100%;max-height:360px;border-radius:8px;display:block;margin:0 auto;image-rendering:auto" alt="场景插图"/>` +
          `<div style="color:var(--success);padding:12px;font-size:12px">✅ 已生成（${safeHtml(d.label || d.model || '')}${d.price ? ' · ' + safeHtml(d.price) : ''}）</div>`;
      } else {
        resBox.innerHTML = `<div style="color:var(--success);padding:12px">${safeHtml(d.message || '功能就绪')}</div>`;
      }
    } catch (e) { resBox.textContent = '请求失败：' + e.message; }
  };
  overlay.querySelector('#ill-config').onclick = async () => {
    const baseURL = prompt('生图端点 Base URL（你自己的 OpenAI 兼容服务，例：https://<你的服务>/v1）：', '');
    if (!baseURL) return;
    const apiKey = prompt('API Key（该端点的 Key，必填）：');
    if (!apiKey) return;
    const model = prompt('模型 id（必填。示例：Kwai-Kolors/Kolors、Tongyi-MAI/Z-Image、Qwen/Qwen-Image）：', '');
    if (!model) return;
    const chatModel = prompt('提示词优化用的对话模型 id（可留空＝用上面的模型）：', '');
    try {
      await fetch('/api/illustration/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseURL, apiKey, model, chatModel }) });
      toast('✅ 配置已保存');
    } catch (e) { toast('保存失败：' + e.message); }
  };
}

function openTts(text) {
  text = String(text || '').trim().slice(0, 2000);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:460px">
    <div style="font-size:15px;font-weight:500;margin-bottom:12px">🔊 语音朗读</div>
    <div style="font-size:12px;color:var(--muted,#888);margin-bottom:8px">将朗读以下文本（${text.length} 字）</div>
    <div style="font-size:13px;max-height:120px;overflow-y:auto;padding:8px;background:var(--bg2);border-radius:6px;margin-bottom:10px;white-space:pre-wrap;word-break:break-word">${safeHtml(text.slice(0, 300))}${text.length > 300 ? '…' : ''}</div>
    <label class="api-field">模型<select id="tts-model" style="width:100%">
      <option value="mimo-v2.5-tts">内置音色（7 种预设）</option>
      <option value="mimo-v2.5-tts-voicedesign">声线设计（文字描述生成声音）</option>
      <option value="mimo-v2.5-tts-voiceclone">声音克隆（参考音频复刻）</option>
    </select></label>
    <div id="tts-character-wrap" class="api-field">角色音色<select id="tts-character" style="width:100%">
      <option value="">（不绑定角色）</option>
    </select><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">选项来自 data/character-voices.json 的「角色音色映射」；为空说明尚未配置角色音色</div></div>
    <div id="tts-voice-wrap" class="api-field">音色<select id="tts-voice" style="width:100%">
      <option value="mimo_default">mimo_default（默认）</option>
      <option value="default_zh">default_zh</option>
      <option value="default_en">default_en</option>
      <option value="Mia">Mia</option>
      <option value="Chloe">Chloe</option>
      <option value="Milo">Milo</option>
      <option value="Dean">Dean</option>
    </select></div>
    <div id="tts-style-wrap" class="hidden api-field">声音描述 / 风格指令<textarea id="tts-style" class="world-setting" rows="3" style="width:100%" placeholder="例：一位中年男性，低沉有磁性，像纪录片旁白解说员…"></textarea></div>
    <div id="tts-ref-wrap" class="hidden api-field">参考音频（mp3/wav，10-30 秒清晰人声）<input id="tts-ref" type="file" accept="audio/*,.mp3,.wav" style="width:100%"><div style="font-size:11px;color:var(--muted,#888);margin-top:2px">上传后即作为克隆音色，可另填风格指令控制语气</div></div>
    <div id="tts-result" style="margin-top:8px;text-align:center"></div>
    <div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px">
      <button id="tts-play" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border-radius:6px;border:none;cursor:pointer">▶ 朗读</button>
      <button id="tts-config" class="btn-sm" style="padding:6px 16px">⚙️ 配置</button>
      <button id="tts-close" class="btn-sm" style="padding:6px 16px">关闭</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  // 2026-09-03：角色音色下拉改为动态填充（来自 data/character-voices.json 的映射键），
  // 不再硬编码角色名。拉取失败/无配置 → 只剩「（不绑定角色）」。
  (async () => {
    try {
      const r = await fetch('/api/tts/config');
      const d = await r.json();
      const sel = overlay.querySelector('#tts-character');
      if (!sel || !d || !Array.isArray(d.characters)) return;
      for (const name of d.characters) {
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;      // textContent 天然防 XSS
        sel.appendChild(o);
      }
    } catch (e) { /* 无配置则只保留「不绑定」 */ }
  })();
  // 模型切换 → 显示对应输入区
  const ttsModelSel = overlay.querySelector('#tts-model');
  const voiceWrap = overlay.querySelector('#tts-voice-wrap');
  const styleWrap = overlay.querySelector('#tts-style-wrap');
  const refWrap = overlay.querySelector('#tts-ref-wrap');
  ttsModelSel.addEventListener('change', () => {
    const v = ttsModelSel.value;
    voiceWrap.classList.toggle('hidden', v !== 'mimo-v2.5-tts');
    styleWrap.classList.toggle('hidden', v === 'mimo-v2.5-tts');
    refWrap.classList.toggle('hidden', v !== 'mimo-v2.5-tts-voiceclone');
  });
  overlay.querySelector('#tts-close').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#tts-play').onclick = async () => {
    const resBox = overlay.querySelector('#tts-result');
    const model = ttsModelSel.value;
    const style = overlay.querySelector('#tts-style').value.trim();
    const voice = overlay.querySelector('#tts-voice').value;
    const character = overlay.querySelector('#tts-character').value;
    let referenceAudio = null;
    
    // 如果选择了角色且没有手动上传参考音频，服务端会自动使用角色绑定的参考音频
    if (model === 'mimo-v2.5-tts-voiceclone' && !character) {
      const file = overlay.querySelector('#tts-ref').files[0];
      if (!file) { resBox.innerHTML = '<div style="color:var(--danger);padding:8px">请先选择参考音频（mp3/wav）或选择角色</div>'; return; }
      if (file.size > 10 * 1024 * 1024) { resBox.innerHTML = '<div style="color:var(--danger);padding:8px">参考音频需小于 10MB</div>'; return; }
      const mime = file.type === 'audio/wav' || /\.wav$/i.test(file.name) ? 'audio/wav' : 'audio/mpeg';
      referenceAudio = { mime, data: await new Promise((ok, fail) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result).split(',')[1] || ''); rd.onerror = fail; rd.readAsDataURL(file); }) };
    }
    resBox.textContent = '合成中…';
    try {
      const r = await fetch('/api/tts/synthesize', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, model, voice, style, referenceAudio, character }) });
      const d = await r.json();
      if (d.error) {
        resBox.innerHTML = `<div style="color:var(--danger);padding:8px">${safeHtml(d.error)}</div>`;
        if (d.needConfig) resBox.innerHTML += '<div style="font-size:12px;color:var(--muted,#888);margin-top:4px">点击「配置」按钮设置 TTS 引擎</div>';
        return;
      }
      if (d.audio) {
        // TTS 返回 base64 音频 → 直接播放
        const a = new Audio('data:audio/' + (d.format || 'mp3') + ';base64,' + d.audio);
        a.play().catch(() => {});
        resBox.innerHTML = `<div style="color:var(--success);padding:8px">▶ ${safeHtml(d.message || '合成成功')}</div>`;
        return;
      }
      resBox.innerHTML = `<div style="color:var(--success);padding:8px">${safeHtml(d.message || '朗读功能就绪')}</div>`;
    } catch (e) { resBox.textContent = '请求失败：' + e.message; }
  };
  overlay.querySelector('#tts-config').onclick = async () => {
    const baseURL = prompt('TTS 端点 Base URL（你自己的 OpenAI 兼容服务，例：https://<你的服务>/v1）：', '');
    if (!baseURL) return;
    const apiKey = prompt('API Key（该端点的 Key，必填）：');
    if (!apiKey) return;
    const model = prompt('模型 id（必填，例：mimo-v2.5-tts / -voicedesign / -voiceclone，或你服务商提供的语音模型）：', 'mimo-v2.5-tts');
    const voice = prompt('音色 id（由你的服务商定义，例：mimo_default / Mia）：', 'mimo_default');
    const rate = prompt('语速（0.5-2.0）：', '1.0');
    try {
      await fetch('/api/tts/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseURL, apiKey, model, voice, rate }) });
      toast('✅ TTS 配置已保存');
    } catch (e) { toast('保存失败：' + e.message); }
  };
}

function openAvatarWin(name) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'align-items:center;justify-content:center;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.55);display:flex;padding:24px';
  const box = document.createElement('div');
  box.style.cssText = 'width:340px;max-width:95vw;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;color:var(--text)';
  box.innerHTML = '<div style="font-size:14px;font-weight:600;margin-bottom:8px">🖼 ' + escapeHtml(name || '角色') + ' 的头像</div>' +
    '<div style="font-size:11px;color:var(--muted)">头像保存在本地/ 上传后气泡与档案处显示为圆形小图（PNG/JPG/WebP/GIF，≤5MB）</div>' +
    '<div style="margin:10px 0;text-align:center"><img id="av-preview" style="width:64px;height:64px;border-radius:50%;object-fit:cover;display:none"></div>' +
    '<input type="file" accept="image/*" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--text)">' +
    '<div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end">' +
    '<button id="av-del" style="padding:6px 14px;font-size:12px;background:transparent;border:1px solid var(--border);color:var(--danger,#e66);border-radius:6px;cursor:pointer">删除</button>' +
    '<button id="av-gen" style="padding:6px 14px;font-size:12px;background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer">🎨 生成头像</button>' +
    '<button id="av-cancel" style="padding:6px 14px;font-size:12px;background:transparent;border:1px solid var(--border);color:var(--text);border-radius:6px;cursor:pointer">取消</button>' +
    '<button id="av-save" style="padding:6px 14px;font-size:12px;background:var(--accent);color:var(--bg);border:none;border-radius:6px;cursor:pointer">上传</button>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.appendChild(box);
  const close = () => overlay.remove();
  const fileInp = box.querySelector('input[type=file]');
  const prev = box.querySelector('#av-preview');
  fileInp.addEventListener('change', () => {
    const f = fileInp.files && fileInp.files[0];
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { toast('图片过大（>5MB）'); return; }
    const rd = new FileReader();
    rd.onload = () => { prev.src = rd.result; prev.style.display = 'inline-block'; };
    rd.readAsDataURL(f);
  });
  box.querySelector('#av-save').addEventListener('click', () => {
    const f = fileInp.files && fileInp.files[0];
    if (!f) { toast('先选择一张图片'); return; }
    const rd = new FileReader();
    rd.onload = () => {
      fetch('/api/avatar/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name, imageData: rd.result }) })
        .then((r) => r.json()).then((d) => { if (d.ok) { toast('头像已更新'); close(); loadAvatarCache(); } else toast(d.error || '上传失败'); })
        .catch(() => toast('上传失败'));
    };
    rd.readAsDataURL(f);
  });
  box.querySelector('#av-gen').addEventListener('click', () => {
    const f = fileInp.files && fileInp.files[0];
    if (!f) { toast('先选一张参考图，再据它生成头像'); return; }
    const genBtn = box.querySelector('#av-gen');
    genBtn.disabled = true; genBtn.textContent = '生成中…';
    const rd = new FileReader();
    rd.onload = () => {
      fetch('/api/avatar/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name, imageData: rd.result }) })
        .then((r) => r.json()).then((d) => {
          if (d.ok) { toast('头像已生成'); close(); loadAvatarCache(); }
          else toast(d.error || '生成失败');
        })
        .catch(() => toast('生成失败'))
        .finally(() => { genBtn.disabled = false; genBtn.textContent = '🎨 生成头像'; });
    };
    rd.onerror = () => { toast('读取图片失败'); genBtn.disabled = false; genBtn.textContent = '🎨 生成头像'; };
    rd.readAsDataURL(f);
  });
  box.querySelector('#av-del').addEventListener('click', () => {
    fetch('/api/avatar/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) })
      .then(() => { toast('头像已删除'); close(); loadAvatarCache(); })
      .catch(() => toast('删除失败'));
  });
  box.querySelector('#av-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}

async function editNpcProfile(name) {
  let profile = { name, aliases: [], appearance: '', personality: '', age: '', ageNote: '', relationships: {}, firstAppearance: '', notes: '' };
  if (name) { try { const r = await fetch('/api/npc-profiles/'+encodeURIComponent(name)); const d = await r.json(); if (d.profile) profile = d.profile; } catch (e) { /* 新建 */ } }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px;max-height:85vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${name?'编辑':'新建'}角色档案</div><label class="api-field">名称<input id="np-name" type="text" value="${escapeHtml(profile.name)}" style="width:100%"></label><label class="api-field">别名（逗号分隔）<input id="np-aliases" type="text" value="${escapeHtml((profile.aliases || []).join('，'))}" style="width:100%"></label><label class="api-field">外观<textarea id="np-appearance" class="world-setting" rows="2" style="width:100%">${escapeHtml(profile.appearance||'')}</textarea></label><label class="api-field">性格<textarea id="np-personality" class="world-setting" rows="2" style="width:100%">${escapeHtml(profile.personality||'')}</textarea></label><label class="api-field">年龄<input id="np-age" type="text" value="${profile.age == null ? '' : escapeHtml(String(profile.age))}" style="width:100%"></label><label class="api-field">年龄备注<input id="np-age-note" type="text" value="${escapeHtml(profile.ageNote||'')}" style="width:100%"></label><label class="api-field">关系（JSON）<textarea id="np-rel" class="world-setting" rows="2" style="width:100%">${escapeHtml(JSON.stringify(profile.relationships||{},null,2))}</textarea></label><label class="api-field">首次出场<input id="np-first" type="text" value="${escapeHtml(profile.firstAppearance||'')}" placeholder="如：第三章·初次登场" style="width:100%"></label><label class="api-field">备注<textarea id="np-notes" class="world-setting" rows="2" style="width:100%">${escapeHtml(profile.notes||'')}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="np-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="np-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#np-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#np-save').onclick = async () => {
    let rels = {}; try { rels = JSON.parse(overlay.querySelector('#np-rel').value||'{}'); } catch(e) {}
    const aliases = overlay.querySelector('#np-aliases').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const ageRaw = overlay.querySelector('#np-age').value.trim();
    await fetch('/api/npc-profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: overlay.querySelector('#np-name').value.trim().slice(0,40), aliases, appearance: overlay.querySelector('#np-appearance').value, personality: overlay.querySelector('#np-personality').value, age: ageRaw === '' ? null : (Number.isFinite(Number(ageRaw)) ? Number(ageRaw) : ageRaw), ageNote: overlay.querySelector('#np-age-note').value, relationships: rels, firstAppearance: overlay.querySelector('#np-first').value.trim(), notes: overlay.querySelector('#np-notes').value }) });
    overlay.remove(); loadNpcProfiles();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

function exportNpcCard(name) {
  const a = document.createElement('a');
  a.href = `/api/cards/export/${encodeURIComponent(name)}`;
  a.download = `${name}.png`;
  a.click();
}

async function editSceneProfile(name) {
  let scene = { name, location: '', physicalFeatures: [], atmosphere: '', notes: '' };
  if (name) { try { const r = await fetch('/api/scenes/'+encodeURIComponent(name)); const d = await r.json(); if (d.scene) scene = d.scene; } catch (e) { /* 新建 */ } }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:500px;max-height:85vh;overflow-y:auto"><div style="font-size:15px;font-weight:500;margin-bottom:12px">${name?'编辑':'新建'}场景档案</div><label class="api-field">名称<input id="sp-name" type="text" value="${escapeHtml(scene.name)}" style="width:100%"></label><label class="api-field">位置<input id="sp-location" type="text" value="${escapeHtml(scene.location||'')}" style="width:100%"></label><label class="api-field">物理特征（每行一条）<textarea id="sp-features" class="world-setting" rows="5" style="width:100%">${escapeHtml((scene.physicalFeatures||[]).join('\n'))}</textarea></label><label class="api-field">氛围<textarea id="sp-atmosphere" class="world-setting" rows="2" style="width:100%">${escapeHtml(scene.atmosphere||'')}</textarea></label><div style="margin-top:16px;display:flex;justify-content:flex-end;gap:8px"><button id="sp-cancel" class="btn-sm" style="padding:6px 16px">取消</button><button id="sp-save" class="btn-sm" style="padding:6px 16px;background:var(--accent);color:#fff;border:none;border-radius:6px">保存</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#sp-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#sp-save').onclick = async () => {
    await fetch('/api/scenes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: overlay.querySelector('#sp-name').value.trim().slice(0,40), location: overlay.querySelector('#sp-location').value.trim(), physicalFeatures: overlay.querySelector('#sp-features').value.split('\n').map(s=>s.trim()).filter(Boolean), atmosphere: overlay.querySelector('#sp-atmosphere').value }) });
    overlay.remove(); loadSceneProfiles();
  };
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}
