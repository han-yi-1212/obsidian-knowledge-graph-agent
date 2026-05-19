# Knowledge Graph Agent

基于 Obsidian 的知识图谱 AI 助手，集成 DeepSeek 聊天。可视化你的笔记关联，与能够检索你 vault 中内容的 AI 对话。

## 功能特性

- **交互式知识图谱** — 以力导向图展示笔记之间的链接关系。双击节点打开笔记，右键弹出上下文菜单。
- **RAG 检索增强聊天** — 向 AI 提问，插件会自动检索相关笔记并注入上下文，让回答建立在你的知识体系之上。
- **两阶段检索** — 关键词召回 + 多信号重排序（短语匹配、词距、标题加权），保证检索质量。
- **来源引用** — 每条 AI 回答下方展示引用了哪些笔记，附带相关度分数和内容预览。点击笔记名直接打开。
- **流式响应与停止** — 聊天回复通过 DeepSeek API 逐 token 流式输出。点击 Stop 或按 Enter 可随时中断。
- **友好的错误提示** — 对缺少 API Key、Key 无效（401）、速率限制（429）、网络错误等场景给出清晰的提示。
- **上下文固定** — 右键图谱节点可将笔记固定到聊天上下文，AI 会优先使用你选中的笔记。

## 安装

### 手动安装

1. 从 [Releases](https://github.com/han-yi-1212/obsidian-knowledge-graph-agent/releases) 下载最新版本。
2. 解压到你的 vault 的 `.obsidian/plugins/knowledge-graph-agent/` 目录。
3. 在 Obsidian 的「第三方插件」设置中启用。

### 从源码构建

```bash
git clone https://github.com/han-yi-1212/obsidian-knowledge-graph-agent.git
cd obsidian-knowledge-graph-agent
npm install
npm run build
```

然后将 `main.js`、`styles.css` 和 `manifest.json` 复制到 vault 的 `.obsidian/plugins/knowledge-graph-agent/`。

## 配置项

| 设置 | 说明 | 默认值 |
|---|---|---|
| DeepSeek API Key | 来自 platform.deepseek.com 的 API 密钥 | — |
| Base URL | API 端点（支持自定义代理） | `https://api.deepseek.com` |
| Chat Model | 聊天模型 | `deepseek-chat` |
| Temperature | 回复创造性（0–2） | 0.7 |
| Max Tokens | 最大回复长度 | 4096 |
| Max Context Chunks | 每次查询检索的笔记数 | 10 |
| Chunk Size | 每个文本块的字符数 | 500 |
| Chunk Overlap | 相邻块之间的重叠字符数 | 50 |
| Graph Max Nodes | 图谱最大节点数 | 200 |
| Show Orphans | 显示无链接的孤立笔记 | 关闭 |

## 使用方法

1. 点击左侧功能区的网络图标，或执行「Open Knowledge Graph Agent」命令。
2. 左侧面板显示知识图谱，右侧面板是 AI 聊天区。
3. **搜索节点** — 在工具栏输入关键词，高亮匹配节点。
4. **聊天** — 输入问题并按 Enter。AI 会先检索 vault 再回答，并附上引用来源。
5. **固定上下文** — 右键图谱节点选择「Add to chat context」来固定笔记。固定笔记的优先级高于自动检索结果。

## 隐私说明

- 你的笔记内容仅在作为聊天上下文时，以文本块形式发送到 DeepSeek API，不会离开你的设备之外。
- API 密钥存储在 Obsidian 的本地插件数据中。
- 无任何分析、遥测或第三方服务器，只连接你配置的 API 端点。

## 开发

```bash
npm install         # 安装依赖
npm run dev         # 开发模式（监听文件变更）
npm test            # 运行测试（51 个测试）
npm run test:watch  # 监听模式运行测试
npm run release:zip # 构建并打包为发布 zip
```

## 许可

MIT
