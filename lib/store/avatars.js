// lib/store/avatars.js —— M-08·avatars-store 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync, backupConfig } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');

const AVATAR_CUSTOM_DIR = path.join(DATA_DIR, '自定义头像');
const AVATAR_CUSTOM_FILE = path.join(DATA_DIR, 'avatar-custom.json');
function saveAvatarCustom() { writeFileAtomicSync(AVATAR_CUSTOM_FILE, JSON.stringify(State.avatarCustom, null, 2), 'utf8'); }
const NPC_PROFILES_DIR = path.join(DATA_DIR, 'npc-profiles');
function loadNpcProfile(name) {
  try { const f = path.join(NPC_PROFILES_DIR, `${name}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { return null; }
}
function saveNpcProfile(name, data) {
  try { backupConfig(path.join(NPC_PROFILES_DIR, `${name}.json`)); writeFileAtomicSync(path.join(NPC_PROFILES_DIR, `${name}.json`), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('保存角色档案失败:', name, e.message); }
}
function listNpcProfiles() {
  try { return fs.readdirSync(NPC_PROFILES_DIR).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(NPC_PROFILES_DIR, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; }
}
const SCENES_DIR = path.join(DATA_DIR, 'scenes');
function loadScene(name) {
  try { const f = path.join(SCENES_DIR, `${name}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { return null; }
}
function saveScene(name, data) {
  try { backupConfig(path.join(SCENES_DIR, `${name}.json`)); writeFileAtomicSync(path.join(SCENES_DIR, `${name}.json`), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { console.error('保存场景档案失败:', name, e.message); }
}
function listScenes() {
  try { return fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(SCENES_DIR, f), 'utf8')); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; }
}
const EXPRESSIONS_DIR = path.join(DATA_DIR, 'expressions');
const EXPRESSION_CONFIG = path.join(EXPRESSIONS_DIR, '_config.json');
function saveExpressionConfig() { try { writeFileAtomicSync(EXPRESSION_CONFIG, JSON.stringify({ emotionMap: State.emotionMap, enableAutoSwitch: State.enableAutoSwitch }, null, 2), 'utf8'); } catch (e) { console.error('保存表情配置失败:', e.message); } }
function listExpressions(charName) {
  try { const d = path.join(EXPRESSIONS_DIR, charName); return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f)).map(f => ({ name: f.replace(/\.[^.]+$/, ''), file: f, url: `/api/expressions/static/${encodeURIComponent(charName)}/${encodeURIComponent(f)}` })) : []; } catch (e) { return []; }
}
function pngCreateWithTextChunk(imageBuffer, keyword, text) {
    try {
      const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (!imageBuffer.slice(0, 8).equals(sig)) return null;
      const keywordBuf = Buffer.from(keyword, 'ascii');
      const textBuf = Buffer.from(text, 'utf8');
      const chunkData = Buffer.concat([keywordBuf, Buffer.from([0]), textBuf]);
      const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(chunkData.length, 0);
      const typeBuf = Buffer.from('tEXt', 'ascii');
      const crcData = Buffer.concat([typeBuf, chunkData]);
      const _t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _t[n] = c >>> 0; }
      let crc = 0xFFFFFFFF; for (let i = 0; i < crcData.length; i++) crc = _t[(crc ^ crcData[i]) & 0xFF] ^ (crc >>> 8); crc = (crc ^ 0xFFFFFFFF) >>> 0;
      const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc, 0);
      const textChunk = Buffer.concat([lenBuf, typeBuf, chunkData, crcBuf]);
      let iendPos = -1, pos = 8;
      while (pos < imageBuffer.length - 12) { const len = imageBuffer.readUInt32BE(pos); if (len > imageBuffer.length - pos - 12 || len < 0) break; const type = imageBuffer.slice(pos + 4, pos + 8).toString('ascii'); if (type === 'IEND') { iendPos = pos; break; } pos += 12 + len; }
      if (iendPos < 0) return null;
      return Buffer.concat([imageBuffer.slice(0, iendPos), textChunk, imageBuffer.slice(iendPos)]);
    } catch (e) { return null; }
  }
  function pngReadTextChunks(buffer) {
    const chunks = [];
    try {
      const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      if (!buffer.slice(0, 8).equals(sig)) return chunks;
      let pos = 8;
      while (pos < buffer.length - 12) {
        const len = buffer.readUInt32BE(pos);
        // 防止恶意 PNG：chunk 长度不能超过剩余 buffer
        if (len > buffer.length - pos - 12 || len < 0) break;
        const type = buffer.slice(pos + 4, pos + 8).toString('ascii');
        const data = buffer.slice(pos + 8, pos + 8 + len);
        if (type === 'tEXt') {
          const nullIdx = data.indexOf(0);
          if (nullIdx > 0) chunks.push({ keyword: data.slice(0, nullIdx).toString('ascii'), text: data.slice(nullIdx + 1).toString('utf8') });
        }
        pos += 12 + len;
      }
    } catch (e) {}
    return chunks;
  }

module.exports = { AVATAR_CUSTOM_DIR, AVATAR_CUSTOM_FILE, saveAvatarCustom, NPC_PROFILES_DIR, loadNpcProfile, saveNpcProfile, listNpcProfiles, SCENES_DIR, loadScene, saveScene, listScenes, EXPRESSIONS_DIR, EXPRESSION_CONFIG, saveExpressionConfig, listExpressions, pngCreateWithTextChunk, pngReadTextChunks };
