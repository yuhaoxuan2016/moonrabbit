'use strict';
/**
 * 群聊模式：多个角色各自独立调用模型发言，后发言者能看到前发言者的实际输出。
 *
 * 与「单脑一次生成全部台词」的根本区别：每个角色**独立调用** LLM、各自组装上下文，
 * 因而形成真实的反应链，而不是一次采样里猜测彼此会说什么。
 *
 * 设计立场：
 *   不依赖静态「角色卡」决定谁能发言；上下文由**活数据**当场组装——
 *   最新回合的记账信息（场景/在场/着装/情绪）+ 设定触发器/世界书命中。
 *   角色有无档案只影响能注入多少设定，不影响能否发言；识别不到即按「新角色」处理。
 *
 * 宿主注入（host）：由 server.js 通过 createGroup(host) 注入所需能力，
 * 本模块不直接依赖 server.js 的模块作用域，便于独立测试与移植。
 *
 * ⚠️ 未经测试（实验性）：本模块的「多角色独立调用 + 反应链」链路目前**未经过充分测试**，
 * 接口与行为可能随实现调整而变化。默认不启用——只有用户在会话里显式开启群聊才会走到这里。
 * 未提供的宿主能力（如档案查询）会自动降级，不影响既有单脑对话路径。
 */

const fs = require('fs');
const path = require('path');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');

/** 读取 prompt 模板（失败返回内置兜底，避免文件缺失导致整轮不可用）。 */
function loadPrompt(name, fallback) {
  try {
    const p = path.join(PROMPTS_DIR, name);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch { /* 落兜底 */ }
  return fallback;
}

/** 极简模板渲染：{{key}} → value（缺失键渲染为空串）。 */
function render(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

// ── 默认配置 ────────────────────────────────────────────────────────────────
const DEFAULTS = {
  groupMode: false,
  roster: [],            // [{ name, model?, muted?, maxLines? }]
  directorModel: null,   // null = 继承会话默认
  narratorModel: null,
  maxSpeakersPerTurn: 4,
  historyWindow: 12,     // 共享历史轮数
};

const NARRATOR = '旁白';

/**
 * 群聊运行时。host 需提供：
 *   completeText(ep, sys, userText, maxTokens, extraBody) → string
 *   endpoint                     主端点（兜底模型）
 *   readTurns(chatId)            回合记录
 *   scanLorebook(history, last)  设定触发器/世界书扫描（可选）
 *   lookupNpcProfile(name)       角色档案查询（可选）
 *   isUserRole(name)             该名字是否代表用户本人（可选）
 *   log(...)                     日志（可选）
 */
function createGroup(host) {
  const log = host.log || (() => {});

  // ── 配置 ──────────────────────────────────────────────────────────────────
  function normalizeConfig(raw) {
    const cfg = { ...DEFAULTS, ...(raw || {}) };
    cfg.roster = Array.isArray(cfg.roster) ? cfg.roster.filter((r) => r && r.name).map((r) => ({
      name: String(r.name).trim(),
      model: r.model || null,
      muted: !!r.muted,
      maxLines: Number(r.maxLines) > 0 ? Number(r.maxLines) : 3,
    })) : [];
    return cfg;
  }

  /** 三层继承：角色专属 → 会话默认 → 主端点。 */
  function resolveModel(cfg, roleName) {
    const entry = cfg.roster.find((r) => r.name === roleName);
    const pick = (entry && entry.model) || cfg.sessionModel || null;
    if (pick && pick.baseURL && pick.apiKey) return pick;
    return host.endpoint;
  }

  /** 导演模型：默认继承主端点，可被会话级 directorModel 显式覆盖。 */
  function resolveDirectorModel(cfg) {
    const m = cfg.directorModel;
    if (m && m.baseURL && m.apiKey) return m;
    return host.endpoint;
  }

  function resolveNarratorModel(cfg) {
    const m = cfg.narratorModel;
    if (m && m.baseURL && m.apiKey) return m;
    return host.endpoint;
  }

  // ── roster 自动增长（新角色无需手填即可发言）────────────────────────────
  /**
   * 从最新回合的 characters[] 发现新角色并自动注册进 roster。
   * 这是「新角色自然出场」的关键：剧情带出 → 下一轮即可独立发言。
   * @returns {{cfg, added: string[]}}
   */
  function syncRoster(cfg, chatId) {
    const added = [];      // 真·全新角色
    const rejoined = [];   // 档案里已有、本会话首次入场
    let present = [];
    try {
      const turns = (host.readTurns && host.readTurns(chatId)) || [];
      const last = turns[turns.length - 1] || {};
      present = Array.isArray(last.characters) ? last.characters : [];
    } catch { present = []; }

    const known = new Map(cfg.roster.map((r) => [r.name, r]));
    for (const raw of present) {
      const name = String(raw || '').trim();
      if (!name || name === NARRATOR) continue;
      if (host.isUserRole && host.isUserRole(name)) continue;   // 用户本人不由 AI 代言

      const id = identifyRole(name);
      const finalName = id.formalName || name;               // 别名归一到正式名
      if (known.has(finalName)) continue;

      const entry = {
        name: finalName, model: null, muted: false, maxLines: 3,
        tier: id.tier,                 // npc | new
        profile: id.profile || '',     // 已有设定摘要（供 speakAs 注入）
        ...(finalName !== name ? { alias: name } : {}),
      };
      cfg.roster.push(entry);
      known.set(finalName, entry);
      (id.known ? rejoined : added).push(finalName);
    }
    if (rejoined.length) log('[group] 已建档角色入场: ' + rejoined.join('、'));
    if (added.length) log('[group] ⚠️ 全新角色（无档案，建议后续补建）: ' + added.join('、'));
    return { cfg, added, rejoined };
  }

  /**
   * 本轮候选池 = roster ∩ present − muted。
   *
   * roster 是「本会话认识谁」的累积注册表（只增，保留每人的模型/禁言配置）；
   * present 是「这一轮谁在场」（每轮取自记账信息 characters[]）。
   * 二者取交集，**离场角色不会被导演选中发言**（防串场）。
   *
   * 边界：present 为空/缺失（纯旁白轮、新会话首轮）时不能把候选清空，
   * 否则整轮无人可说 → 回退为 roster 全体。
   */
  function candidatesFor(cfg, shared) {
    const alive = cfg.roster.filter((r) => !r.muted);
    const present = Array.isArray(shared && shared.present) ? shared.present : [];
    if (!present.length) return alive;                       // 无在场信息 → 不做过滤
    const inScene = alive.filter((r) => present.includes(r.name));
    return inScene.length ? inScene : alive;                 // 交集为空 → 回退，避免死锁
  }

  // ── 角色身份识别（区分「档案里已有」与「真·全新角色」）────────────────
  /**
   * 判定一个名字的档案来源与丰富度。
   *
   * 为什么需要：模型输出的 characters[] 里既可能是早有设定的老角色（别名/简称
   * 写法不同），也可能是本轮才诞生的新人。二者待遇必须不同——
   *   已知角色 → 注入既有设定，**不得让模型重新编造人设**
   *   全新角色 → 允许当场立人，并提示补建档
   * 若把老角色误判为新人，模型会凭空重写其身份，造成设定漂移。
   *
   * @returns {{ known:boolean, tier:'npc'|'new', formalName:string, profile:string }}
   */
  function identifyRole(name) {
    const raw = String(name || '').trim();
    const miss = { known: false, tier: 'new', formalName: raw, profile: '' };
    if (!raw) return miss;

    // 角色档案（data/npc-profiles/*.json，编辑器可维护）
    if (host.lookupNpcProfile) {
      try {
        const n = host.lookupNpcProfile(raw);
        if (n && (n.appearance || n.personality || n.notes)) {
          const profile = [
            n.appearance ? '外貌：' + n.appearance : '',
            n.personality ? '性格：' + n.personality : '',
            n.notes ? '备注：' + n.notes : '',
          ].filter(Boolean).join('\n').slice(0, 1500);
          return { known: true, tier: 'npc', formalName: (n.name || raw), profile };
        }
      } catch { /* 降级继续 */ }
    }
    return miss;   // 真·全新角色
  }

  function parseMentions(text, cfg) {
    const t = String(text || '');
    const roles = [];
    let narrator = false;
    const re = /@([^\s@，,。.！!？?：:；;]{1,20})/g;
    let m;
    while ((m = re.exec(t)) !== null) {
      const token = m[1];
      if (NARRATOR.startsWith(token) || token.startsWith(NARRATOR)) { narrator = true; continue; }
      const hit = cfg.roster.find((r) => r.name === token)
        || cfg.roster.find((r) => r.name.startsWith(token) || token.startsWith(r.name));
      if (hit && !hit.muted && !roles.includes(hit.name)) roles.push(hit.name);
    }
    return { roles, narrator };
  }

  // ── 共享层（所有发言者一致）──────────────────────────────────────────────
  async function buildSharedLayer(cfg, chatId, userInput, history) {
    const shared = { scene: '', present: [], costume: '', emotion: '', history: [], lore: '' };
    try {
      const turns = (host.readTurns && host.readTurns(chatId)) || [];
      const last = turns[turns.length - 1] || {};
      const bits = [];
      if (last.story_time) bits.push('时间：' + last.story_time);
      if (last.location) bits.push('地点：' + last.location);
      if (last.atmosphere) bits.push('氛围：' + last.atmosphere);
      shared.scene = bits.join('｜');
      shared.present = Array.isArray(last.characters) ? last.characters : [];
      shared.costume = last.costume || '';
      shared.emotion = last.emotion && typeof last.emotion === 'object'
        ? Object.entries(last.emotion).map(([k, v]) => `${k}=${v}`).join('、') : '';
    } catch { /* 场景缺失不阻断 */ }

    shared.history = (history || []).slice(-cfg.historyWindow);

    if (host.scanLorebook) {
      try {
        const r = host.scanLorebook(shared.history, userInput, chatId);
        if (r && Array.isArray(r.entries) && r.entries.length) {
          shared.lore = r.entries.map((e) => `[${e.name}]\n${e.content}`).join('\n\n');
        }
      } catch { /* 触发器失败不阻断 */ }
    }
    return shared;
  }

  // ── 角色专属层（按角色筛，全部自动降级）──────────────────────────────────
  async function buildRoleLayer(cfg, chatId, roleName, userInput, shared) {
    const layer = { costume: '', emotion: '', lore: '' };

    if (shared.costume && shared.costume.includes(roleName)) {
      layer.costume = shared.costume.split(/[;；]/).filter((s) => s.includes(roleName)).join('；');
    }
    if (shared.emotion && shared.emotion.includes(roleName)) {
      layer.emotion = shared.emotion.split(/[、,]/).filter((s) => s.includes(roleName)).join('、');
    }

    if (shared.lore) {
      const hit = shared.lore.split('\n\n').filter((b) => b.includes(roleName));
      if (hit.length) layer.lore = hit.join('\n\n');
    }
    return layer;
  }

  // ── 导演 ─────────────────────────────────────────────────────────────────
  const DIRECTOR_FALLBACK = `你是多角色 RP 群聊的导演，只负责调度，不写任何台词。

## 候选角色
{{candidates}}

## 用户本轮输入
{{userInput}}

## 强制发言（被 @ 点名，必须全部入选）
{{forced}}

## 最近剧情
{{recent}}

## 规则
1. 被点名角色必须入选，且排在前面
2. 与本轮输入直接相关的角色优先
3. 本轮发言角色不超过 {{maxSpeakers}} 人
4. 每人 maxLines 取 1-3
5. narrator 仅在需要场景转换/环境描写时为 true

只输出 JSON，不要任何解释：
{"speakers":[{"name":"角色名","order":1,"maxLines":2}],"narrator":false}`;

  function parseDirectorJson(text) {
    if (!text) return null;
    let s = String(text).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    try {
      const o = JSON.parse(s.slice(i, j + 1));
      if (!o || !Array.isArray(o.speakers)) return null;
      return o;
    } catch { return null; }
  }

  /** 兜底：导演失败时也要能正常出话（@点名者 + 在场首位）。 */
  function fallbackPlan(cfg, mentions, shared) {
    const speakers = [];
    for (const n of mentions.roles) speakers.push({ name: n, order: speakers.length + 1, maxLines: 3 });
    if (!speakers.length) {
      const pick = candidatesFor(cfg, shared)[0];
      if (pick) speakers.push({ name: pick.name, order: 1, maxLines: 3 });
    }
    return { speakers, narrator: mentions.narrator, _fallback: true };
  }

  async function direct(cfg, chatId, userInput, mentions, shared) {
    // 候选 = roster ∩ present − muted（防离场角色串场）
    const candidates = candidatesFor(cfg, shared);
    if (!candidates.length) return { speakers: [], narrator: mentions.narrator };

    const tpl = loadPrompt('group-director.txt', DIRECTOR_FALLBACK);
    const sys = render(tpl, {
      candidates: candidates.map((r) => `- ${r.name}`).join('\n'),
      userInput,
      forced: mentions.roles.length ? mentions.roles.join('、') : '（无）',
      recent: shared.history.slice(-3).map((m) => `${m.role === 'user' ? '你' : 'AI'}: ${String(m.content || '').slice(0, 160)}`).join('\n'),
      maxSpeakers: cfg.maxSpeakersPerTurn,
    });

    let plan = null;
    let rawOut = '';
    try {
      // 导演只输出一个调度 JSON：部分模型默认开思考时 reasoning 会挤占 max_tokens
      // 导致 content 返回空，故显式关闭思考。
      rawOut = await host.completeText(resolveDirectorModel(cfg), sys, '', 1024, {
        temperature: 0.3, thinking: { type: 'disabled' },
      });
      plan = parseDirectorJson(rawOut);
      if (!plan) log('[group] 导演输出无法解析为 JSON，原文前200字: ' + String(rawOut).slice(0, 200).replace(/\n/g, ' '));
    } catch (e) { log('[group] 导演调用异常: ' + e.message); }

    if (!plan) {
      log('[group] 导演结果不可用 → 兜底调度');
      return fallbackPlan(cfg, mentions, shared);
    }

    // 归一：@点名强制置顶（即使不在场也尊重——手动点名=明确召唤意图）；
    // 导演选的人则必须在候选池内（= 在场且未禁言），防止串场。
    const valid = new Map();
    for (const n of mentions.roles) valid.set(n, { name: n, order: 0, maxLines: 3 });
    for (const s of plan.speakers) {
      const name = String((s && s.name) || '').trim();
      const entry = candidates.find((r) => r.name === name);
      if (!entry || valid.has(name)) continue;
      valid.set(name, { name, order: Number(s.order) || 99, maxLines: Math.min(Number(s.maxLines) || 2, entry.maxLines) });
    }
    const speakers = [...valid.values()].sort((a, b) => a.order - b.order).slice(0, cfg.maxSpeakersPerTurn);
    return { speakers, narrator: !!plan.narrator || mentions.narrator };
  }

  // ── 单角色发言 ────────────────────────────────────────────────────────────
  const ROLE_FALLBACK = `你现在**只扮演** {{role}} 一个角色。

{{identity}}

## 你此刻的处境
{{scene}}
在场：{{present}}
{{costume}}{{emotion}}

## 相关设定
{{lore}}

## 最近对话
{{history}}

## 本轮用户说
{{userInput}}

## 本轮在你之前，其他人刚说了
{{prior}}

## 硬性要求
1. **只输出 {{role}} 的发言**，绝对不许替其他任何角色说话或代写他们的反应
2. 格式：以「{{role}}：」开头；动作写在台词前后，不要写成「{{role}}（动作）：台词」
3. 最多 {{maxLines}} 句
4. 只写你这一个角色的内容，不写旁白、不写场景总结
5. 如果此刻你没有开口的必要，只输出一个动作也可以`;

  /**
   * 防串台：截断越权内容。
   * 只保留属于本角色的段落，遇到其他角色名前缀立即停止 —— 这是群聊
   * 相对单脑的**结构性**保证（单脑一次采样内无法阻止模型替别人说话）。
   */
  function enforceSpeaker(text, roleName, cfg) {
    let s = String(text || '').trim();
    if (!s) return '';
    const others = cfg.roster.map((r) => r.name).filter((n) => n !== roleName).concat([NARRATOR]);
    const lines = s.split('\n');
    const kept = [];
    for (const line of lines) {
      const m = line.match(/^\s*([^：:（(]{1,12})\s*[：:]/);
      if (m) {
        const who = m[1].trim();
        if (others.includes(who)) break;              // 越权 → 截断
      }
      kept.push(line);
    }
    s = kept.join('\n').trim();
    if (!s) return '';
    if (!new RegExp('^\\s*' + roleName + '\\s*[：:]').test(s)) s = `${roleName}：${s}`;
    return s;
  }

  async function speakAs(cfg, chatId, roleName, ctx) {
    const { shared, userInput, prior, maxLines } = ctx;
    const layer = await buildRoleLayer(cfg, chatId, roleName, userInput, shared);
    const entry = cfg.roster.find((r) => r.name === roleName) || {};

    // 已建档角色 → 给既有设定并禁止改写；全新角色 → 允许当场立人
    let identity;
    if (entry.profile) {
      identity = `## 你的既有设定（**必须遵守，不得改写**）\n${entry.profile}`;
    } else if (entry.tier === 'new') {
      identity = '## 关于你\n你是本场景中刚登场的新角色，此前没有既定设定。'
        + '请依据当前场景与对话自然地表现，保持前后一致；不要自称拥有宏大背景或与主线人物的既有渊源。';
    } else {
      identity = '## 关于你\n沿用你在既往对话中已表现出的言行风格，保持一致。';
    }

    const tpl = loadPrompt('group-role.txt', ROLE_FALLBACK);
    const sys = render(tpl, {
      role: roleName,
      identity,
      scene: shared.scene || '（场景未记录）',
      present: shared.present.join('、') || '（未记录）',
      costume: layer.costume ? '你的着装：' + layer.costume + '\n' : '',
      emotion: layer.emotion ? '你的情绪：' + layer.emotion + '\n' : '',
      lore: layer.lore || '（无）',
      history: shared.history.map((m) => `${m.role === 'user' ? '你' : 'AI'}: ${m.content}`).join('\n'),
      userInput,
      prior: prior || '（你是本轮第一个反应的人）',
      maxLines: maxLines || 2,
    });
    const out = await host.completeText(resolveModel(cfg, roleName), sys, '', 1024, { temperature: 0.9 });
    return enforceSpeaker(out, roleName, cfg);
  }

  // ── 旁白（独立，不占 roster 席位）─────────────────────────────────────────
  const NARRATOR_FALLBACK = `你是这场群聊的旁白，只写环境与场景，**不代任何角色说话**。

## 场景
{{scene}}
在场：{{present}}

## 本轮已发生的对话
{{speech}}

## 要求
1. 只写环境、气氛、动作余韵、镜头感
2. **禁止**输出任何「角色名：台词」形式
3. 2-4 句，简洁有画面感`;

  async function narrate(cfg, chatId, ctx) {
    const { shared, speech } = ctx;
    const tpl = loadPrompt('group-narrator.txt', NARRATOR_FALLBACK);
    const sys = render(tpl, {
      scene: shared.scene || '（场景未记录）',
      present: shared.present.join('、') || '（未记录）',
      speech: speech || '（本轮暂无台词）',
    });
    const out = await host.completeText(resolveNarratorModel(cfg), sys, '', 512, { temperature: 0.85 });
    // 旁白禁止带角色名前缀
    return String(out || '').split('\n')
      .filter((l) => !/^\s*[^：:（(]{1,12}\s*[：:]/.test(l))
      .join('\n').trim();
  }

  // ── 编排 ─────────────────────────────────────────────────────────────────
  /**
   * 跑完一轮群聊。
   * @param send 可选 SSE 回调，形如 (obj) => void；用于流式反馈进度
   * @returns {{content, plan, added}} content = 合并后的 assistant 文本
   */
  async function groupTurn(rawCfg, chatId, userInput, history, send) {
    const emit = typeof send === 'function' ? send : () => {};
    let cfg = normalizeConfig(rawCfg);

    const sync = syncRoster(cfg, chatId);
    cfg = sync.cfg;
    if (sync.added.length) emit({ type: 'group-roster', added: sync.added, tier: 'new' });
    if (sync.rejoined && sync.rejoined.length) emit({ type: 'group-roster', added: sync.rejoined, tier: 'known' });

    const mentions = parseMentions(userInput, cfg);
    const shared = await buildSharedLayer(cfg, chatId, userInput, history);

    const plan = await direct(cfg, chatId, userInput, mentions, shared);
    emit({ type: 'group-plan', speakers: plan.speakers.map((s) => s.name), narrator: plan.narrator, fallback: !!plan._fallback });

    const pieces = [];
    for (const s of plan.speakers) {
      emit({ type: 'group-speaking', name: s.name });
      let text = '';
      try {
        text = await speakAs(cfg, chatId, s.name, {
          shared, userInput, maxLines: s.maxLines,
          prior: pieces.join('\n\n'),          // ★ 反应链：看得到前序角色的实际输出
        });
      } catch (e) {
        log(`[group] ${s.name} 发言失败: ${e.message}`);
        emit({ type: 'group-error', name: s.name, error: e.message });
      }
      if (text) { pieces.push(text); emit({ type: 'delta', text: (pieces.length > 1 ? '\n\n' : '') + text }); }
    }

    if (plan.narrator) {
      try {
        const n = await narrate(cfg, chatId, { shared, speech: pieces.join('\n\n') });
        if (n) { pieces.push(n); emit({ type: 'delta', text: '\n\n' + n }); }
      } catch (e) {
        log('[group] 旁白失败: ' + e.message);
      }
    }

    return { content: pieces.join('\n\n'), plan, added: sync.added };
  }

  return {
    normalizeConfig, resolveModel, resolveDirectorModel, syncRoster, identifyRole, parseMentions, candidatesFor,
    buildSharedLayer, buildRoleLayer, direct, speakAs, narrate, groupTurn,
    enforceSpeaker, parseDirectorJson,
    NARRATOR, DEFAULTS,
  };
}

module.exports = { createGroup, DEFAULTS, NARRATOR };
