# AI Git Message — 智能 Git 提交信息生成插件

在 VS Code **源代码管理 (Source Control)** 标题操作栏（提交 `✓` 按钮左侧）提供一键 AI 生成 Git Commit Message 按钮，支持多套专业提交信息模板切换与自定义，完整支持 **OpenAI Response (`/v1/responses`)** 与 **Anthropic Message (`/v1/messages`)** 协议供应商，并支持通过 `/v1/models` 自动拉取模型列表。

---

## ✨ 核心特性

1. **原生源代码管理操作栏集成 (`scm/title`)**
   - 在「源代码管理 -> 更改」右侧工具栏（`✓` 提交按钮左侧）嵌入原生 `$(sparkle)` 按钮。
   - 点击即可读取当前仓库暂存区（Staged）或工作区（Working Tree）的 Git Diff，并将生成的提交信息**实时流式写入**提交输入框。
   - 生成过程中按钮自动切换为旋转动画，支持随时点击中断取消。
   - 在右侧 `...` 更多菜单与底部状态栏同步提供**切换模板**、**切换模型**、**打开配置中心**快捷入口。

2. **多套内置 Git Message 模板 + 自定义模板库**
   - **约定式提交 (Conventional Commits · 中文)** *(默认)*
   - **Conventional Commits (English)**
   - **Gitmoji 表情符号规范 (中文)**
   - **Gitmoji Conventional (English)**
   - **极简单行模式 (Concise One-Line · 中文)**
   - **详细变更报告 (PR / Changelog 级描述)**
   - **Angular 官方规范模板 (Strict Angular)**
   - **中文团队业务规范 (`[模块] 动作：描述`)**
   - 支持在配置中心一键**复制并修改内置模板**或**新建自定义模板**。

3. **多协议 AI 供应商管理 + 模型列表自动获取**
   - **OpenAI Response 协议 (`POST /v1/responses`)**：支持流式 `response.output_text.delta` 与非流式 `output` 解析。
   - **Anthropic Message 协议 (`POST /v1/messages`)**：支持流式 `content_block_delta` 与非流式 `content` 解析，兼容 `x-api-key` 与 `Bearer` 网关鉴权。
   - **OpenAI Chat Completions 兼容 (`POST /v1/chat/completions`)**：兼容传统中转网关。
   - **自动获取模型列表 (`GET /v1/models`)**：在配置中心或命令面板点击「🔄 自动获取模型列表」即可自动拉取供应商支持的全部模型并支持关键词搜索筛选。
   - **安全密钥存储**：API Key 全程保存在 VS Code 原生 `SecretStorage` 系统级凭据库中，不以明文落盘至 `settings.json`。

---

## 🚀 开发、调试与打包安装

### 1. 安装依赖与编译
```bash
npm install
npm run compile
```

### 2. 在 VS Code 中按 F5 调试运行
1. 使用 VS Code 打开本项目目录 `/Users/chenxiangcai/apps/ai-git-message`。
2. 按下 `F5`（已配置 `.vscode/launch.json`），将启动 **Extension Development Host** 窗口。
3. 打开任意包含 Git 仓库的项目，切到左侧 **源代码管理 (Source Control)** 视图，即可在「更改」行右侧、`✓` 按钮左边看到 `✨` 按钮。

### 3. 打包为 `.vsix` 本地安装
```bash
npx @vscode/vsce package
```
生成 `ai-git-message-1.0.0.vsix` 后，在 VS Code 扩展面板点击右上角 `...` -> **从 VSIX 安装 (Install from VSIX...)** 即可永久安装使用。

