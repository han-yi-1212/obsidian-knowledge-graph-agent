# Knowledge Graph Agent

> Obsidian 知识图谱 AI 助手 —— 可视化你的笔记关联，与理解你 vault 中内容的 AI 对话。

[English](./README.md)

## 功能特性

### 知识图谱
- **力导向图** — 以 Cytoscape.js 可视化笔记之间的 `[[链接]]` 关系，节点大小反映链接数量
- **节点搜索** — 工具栏输入关键词，高亮匹配节点并虚化其余
- **交互操作** — 双击节点打开笔记；右键弹出菜单（打开、分屏打开、添加到聊天上下文）
- **大 vault 优化** — 预建 Map/Set 做 O(1) 查找去重，刷新响应在秒级
- **可配置上限** — `Graph Max Nodes` 控制最大节点数，`Show Orphans` 决定是否显示零链接笔记

### AI 聊天
- **RAG 检索增强** — 每次提问自动从 vault 检索相关笔记，注入 AI 上下文，让回答基于你的知识体系
- **两阶段检索** — 关键词召回（TF-IDF）+ 多信号重排序（短语匹配、词距、标题加权）
- **流式输出** — 通过 DeepSeek API 逐 token 实时输出
- **停止/取消** — 点击 Stop 按钮或按 Enter 随时中断流式输出

### 来源引用
- 每条 AI 回答下方展示 `📚 Sources` 可折叠区域
- **📌 固定笔记** — 显示 Pinned 徽章，代表你手动添加到上下文的笔记，AI 会优先使用
- **🔍 检索笔记** — 显示归一化相关度百分比（0%–100%）和内容片段预览
- 点击任意笔记名直接打开对应文件

### 保存到笔记
- 每条 AI 回复下方有操作按钮：
  - **💾 Save to note** — 在 `AI Responses/` 目录下创建新笔记，包含问题、完整回复和来源引用。文件名由问题自动 slugify，重名自动加 `-2`、`-3` 后缀。
  - **↩ Insert into active note** — 将回复（含来源）插入到当前打开笔记的光标位置。
  - **📎 Append to active note** — 将回复追加到当前打开笔记的末尾。
- 命令 **"Save last AI response to note"** 可直接保存最近一条 AI 回复，无需点击按钮。

### 批量草稿（Draft Notes）
- **📝 Draft 模式切换** — 点击聊天输入框旁的 📝 按钮进入草稿模式，AI 将以 JSON 格式生成结构化笔记草案。
- **计划 → 预览 → 确认** — 描述你想要的笔记（例如 "根据我的知识管理研究创建 5 篇原子笔记"）。AI 返回草案列表，预览窗口展示每篇标题、目标文件夹、内容片段和文件名冲突警告。
- **选择并创建** — 勾选/取消勾选单个草案，点击 **Create all** 或 **Create selected**。笔记在目标文件夹（默认 `AI Notes/`）中创建，重名自动加 `-2`、`-3` 后缀。
- **安全设计** — AI 绝不直接写文件。插件校验每篇草案，展示完整预览，仅在用户确认后才创建文件。
- 新笔记自动加入 RAG 检索引擎，后续搜索可命中。

### 上下文管理
- 右键图谱节点 → Add to chat context 固定笔记
- 点击上下文栏的笔记标签可移除
- 当前打开笔记也会自动加入上下文

### 索引生命周期
- **索引进度** — 启动后显示 `Indexing 45/120 files…`，输入框自动禁用直到完成
- **文件监控** — 新建、修改、删除、重命名笔记自动更新索引
- **脏文件追踪** — 索引构建期间的文件变更不会丢失，构建完成后自动补索引
- **设置热更新** — 修改 Chunk Size 等参数会触发自动重建，无需重启

### 错误处理
- 未配置 API Key → 提示去设置页配置
- API Key 无效（401）→ 提示检查或重新生成
- 速率限制（429）→ 提示稍后重试
- 网络错误 → 提示检查网络和 Base URL 设置

## 安装

### 从 Release 安装

1. 从 [Releases](https://github.com/han-yi-1212/obsidian-knowledge-graph-agent/releases) 下载 `obsidian-knowledge-graph-agent.zip`
2. 解压到 vault 的 `.obsidian/plugins/knowledge-graph-agent/` 目录
3. 在 Obsidian 设置 → 第三方插件中启用

### 从源码构建

```bash
git clone https://github.com/han-yi-1212/obsidian-knowledge-graph-agent.git
cd obsidian-knowledge-graph-agent
npm install
npm run build        # 编译插件
npm run release:zip  # 打包为 release zip
```

将 `main.js`、`styles.css`、`manifest.json` 复制到 `.obsidian/plugins/knowledge-graph-agent/`。

## 配置

| 设置项 | 说明 | 默认值 |
|---|---|---|
| **DeepSeek API Key** | 从 [platform.deepseek.com](https://platform.deepseek.com) 获取 | — |
| **Base URL** | API 端点地址，支持自定义代理 | `https://api.deepseek.com` |
| **Chat Model** | 使用的聊天模型 | `deepseek-chat` |
| **Temperature** | 回复的创造性（0 = 严谨，2 = 发散） | 0.7 |
| **Max Tokens** | 单次回复最大 token 数 | 4096 |
| **Max Context Chunks** | 每次查询检索的笔记片段数 | 10 |
| **Chunk Size** | 文本分块的字符数（修改会触发重建索引） | 500 |
| **Chunk Overlap** | 相邻块之间的重叠字符数（修改会触发重建索引） | 50 |
| **Graph Max Nodes** | 图谱最多展示的节点数 | 200 |
| **Show Orphans** | 是否显示无链接的孤立笔记 | 关闭 |

## 使用指南

### 基本工作流

1. 点击左侧功能区 🕸️ 图标，或执行命令 `Open Knowledge Graph Agent`
2. 左侧为知识图谱面板，右侧为 AI 聊天面板
3. 在聊天框输入问题，按 Enter 发送
4. AI 先检索 vault 中相关笔记，再结合上下文回答，并附上引用来源

### 图谱操作

| 操作 | 效果 |
|---|---|
| 双击节点 | 打开对应笔记 |
| 右键节点 | 弹出菜单（打开 / 分屏打开 / 加入聊天上下文） |
| 工具栏搜索 | 高亮匹配节点 |
| Refresh 按钮 | 重新从 vault 读取数据刷新图谱 |
| Fit 按钮 | 缩放适配窗口 |

### 聊天技巧

- **直接提问** — "我的知识管理体系中有什么问题？"AI 会基于 vault 内容回答
- **固定上下文** — 先右键图谱固定几篇关键笔记，再提问，AI 会优先参考它们
- **跨笔记关联** — "A 和 B 之间有什么关系？"AI 会结合检索到的内容分析关联
- **随时中断** — 流式输出中按 Stop 或 Enter 即可停止
- **保存好回答** — 点击 **💾 Save to note** 保存为永久笔记，或 **📎 Append** 追加到你的日记里
- **批量生成笔记** — 点击 **📝** 后描述想要的笔记，AI 生成结构化草案，审核确认后批量创建

### 来源引用

每条 AI 回答下方有 `📚 Sources` 区域：

- 点击横条展开/折叠详细列表
- **📌 Pinned Notes** — 手动固定的笔记（最高优先级）
- **🔍 Retrieved Notes** — 自动检索匹配的笔记
- 每项显示笔记名（可点击打开）和相关度分数或 Pinned 标签
- 内容片段展示检索到的具体文本

## 隐私与安全

- 笔记内容仅在聊天时以文本块形式发送到 DeepSeek API，不会上传到其他任何服务器
- API Key 存储在 Obsidian 本地插件数据中
- 无埋点、无遥测、无第三方服务
- 所有索引数据在内存中，关闭 Obsidian 后消失

## 开发

```bash
npm install         # 安装依赖
npm run dev         # 开发模式（文件变更自动编译）
npm test            # 运行测试（当前 51 个）
npm run test:watch  # 监听模式
npm run build       # 生产构建
npm run release:zip # 构建并打包为可发布 zip
```

### 项目结构

```
├── main.ts                  # 插件入口，生命周期管理
├── src/
│   ├── api.ts               # DeepSeek API 客户端（流式 + 非流式）
│   ├── chat-view.ts         # 聊天面板视图
│   ├── graph-view.ts        # 知识图谱视图（Cytoscape.js）
│   ├── rag.ts               # RAG 检索引擎（索引管理 + 状态机）
│   ├── retrieval.ts         # 纯检索函数（tokenize / chunk / search / rerank）
│   ├── retrieval.test.ts    # 检索函数测试（36 个）
│   ├── rag.test.ts          # 索引生命周期测试（15 个）
│   ├── settings.ts          # 设置面板
│   ├── types.ts             # 类型定义
│   └── __mocks__/
│       └── obsidian.ts      # Obsidian API mock（用于测试）
├── styles.css               # 界面样式
├── manifest.json            # Obsidian 插件清单
└── versions.json            # BRAT 版本兼容表
```

## 已知局限

- 暂未使用 embedding 语义检索，当前为关键词 + 重排序
- 图谱在 >500 节点时布局速度可能较慢
- 聊天历史仅在当前会话保留，重启 Obsidian 后清空
- 暂不支持选择不同 AI 提供商（仅 DeepSeek）

## 许可

MIT
