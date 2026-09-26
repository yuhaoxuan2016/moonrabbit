// lib/llm/transport.js —— M-08·llm-transport 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const { loadNameRedact } = require('../tools/redact');

const THINK_BUDGET = { low: 4096, medium: 8192, high: 32768, max: 65536 };  // 思考强度档位 → 预算 token（custom 用 thinkingBudget 字段）
function parseTurnTags(content) {
  const rec = { story_time: '', location: '', atmosphere: '', characters: [], costume: '', event: '', items_gain: [], items_loss: [], updates: [], emotion: {}, character_intro: {}, relationships: [], location_detail: [] };
  const evRe = /<storyevent>([\s\S]*?)<\/storyevent>/gi;
  let m;
  const applyStoryKv = (k, v) => {
    if (k.includes('time')) rec.story_time = v;
    else if (k === 'location' || k === '场景' || k === '地点') rec.location = v;
    else if (k.includes('atmosphere')) rec.atmosphere = v;
    else if (k.includes('characters')) rec.characters = v.split(/[、,，/]+/).map((s) => s.trim()).filter(Boolean);
    else if (k.includes('costume')) rec.costume = v;
    else if (k.includes('event')) rec.event = v;
    else if (k.includes('emotion') || k.includes('mood')) {
      // emotion: 角色=情绪 / emotion: 角色：情绪（多角色用分号或换行分隔）
      for (const pair of v.split(/[;；\n]/)) {
        const pm = pair.match(/^\s*([^=：:]+)[=：:]\s*(.+)$/);
        if (pm && pm[2].trim()) rec.emotion[pm[1].trim()] = pm[2].trim();
      }
    }
    // 新增：角色简介（character_intro: 角色名=简介；多角色用分号分隔）
    else if (k.includes('character_intro') || k.includes('characterintro') || k.includes('角色简介')) {
      for (const pair of v.split(/[;；\n]/)) {
        const pm = pair.match(/^\s*([^=：:]+)[=：:]\s*(.+)$/);
        if (pm && pm[2].trim()) rec.character_intro[pm[1].trim()] = pm[2].trim();
      }
    }
    // 新增：关系信息（relationships: 角色A-角色B=关系类型（简短描述）；多条用分号分隔）
    else if (k.includes('relationships') || k.includes('关系')) {
      for (const pair of v.split(/[;；\n]/)) {
        const pm = pair.match(/^\s*([^=：:]+)[=：:]\s*(.+)$/);
        if (pm && pm[2].trim()) {
          const relParts = pm[1].trim().split(/[-—→]+/);
          if (relParts.length >= 2) {
            rec.relationships.push({
              from: relParts[0].trim(),
              to: relParts[1].trim(),
              type: pm[2].trim(),
              description: ''
            });
          }
        }
      }
    }
    // 新增：地点详细档案（location_detail: 分组| 地点名：详细描写；多条用换行分隔）
    else if (k.includes('location_detail') || k.includes('locationdetail') || k.includes('地点档案')) {
      for (const entry of v.split(/\n+/)) {
        const e = entry.trim();
        if (!e) continue;
        // 格式：分组| 地点名：描写
        const barIdx = e.indexOf('|');
        const group = barIdx >= 0 ? e.slice(0, barIdx).trim() : '';
        const rest = barIdx >= 0 ? e.slice(barIdx + 1).trim() : e;
        const pm = rest.match(/^\s*([^：:]+)[：:]\s*(.+)$/);
        if (pm && pm[2].trim()) {
          rec.location_detail.push({ group: group || '未分组', name: pm[1].trim(), detail: pm[2].trim() });
        }
      }
    }
  };
  while ((m = evRe.exec(content))) {
    // 兼容两种输出格式（2026-08-30 修复单行解析失败）：
    // ① 多行：time: X\nlocation: Y\n...（旧格式）
    // ② 单行分号：time: X; location: Y; ...（当前 prompt 模板示例——此前按行解析会把整行
    //    贪婪吞进 story_time，location/event/emotion 全空 → 剧情记忆不更新）
    // 统一切段：先按行、再按分号（; ；）切；无键续段（如多角色 emotion 的第二段）拼回上一字段值。
    const segs = m[1].split(/\r?\n/).flatMap((l) => l.split(/[;；]/));
    let lastK = '';
    for (const seg of segs) {
      const kv = seg.match(/^\s*([a-zA-Z_\u4e00-\u9fa5]+)\s*[:：]\s*(.+)$/);
      if (kv) {
        lastK = kv[1].toLowerCase();
        applyStoryKv(lastK, kv[2].trim());
      } else if (lastK && seg.trim()) {
        // 无键续段（如「角色B=开心」承接 emotion）——保持原分号语义拼回上一字段
        applyStoryKv(lastK, '；' + seg.trim());
      }
    }
  }
  const hRe = /<items>([\s\S]*?)<\/items>/gi;
  while ((m = hRe.exec(content))) {
    // 同样兼容单行分号：item: A=犬; item-: B
    for (const line of m[1].split(/\r?\n/).flatMap((l) => l.split(/[;；]/))) {
      let im = line.match(/^\s*item-\s*[:：]\s*(.+?)\s*$/i);
      if (im) { rec.items_loss.push(im[1].trim()); continue; }
      im = line.match(/^\s*item\s*[:：]\s*([^=]+?)(?:\s*=\s*([^\s]+))?\s*$/i);
      if (im) rec.items_gain.push({ name: im[1].trim(), holder: (im[2] || '').replace(/[，,。;；]$/, '') });
    }
  }
  const upRe = /【更新】([^：:]+)[：:]\s*(.+)/g;
  while ((m = upRe.exec(content))) rec.updates.push({ entry: m[1].trim(), content: m[2].trim() });
  // 名称替换规则（2026-09-03）：
  // 原为硬编码的真名替换表，会把用户角色卡里的特定词**静默改写**成指定别名
  // ——用户完全不知情、也无法关闭，属于篡改用户数据。
  // 改为：可选配置 data/name-redact.json = { "enabled": true, "map": { "原名": "替换名" } }，
  // 默认不存在即**完全不替换**（保持用户数据原样）。
  const sanitizeSecret = (s) => {
    const out = String(s ?? '');
    const rules = loadNameRedact();
    if (!rules) return out;
    let r = out;
    for (const [from, to] of rules) r = r.split(from).join(to);
    return r;
  };
  if (rec.character_intro && typeof rec.character_intro === 'object') {
    for (const k of Object.keys(rec.character_intro)) {
      const cleanKey = sanitizeSecret(k);
      const val = sanitizeSecret(rec.character_intro[k]);
      if (cleanKey !== k) { delete rec.character_intro[k]; rec.character_intro[cleanKey] = val; }
      else rec.character_intro[k] = val;
    }
  }
  if (Array.isArray(rec.relationships)) {
    for (const rel of rec.relationships) {
      rel.from = sanitizeSecret(rel.from);
      rel.to = sanitizeSecret(rel.to);
      rel.type = sanitizeSecret(rel.type);
      rel.description = sanitizeSecret(rel.description);
    }
  }
  if (Array.isArray(rec.location_detail)) {
    for (const loc of rec.location_detail) {
      loc.group = sanitizeSecret(loc.group);
      loc.name = sanitizeSecret(loc.name);
      loc.detail = sanitizeSecret(loc.detail);
    }
  }
  return rec;
}
function adaptVisionContent(msg, protocol) {
  const c = msg.content;
  if (typeof c !== 'object' || !Array.isArray(c)) return msg;
  if (protocol !== 'anthropic') return msg;   // openai 原生支持 image_url 块
  const out = [];
  for (const part of c) {
    if (part.type === 'text') { out.push(part); continue; }
    if (part.type === 'image_url' && part.image_url && typeof part.image_url.url === 'string') {
      const m = part.image_url.url.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/);
      if (m) {
        out.push({ type: 'image', source: { type: 'base64', media_type: `image/${m[1]}`, data: m[2] } });
        continue;
      }
    }
    out.push({ type: 'text', text: '[图片]' });   // 未知格式兜底
  }
  return { ...msg, content: out };
}
async function fetchWithConnectTimeout(url, opts, ms = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('连接超时（30s 无响应头）')), ms);
  try {
    const sig = opts.signal ? AbortSignal.any([opts.signal, ctl.signal]) : ctl.signal;
    return await fetch(url, { ...opts, signal: sig });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { THINK_BUDGET, parseTurnTags, adaptVisionContent, fetchWithConnectTimeout };
