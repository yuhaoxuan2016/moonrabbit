// lib/store/storymemory.js —— M-08·story-memory-config 域（AC12 纯搬运）：自 server.js 整体搬迁，零逻辑改动。
const fs = require('fs');
const path = require('path');
const { writeFileAtomicSync, backupConfig } = require('../core/io');
const { DATA_DIR } = require('../core/paths');
const { State } = require('../core/state');

const STORY_MEMORY_CONFIG_FILE = path.join(DATA_DIR, 'story-memory-config.json');
function loadStoryMemoryConfig() {
  try {
    if (fs.existsSync(STORY_MEMORY_CONFIG_FILE)) {
      State.storyMemoryConfig = { ...State.storyMemoryConfig, ...JSON.parse(fs.readFileSync(STORY_MEMORY_CONFIG_FILE, 'utf8')) };
    }
  } catch (e) { /* 使用默认值 */ }
}
function saveStoryMemoryConfig() {
  try { backupConfig(STORY_MEMORY_CONFIG_FILE); writeFileAtomicSync(STORY_MEMORY_CONFIG_FILE, JSON.stringify(State.storyMemoryConfig, null, 2), 'utf8'); } catch (e) { console.error('保存剧情记忆配置失败:', e.message); }
}

module.exports = { STORY_MEMORY_CONFIG_FILE, loadStoryMemoryConfig, saveStoryMemoryConfig };
