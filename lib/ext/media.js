// lib/ext/media.js —— M-08·media-consts 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。

const IMG_MODEL_PRESETS = {   // 仅作“模型 id 填什么”的示例提示；实际用哪个由用户填
    kolors:  { id: 'Kwai-Kolors/Kolors',               label: 'Kolors（免费）',       price: '免费' },
    zimage:  { id: 'Tongyi-MAI/Z-Image',               label: 'Z-Image（高质量）',     price: '¥0.30/张' },
    zturb:   { id: 'Tongyi-MAI/Z-Image-Turbo',         label: 'Z-Image-Turbo（快速）', price: '¥0.10/张' },
    qwenimg: { id: 'Qwen/Qwen-Image',                  label: 'Qwen-Image（通用）',    price: '¥0.30/张' },
    ernie:   { id: 'baidu/ERNIE-Image-Turbo',          label: 'ERNIE-Image（快速）',   price: '¥0.11/张' }
  };
  const MIMO_TTS_MODEL = 'mimo-v2.5-tts';
const defaultTtsConfig = () => ({ engine: 'mimo', apiKey: '', voice: 'mimo_default', rate: '1.0', baseURL: '', model: MIMO_TTS_MODEL });

module.exports = { IMG_MODEL_PRESETS, MIMO_TTS_MODEL, defaultTtsConfig };
