# Moonrabbit —— 通用多角色 RP 界面

> 仓库名：`moonrabbit`（月兔：多角色同台的月光剧场）

> 🤖 **AI 辅助项目**：本项目由 AI 辅助开发与维护（代码审查、文档、测试均由 AI 协作完成）；它同时也是一个 AI 辅助创作工具——用任意 LLM API 驱动多角色互动小说。欢迎其他 AI 开发者 / 人类开发者一起改进。

一个**零依赖**（纯 Node 内置模块）的多角色互动小说 / 角色扮演聊天界面：AI 按「角色名：台词」分段输出，界面自动渲染为头像 + 气泡。支持任意 OpenAI 兼容 / Anthropic 兼容端点。

## 快速开始

```bash
node server.js        # 或双击 start.bat
# 打开 http://127.0.0.1:3081
```

首次使用：点击右上「⚙ API」配置端点（协议 / Base URL / API Key），保存时自动探测验证。

## 配置示例

| 服务 | 协议 | Base URL | 模型示例 |
|---|---|---|---|
| DeepSeek 官方 | Anthropic 兼容 | `https://api.deepseek.com/anthropic/v1` | `deepseek-chat` |
| DeepSeek 官方 | OpenAI 兼容 | `https://api.deepseek.com` | `deepseek-chat` |
| 硅基流动 | OpenAI 兼容 | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| OpenRouter | OpenAI 兼容 | `https://openrouter.ai/api/v1` | `anthropic/claude-3.5-sonnet` |
| 本地 ollama | OpenAI 兼容 | `http://127.0.0.1:11434/v1` | `qwen2.5` |

也可用环境变量：`MOONRABBIT_PORT` / `MOONRABBIT_MODEL` / `MOONRABBIT_BASE` / `MOONRABBIT_API_KEY`。

## 功能

- **多角色渲染**：`角色名：台词` / `角色名（动作）` 自动分段，头像 = 首字徽章（按名字哈希取色，任意角色名即用）
- **世界设定**：右侧文本框填写世界观 / 角色卡 / 规则，随对话注入 system（保存在浏览器 localStorage）
- **会话管理**：新对话 / 自动归档 / 恢复 / 删除（`data/chats/`）
- **剧情记忆**：AI 回复末尾的 `<storyevent>` / `<items>` / `【更新】` 标签自动记账 → 时间线 / 物品栏 / markdown 导出（`data/turns/`）
- **历史检索**：本地关键词全文检索全部历史消息（零 API，多词空格 = AND，命中高亮，可展开全文）
- **自动压缩总结**：历史超阈值（默认 12000 字符）自动把最旧一半压成摘要，缓存复用（`data/summaries/`）
- **视角切换**：输入区上方切换叙事视角（默认=用户角色主观视角，可自定义角色名），注入 system + 记账
- **换装**：侧栏提交角色着装变化，注入 system + 记账
- **重roll / 删除**：AI 回复右上「↻」截断重发、「✕」删除
- **思考链显示**：模型思考过程折叠展示（可关闭）
- **统计栏**：轮次 / 调用 / 耗时 / 首 token / 缓存命中 / token 用量（按模型分桶）
- **峰谷提醒**：DeepSeek 官方直连端点 + 高峰时段（9-12 / 14-18 北京时间）自动提示 + 发送确认（可关闭）
- **主题**：夜空 / 纸面 / 暖夜 / 森林

## 数据文件

运行时数据全部在 `data/`（已 gitignore，不提交）：

```
data/chats/{会话}.json        对话全文（含标题/时间戳）
data/turns/{会话}.jsonl       回合记账（时间线/物品栏数据源）
data/summaries/{会话}.json    自动压缩摘要缓存
data/model.json               端点配置（含 API Key，勿提交）
data/stats.json               调用统计
data/op.json                  视角/换装覆盖状态
```

浏览器内的聊天历史刷新即清；跨会话接续靠「世界设定」文本 + 回合记录导出自行归档。

## 设计原则

- 零依赖：仅使用 Node.js 内置模块（`http` / `fs` / `path`），无需 `npm install`
- 零外部服务：检索/摘要/记账全部本地完成；只有 LLM 调用走你配置的端点
- 内容与平台解耦：不内置任何世界观/角色，一切设定由用户填写

## 相关项目

- 🤖 本项目的开发、测试与文档由运行在 **DeepSeek Harness**（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，"一切皆插件"的开源 Agent 框架）中的 AI 代理协作完成
- 界面接入任意 OpenAI / Anthropic 兼容端点，包括 DeepSeek API
