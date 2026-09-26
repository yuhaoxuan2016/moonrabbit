// lib/http/handlers/avatars.js —— M-08·avatars-handlers 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync } = require('../../core/io');
const { DATA_DIR } = require('../../core/paths');
const { State } = require('../../core/state');
const { IMG_MODEL_PRESETS } = require('../../ext/media');
const { readBody, MIME } = require('../respond');
const { AVATAR_CUSTOM_DIR, saveAvatarCustom, NPC_PROFILES_DIR, loadNpcProfile, saveNpcProfile, listNpcProfiles, SCENES_DIR, loadScene, saveScene, listScenes, EXPRESSIONS_DIR, saveExpressionConfig, listExpressions, pngCreateWithTextChunk, pngReadTextChunks } = require('../../store/avatars');
const { DEFAULT_EMOTION_MAP } = require('../../store/emotions');
const { sanitizeFileName } = require('../../tools/misc');

async function h_route_avatars(req, res, url, p) {
  const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    const STRIP_PREFIX = String.fromCharCode(233) + String.fromCharCode(135) + String.fromCharCode(353) + String.fromCharCode(233) + '头像/';   /* 自定义头像/ 前缀（绕过反斜杠转义） */
const am = p.match(/^\/avatars\/([^/]+)$/);
  if (am && req.method === 'GET') {
    const nm = sanitizeFileName(decodeURIComponent(am[1]), 40);
    const file = String(State.avatarCustom[nm] || '').replace(STRIP_PREFIX, '');   /* 兼容旧前缀映射 */
    if (file) {
      const safe = path.normalize(path.join(AVATAR_CUSTOM_DIR, file));
      if (safe.startsWith(AVATAR_CUSTOM_DIR + path.sep) && fs.existsSync(safe) && fs.statSync(safe).isFile()) {
        const ext = path.extname(safe).slice(1).toLowerCase();
        res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
        fs.createReadStream(safe).pipe(res);
        return true;
      }
    }
    res.writeHead(404); res.end(); return true;
  }
  if (p === '/api/avatar/upload' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { name, imageData } = JSON.parse(body);
      const nm = sanitizeFileName(name || '', 40);
      if (!nm || !imageData) { sendJson({ error: '缺少角色名或图片数据' }, 400); return true; };
      const match = String(imageData).match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
      if (!match) { sendJson({ error: '图片格式不支持（需 base64 data URL）' }, 400); return true; };
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const buf = Buffer.from(match[2], 'base64');
      if (buf.length > 5 * 1024 * 1024) { sendJson({ error: '图片过大（>5MB）' }, 400); return true; };
      fs.mkdirSync(AVATAR_CUSTOM_DIR, { recursive: true });
      const fileName = nm + '.' + ext;
      writeFileAtomicSync(path.join(AVATAR_CUSTOM_DIR, fileName), buf);
      State.avatarCustom[nm] = fileName;   /* S5：映射存纯文件名（AVATAR_CUSTOM_DIR 已是目录绝对路径，join 时不再拼目录，防双重目录） */
      saveAvatarCustom();
      sendJson({ ok: true, url: '/avatars/' + encodeURIComponent(nm), name: nm });
      return true;
    } catch (e) { sendJson({ error: String(e) }, 400); return true; };
  }
  if (p === '/api/avatar/remove' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { name } = JSON.parse(body);
      const nm = sanitizeFileName(name || '', 40);
      const file = String(State.avatarCustom[nm] || '').replace(STRIP_PREFIX, '');
      if (file) { try { fs.unlinkSync(path.join(AVATAR_CUSTOM_DIR, file)); } catch (e) {} delete State.avatarCustom[nm]; saveAvatarCustom(); }
      sendJson({ ok: true });
      return true;
    } catch (e) { sendJson({ error: String(e) }, 400); return true; };
  }
  if (p === '/api/avatar/list' && req.method === 'GET') {
    const files = Object.entries(State.avatarCustom).map(([nm2, f]) => ({ name: nm2, url: '/avatars/' + encodeURIComponent(nm2) }));
    sendJson({ ok: true, files });
    return true;
  }
  // 图生图产头像（2026-09-18）：
  //   引擎/端点/模型一律跟随已有的场景插图配置（illustration-config.json），不新增配置口；
  //   实现上刻意避开了三处——①不做 Ark 分支（本版的生图层也没有 Ark）
  //   ②外观锚不读内置设定文件，改读本版的本地 NPC 档案 appearance（无档案则退回兜底句）
  //   ③必须显式传示例图（本版没有「角色立绘库」可回落）。
  if (p === '/api/avatar/generate' && req.method === 'POST') {
    let body = await readBody(req);
    try {
      const { name, imageData } = JSON.parse(body);
      const nm = sanitizeFileName(name || '', 40);
      if (!nm) { sendJson({ error: '缺少角色名' }, 400); return true; }
      if (!imageData) { sendJson({ error: '请提供示例图（base64 data URL）' }, 400); return true; }
      const imgMatch = String(imageData).match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
      if (!imgMatch) { sendJson({ error: '示例图格式不支持（需 base64 data URL）' }, 400); return true; }
      const ext = imgMatch[1] === 'jpeg' ? 'jpg' : imgMatch[1];
      const illustConfigFile = path.join(DATA_DIR, 'illustration-config.json');
      let config = { engine: '', apiKey: '', baseURL: '', model: '', chatModel: '' };
      try { if (fs.existsSync(illustConfigFile)) config = Object.assign({ engine: '', apiKey: '', baseURL: '', model: '', chatModel: '' }, JSON.parse(fs.readFileSync(illustConfigFile, 'utf8'))); } catch (e) {}
      const key = config.apiKey || '';
      if (!key) { sendJson({ error: '图片生成功能未配置。请先在设置里填写生图 API Key。', needConfig: true }, 400); return true; }
      // Authorization 头只能放 Latin1 字符：粘进中文/全角括号会让 fetch 直接抛 TypeError（报错看不懂），
      // 所以在入口就拒掉并说清是哪的问题（key 本身没被送到任何远端）。
      if (!/^[\x21-\x7e]+$/.test(key)) { sendJson({ error: '生图 API Key 含非法字符（应为 ASCII，注意别把中文说明一起粘进来）' }, 400); return true; }
      const prof = loadNpcProfile(nm);
      const appearance = prof && prof.appearance ? String(prof.appearance).slice(0, 300) : '';
      const prompt = '根据这张图片中的人物，生成一张头像（脸部特写为主，白色背景，动漫风格）' +
        (appearance ? '。角色外观特征：' + appearance + '。必须严格保持上述外观（发色/瞳色/发型/服装），不得改变' : '。保持人物外观一致');
      const baseURL = String(config.baseURL || '').replace(/\/+$/, '');
      if (!baseURL) { sendJson({ error: '图片生成未配置：请填「生图端点（Base URL）」。', needConfig: true }, 501); return true; }
      const model = String(config.model || (IMG_MODEL_PRESETS[String(config.engine || '')] || {}).id || '').trim();
      if (!model) { sendJson({ error: '图片生成未配置：请填「模型 id」。', needConfig: true }, 501); return true; }
      const r = await fetch(baseURL + '/images/generations', {
        method: 'POST',
        headers: { 'authorization': 'Bearer ' + key, 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt, image: imageData, image_size: '512x512', batch_size: 1, num_inference_steps: 20, guidance_scale: 7.5 }),
        signal: AbortSignal.timeout(180000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { sendJson({ error: (d && d.message) || (d && d.error && d.error.message) || ('接口错误(' + r.status + ')') }, 200); return true; }
      const img = (d.images && Array.isArray(d.images) && d.images[0]) || null;
      if (!img || !img.url) { sendJson({ error: '头像生成失败（接口未返回图片 URL）' }, 200); return true; }
      const imageR = await fetch(img.url, { signal: AbortSignal.timeout(60000) });
      if (!imageR.ok) { sendJson({ error: '头像图片下载失败（接口返回的 URL 不可达）' }, 200); return true; }
      const buf = Buffer.from(await imageR.arrayBuffer());
      if (!buf.length) { sendJson({ error: '头像生成失败（接口返回空图）' }, 200); return true; }
      if (buf.length > 5 * 1024 * 1024) { sendJson({ error: '生成的图片过大（>5MB）' }, 200); return true; }
      fs.mkdirSync(AVATAR_CUSTOM_DIR, { recursive: true });
      const fileName = nm + '.' + ext;
      writeFileAtomicSync(path.join(AVATAR_CUSTOM_DIR, fileName), buf);
      State.avatarCustom[nm] = fileName;   /* 与 upload 分支同构：映射存纯文件名，防双重目录 */
      saveAvatarCustom();
      sendJson({ ok: true, url: '/avatars/' + encodeURIComponent(nm), name: nm, model });
      return true;
    } catch (e) { sendJson({ error: String(e) }, 400); return true; }
  }
  return false;
}
async function h_route_22(req, res, url, p) {
  // NPC 档案
    const npcM = p.match(/^\/api\/npc-profiles(?:\/([^/]+))?$/);
  if (npcM) {
      const name = npcM[1] ? sanitizeFileName(decodeURIComponent(npcM[1]), 40) : null;
      const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
      if (!name) {
        if (req.method === 'GET') { sendJson({ ok: true, profiles: listNpcProfiles() }); return true; };
        if (req.method === 'POST') { let b = await readBody(req); try { const d = JSON.parse(b); const n = sanitizeFileName(d.name || '', 40); if (!n) { sendJson({error:'名称不能为空'},400); return true; }; const p2={name:n,aliases:d.aliases||[],appearance:d.appearance||'',personality:d.personality||'',age:d.age||null,ageNote:d.ageNote||'',relationships:d.relationships||{},firstAppearance:d.firstAppearance||'',lastUpdated:new Date().toISOString(),notes:d.notes||''}; saveNpcProfile(n,p2); return sendJson({ok:true,profile:p2}); } catch(e){return sendJson({error:String(e)},400);} }
      } else {
        if (req.method === 'GET') { const p2=loadNpcProfile(name); { p2?sendJson({ok:true,profile:p2}):sendJson({error:'不存在'},404); return true; }; }
        if (req.method === 'DELETE') { try{fs.unlinkSync(path.join(NPC_PROFILES_DIR,`${name}.json`));}catch(e){} { sendJson({ok:true}); return true; }; }
      }
    }
  return false;
}
async function h_route_23(req, res, url, p) {
  // 场景档案
    const sceneM = p.match(/^\/api\/scenes(?:\/([^/]+))?$/);
  if (sceneM) {
      const name = sceneM[1] ? sanitizeFileName(decodeURIComponent(sceneM[1]), 40) : null;
      const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
      if (!name) {
        if (req.method === 'GET') { sendJson({ ok: true, scenes: listScenes() }); return true; };
        if (req.method === 'POST') { let b = await readBody(req); try { const d = JSON.parse(b); const n = sanitizeFileName(d.name || '', 40); if (!n) { sendJson({error:'名称不能为空'},400); return true; }; const s={name:n,location:d.location||'',physicalFeatures:d.physicalFeatures||[],atmosphere:d.atmosphere||'',lastVisited:d.lastVisited||new Date().toISOString().slice(0,10),visitCount:d.visitCount||0,notes:d.notes||''}; saveScene(n,s); return sendJson({ok:true,scene:s}); } catch(e){return sendJson({error:String(e)},400);} }
      } else {
        if (req.method === 'GET') { const s=loadScene(name); { s?sendJson({ok:true,scene:s}):sendJson({error:'不存在'},404); return true; }; }
        if (req.method === 'DELETE') { try{fs.unlinkSync(path.join(SCENES_DIR,`${name}.json`));}catch(e){} { sendJson({ok:true}); return true; }; }
      }
    }
  return false;
}
async function h_api_expressions_config_24(req, res, url, p) {
  // 特判：/api/expressions/config 是功能路由，须先于 expM 通配匹配（否则被当成角色名 config）
    if (p === '/api/expressions/config' && req.method === 'POST') { let b=await readBody(req); try { const d=JSON.parse(b); if(d.emotionMap) State.emotionMap={...DEFAULT_EMOTION_MAP,...d.emotionMap}; if(typeof d.enableAutoSwitch==='boolean') State.enableAutoSwitch=d.enableAutoSwitch; saveExpressionConfig(); res.writeHead(200,{'content-type':'application/json; charset=utf-8'}); { res.end(JSON.stringify({ok:true})); return true; }; } catch(e){res.writeHead(400,{'content-type':'application/json; charset=utf-8'}); return res.end(JSON.stringify({error:String(e)})); } }
  return false;
}
async function h_route_25(req, res, url, p) {
  // 表情系统
    const expM = p.match(/^\/api\/expressions(?:\/([^/]+))?$/);
  if (expM) {
      const charName = expM[1] ? sanitizeFileName(decodeURIComponent(expM[1]), 40) : null;
      const sendJson = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
      if (!charName) {
        if (req.method === 'GET') { try { const cs=fs.readdirSync(EXPRESSIONS_DIR).filter(f=>fs.statSync(path.join(EXPRESSIONS_DIR,f)).isDirectory()); const r={}; for(const c of cs) r[c]=listExpressions(c); { sendJson({ok:true,expressions:r,config:{emotionMap: State.emotionMap,enableAutoSwitch: State.enableAutoSwitch}}); return true; }; } catch(e){return sendJson({ok:true,expressions:{},config:{emotionMap: State.emotionMap,enableAutoSwitch: State.enableAutoSwitch}}); } }
      } else {
        if (req.method === 'GET') { sendJson({ ok: true, expressions: listExpressions(charName) }); return true; };
        if (req.method === 'DELETE') {
          // 删除单个表情（?name=表情名）
          const name = decodeURIComponent(req.url?.match(/[?&]name=([^&]+)/)?.[1] || '');
          if (!name) { sendJson({ error: '缺少表情名' }, 400); return true; };
          const safeName = sanitizeFileName(name, 40);
          const dir = path.join(EXPRESSIONS_DIR, charName);
          const file = path.join(dir, safeName);
          if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) { sendJson({ error: '表情不存在' }, 404); return true; };
          try { fs.unlinkSync(file); { sendJson({ ok: true, deleted: safeName }); return true; }; }
          catch (e) { { sendJson({ error: String(e) }, 400); return true; }; }
        }
        if (req.method === 'POST') { const dir=path.join(EXPRESSIONS_DIR,charName); fs.mkdirSync(dir,{recursive:true}); let b=await readBody(req); try { const {name,imageData}=JSON.parse(b); const n=sanitizeFileName(name || '', 30); if(!n||!imageData) { sendJson({error:'缺少数据'},400); return true; }; const m=imageData.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/); if(!m) return sendJson({error:'格式不支持'},400); const ext=m[1]==='jpeg'?'jpg':m[1]; writeFileAtomicSync(path.join(dir,`${n}.${ext}`),Buffer.from(m[2],'base64')); return sendJson({ok:true}); } catch(e){return sendJson({error:String(e)},400);} }
      }
    }
  return false;
}
async function h_route_26(req, res, url, p) {
  const expSM = p.match(/^\/api\/expressions\/static\/([^/]+)\/(.+)$/);
  if (expSM) { const charName = sanitizeFileName(decodeURIComponent(expSM[1]), 40); const fileName = sanitizeFileName(decodeURIComponent(expSM[2]), 60); if (!charName || !fileName) { res.writeHead(404); { res.end(); return true; }; } const f=path.join(EXPRESSIONS_DIR,charName,fileName); if(fs.existsSync(f)){const ext=path.extname(f).toLowerCase(); const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[ext]||'application/octet-stream'; res.writeHead(200,{'content-type':mime,'cache-control':'public, max-age=86400'}); return res.end(fs.readFileSync(f));} res.writeHead(404); return res.end(); }
  return false;
}
async function h_route_46(req, res, url, p) {
  // 卡片交换 API：导出角色卡 PNG
    const cardsExpM = p.match(/^\/api\/cards\/export\/([^/]+)$/);
  if (cardsExpM && req.method === 'GET') {
      try {
        const charName = sanitizeFileName(decodeURIComponent(cardsExpM[1]));
        const profileFile = path.join(NPC_PROFILES_DIR, `${charName}.json`);
        if (!fs.existsSync(profileFile)) { res.writeHead(404); { res.end('角色不存在'); return true; }; }
        const profile = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
        const charCard = { name: profile.name || charName, description: profile.appearance || '', personality: profile.personality || '', mes_example: '', system_prompt: '', tags: profile.tags || [], creator: 'moonrabbit', character_version: '1.0', extensions: { relationships: profile.relationships || {}, age: profile.age, ageNote: profile.ageNote, firstAppearance: profile.firstAppearance, notes: profile.notes } };
        const charJson = JSON.stringify(charCard);
        const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
        const result = pngCreateWithTextChunk(pngBuffer, 'chara', Buffer.from(charJson).toString('base64'));
        if (!result) { res.writeHead(500); { res.end('PNG 生成失败'); return true; }; }
        // RFC 5987：filename* 支持中文文件名，filename 用 ASCII 兜底
        res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': `attachment; filename="card.png"; filename*=UTF-8''${encodeURIComponent(charName)}.png` });
        { res.end(result); return true; };
      } catch (e) { res.writeHead(500); { res.end('导出失败：' + String(e)); return true; }; }
    }
  return false;
}
async function h_api_cards_import_47(req, res, url, p) {
  // 卡片交换 API：导入角色卡 PNG
    if (p === '/api/cards/import' && req.method === 'POST') {
      let body = await readBody(req);
      try {
        const { imageData } = JSON.parse(body);
        if (!imageData) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: '缺少图片数据' })); return true; }; }
        let buf;
        if (typeof imageData === 'string' && imageData.startsWith('data:image/png;base64,')) buf = Buffer.from(imageData.split(',')[1], 'base64');
        else if (typeof imageData === 'string') buf = Buffer.from(imageData, 'base64');
        else buf = Buffer.from(imageData);
        const chunks = pngReadTextChunks(buf);
        const charaChunk = chunks.find(c => c.keyword === 'chara');
        if (!charaChunk) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: 'PNG 中未找到角色卡数据（缺少 chara tEXt chunk）' })); return true; }; }
        const charData = JSON.parse(Buffer.from(charaChunk.text, 'base64').toString('utf8'));
        const profile = { name: sanitizeFileName(String(charData.name || '未命名').slice(0, 40)), aliases: charData.tags || [], appearance: charData.description || '', personality: charData.personality || '', age: charData.extensions?.age || null, ageNote: charData.extensions?.ageNote || '', relationships: charData.extensions?.relationships || {}, firstAppearance: charData.extensions?.firstAppearance || '导入自酒馆角色卡', lastUpdated: new Date().toISOString(), notes: charData.extensions?.notes || '', tags: charData.tags || [] };
        saveNpcProfile(profile.name, profile);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        { res.end(JSON.stringify({ ok: true, profile, source: 'png-import' })); return true; };
      } catch (e) { res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' }); { res.end(JSON.stringify({ error: String(e) })); return true; }; }
    }
  return false;
}

module.exports = { h_route_avatars, h_route_22, h_route_23, h_api_expressions_config_24, h_route_25, h_route_26, h_route_46, h_api_cards_import_47 };
