import { AIProtocol, CommitTemplate, ResolvedLanguage } from './types';

export const PROTOCOL_METADATA: Record<
  AIProtocol,
  {
    label: string;
    labelEn: string;
    shortBadge: string;
    description: string;
    descriptionEn: string;
    defaultBaseUrl: string;
    endpointPath: string;
  }
> = {
  'openai-responses': {
    label: 'OpenAI Response 协议 (/v1/responses)',
    labelEn: 'OpenAI Response Protocol (/v1/responses)',
    shortBadge: 'OpenAI Response',
    description: '标准 OpenAI Responses API 协议，请求端点为 POST /v1/responses',
    descriptionEn: 'Standard OpenAI Responses API (POST /v1/responses)',
    defaultBaseUrl: 'https://api.openai.com/v1',
    endpointPath: '/v1/responses'
  },
  'anthropic-messages': {
    label: 'Anthropic Message 协议 (/v1/messages)',
    labelEn: 'Anthropic Message Protocol (/v1/messages)',
    shortBadge: 'Anthropic Message',
    description: '标准 Anthropic Messages API 协议，请求端点为 POST /v1/messages',
    descriptionEn: 'Standard Anthropic Messages API (POST /v1/messages)',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    endpointPath: '/v1/messages'
  },
  'openai-chat': {
    label: 'OpenAI Chat 兼容 (/v1/chat/completions)',
    labelEn: 'OpenAI Chat Compatible (/v1/chat/completions)',
    shortBadge: 'OpenAI Chat',
    description: '传统 OpenAI Chat Completions 协议，请求端点为 POST /v1/chat/completions',
    descriptionEn: 'Legacy OpenAI Chat Completions API (POST /v1/chat/completions)',
    defaultBaseUrl: 'https://api.openai.com/v1',
    endpointPath: '/v1/chat/completions'
  }
};

export function getBaseSystemRules(lang: ResolvedLanguage): string {
  if (lang === 'en') {
    return `You are a senior software engineer and Git version control expert.
Based on the provided Git changes (file status list, diff stat, and code diff), generate an accurate, clean, high-quality Git Commit Message.

[STRICT OUTPUT RULES]
1. Output ONLY the final Git Commit Message text itself. Never include greetings, explanations, or conversational prefixes/suffixes.
2. NEVER wrap the output in \`\`\`, \`\`\`text, or \`\`\`git markdown code fences.
3. Capture the true intent of the code changes (why and what core logic changed), rather than mechanically listing trivial syntax edits.
4. Write the commit message in English.`;
  }

  return `你是一位资深软件工程师与 Git 版本控制专家。
请根据提供的 Git 变更信息（文件状态列表、Diff 统计及具体代码 Diff），生成精准、规范、高质量的 Git Commit Message。

【严格输出铁律】
1. 只输出最终的 Git Commit Message 正文内容本身，绝对不要输出任何寒暄、解释说明或前后缀提示语。
2. 绝对不要使用 \`\`\`、\`\`\`text、\`\`\`git 等 Markdown 代码块包裹输出。
3. 准确把握代码的真实意图（为什么改、改了什么核心逻辑），不要机械罗列每一行无关紧要的语法变动。
4. 提交信息描述请使用中文（type 与 scope 保持标准英文小写标识）。`;
}

export const BUILT_IN_TEMPLATES: CommitTemplate[] = [
  {
    id: 'conventional',
    name: '约定式提交 (Conventional Commits)',
    description: '遵循标准 Conventional Commits 规范，包含 type(scope): 简短摘要 + 核心改动列表',
    badge: '默认推荐',
    icon: '$(git-commit)',
    isBuiltIn: true,
    example: '',
    systemPrompt: '',
    locales: {
      zh: {
        name: '约定式提交 (Conventional Commits)',
        description: '遵循标准 Conventional Commits 规范，包含 type(scope): 中文简短摘要 + 详细改动要点列表',
        badge: '默认推荐',
        example: `feat(auth): 新增 OAuth2 令牌自动刷新与过期重试机制

- 在请求拦截器中检测 401 状态码并触发静默刷新队列
- 新增 TokenStorage 安全持久化存储刷新令牌
- 补充并发请求下的令牌刷新单元测试`,
        systemPrompt: `请严格遵循 Conventional Commits（约定式提交）中文规范生成提交信息：

【格式结构】
<type>(<scope>): <中文简短摘要（不超过 50 字，结尾不加句号）>

- <核心变更点 1>
- <核心变更点 2>

【Type 类型选择】
feat, fix, refactor, perf, style, docs, test, build, ci, chore, revert

【要求】
- scope 填写受影响的核心模块名或组件名（英文小写）；若跨多个全局模块可省略括号。
- 如果变更非常简单（仅 1 个小改动），可只保留第一行标题；若有多个改动点，请空一行后用 "- " 列出核心中文改动。`
      },
      en: {
        name: 'Conventional Commits',
        description: 'Standard Conventional Commits with imperative summary and concise bullet points',
        badge: 'Recommended',
        example: `feat(auth): add automatic OAuth2 token refresh and retry queue

- intercept 401 responses and queue pending requests during token refresh
- persist refresh tokens securely via SecretStorage
- add unit tests for concurrent token refresh scenarios`,
        systemPrompt: `Generate a Git commit message strictly following the Conventional Commits specification in English:

[Format]
<type>(<scope>): <imperative summary in lowercase, max 72 chars, no trailing period>

- <concise bullet point explaining key change 1>
- <concise bullet point explaining key change 2>

[Allowed Types]
feat, fix, refactor, perf, style, docs, test, build, ci, chore, revert

[Rules]
- Use the imperative mood in the subject line (e.g., "add", "fix", "update").
- If the change is trivial, output only the subject line; otherwise include a blank line followed by concise bullet points.`
      }
    }
  },
  {
    id: 'gitmoji',
    name: 'Gitmoji 表情符号规范',
    description: '结合语义化 Gitmoji 图标与 Conventional Commits，直观醒目',
    badge: 'Gitmoji',
    icon: '$(smiley)',
    isBuiltIn: true,
    example: '',
    systemPrompt: '',
    locales: {
      zh: {
        name: 'Gitmoji 表情符号规范',
        description: '结合语义化 Gitmoji 图标与 Conventional Commits，直观醒目，适合现代研发团队',
        badge: 'Gitmoji',
        example: `✨ feat(scm): 在源代码管理标题栏新增 AI 提交信息生成按钮

- 🔌 接入 VS Code Git 扩展 API 自动读取暂存区与工作区 Diff
- 🎨 支持实时流式将生成内容写入 SCM 输入框
- 🔒 使用 SecretStorage 安全保存供应商密钥`,
        systemPrompt: `请使用 Gitmoji + Conventional Commits 中文规范生成提交信息：

【格式结构】
<emoji> <type>(<scope>): <中文简短摘要（不超过 50 字）>

- <要点 1>
- <要点 2>

【常用 Gitmoji 映射参考】
✨ feat | 🐛 fix | ♻️ refactor | ⚡️ perf | 💄 style/ui | 📝 docs | ✅ test | 🔧 build/config | 🔥 remove | 🔒️ security

【要求】
- 标题行必须以最匹配的一个 Gitmoji 开头，紧跟空格与 type(scope): 中文描述。
- 若变更包含多个要点，空一行后用 "- " 列出简洁明了的中文改动项。`
      },
      en: {
        name: 'Gitmoji Conventional',
        description: 'Expressive Gitmoji prefix combined with Conventional Commits specification',
        badge: 'Gitmoji',
        example: `✨ feat(scm): add AI commit message generator button in SCM toolbar

- 🔌 integrate VS Code Git extension API to read staged and working tree diffs
- 🎨 stream generated commit messages into the SCM input box in real time
- 🔒 store provider API keys securely in SecretStorage`,
        systemPrompt: `Generate a Git commit message using Gitmoji + Conventional Commits in English:

[Format]
<emoji> <type>(<scope>): <imperative summary in English, max 72 chars>

- <bullet point 1>
- <bullet point 2>

[Emoji Reference]
✨ feat | 🐛 fix | ♻️ refactor | ⚡️ perf | 💄 style | 📝 docs | ✅ test | 🔧 chore/config | 🔥 remove | 🔒️ security

[Rules]
- Use imperative mood in English. Omit the body if the change is a single small modification.`
      }
    }
  },
  {
    id: 'concise',
    name: '极简单行模式 (Concise One-Line)',
    description: '仅生成一行精炼的 type(scope): 摘要，不含多行正文，适合高频敏捷提交',
    badge: '单行极速',
    icon: '$(zap)',
    isBuiltIn: true,
    example: '',
    systemPrompt: '',
    locales: {
      zh: {
        name: '极简单行模式 (Concise One-Line)',
        description: '仅生成一行精炼的 type(scope): 中文摘要，不含多行正文，适合高频敏捷提交',
        badge: '单行极速',
        example: `feat(models): 支持通过 /v1/models 自动获取供应商模型列表并一键切换`,
        systemPrompt: `请只生成【单行】精炼的中文 Git Commit Message：

【格式结构】
<type>(<scope>): <一句话概括核心改动，不超过 50 字，不加句号>

【可选 type】
feat, fix, refactor, perf, style, docs, test, build, ci, chore

【严格要求】
- 必须且只能输出一行文本，严禁输出换行或正文列表。`
      },
      en: {
        name: 'Concise One-Line',
        description: 'Single-line summary only without body text, ideal for quick atomic commits',
        badge: 'One-Liner',
        example: `feat(models): auto-fetch provider model list via /v1/models endpoint`,
        systemPrompt: `Generate strictly a SINGLE-LINE Git commit message in English:

[Format]
<type>(<scope>): <concise imperative summary under 72 chars, no period>

[Allowed Types]
feat, fix, refactor, perf, style, docs, test, build, ci, chore

[Strict Rule]
- Output ONLY one single line. Never include a body or bullet points.`
      }
    }
  },
  {
    id: 'changelog',
    name: '详细变更报告 (Detailed Changelog)',
    description: '结构化梳理变更背景、核心改动与影响范围，适合重要特性合并与大型提交',
    badge: '详细报告',
    icon: '$(note)',
    isBuiltIn: true,
    example: '',
    systemPrompt: '',
    locales: {
      zh: {
        name: '详细变更报告 (Detailed Changelog)',
        description: '结构化梳理【变更概述】【核心改动】【影响范围】，适合重要特性合并与大型提交',
        badge: '详细报告',
        example: `feat(ai-client): 重构多协议 AI 客户端并支持流式输出

【变更概述】
引入统一的 AI 协议适配层，完整支持 OpenAI Response 与 Anthropic Message 两大主流协议。

【核心改动】
- 新增：实现 OpenAI /v1/responses 与 Anthropic /v1/messages 的 SSE 流式解析器
- 新增：支持调用 /v1/models 自动拉取可用模型列表
- 优化：针对超长 Git Diff 实现按文件状态与重要度智能截断

【影响范围】
- AI 客户端调用层、供应商管理配置中心与 SCM 状态同步`,
        systemPrompt: `请生成一份结构清晰、详尽的中文 Git Commit Message 变更报告：

【格式结构】
<type>(<scope>): <总体摘要标题>

【变更概述】
<1~2 句话说明本次提交的核心目的或解决的问题>

【核心改动】
- <按“新增 / 修改 / 修复 / 重构 / 移除”分类列出关键改动点>

【影响范围】
- <说明涉及的模块、组件或潜在注意点（如无可省略此小节）>`
      },
      en: {
        name: 'Detailed Changelog (PR Style)',
        description: 'Structured summary with Context, Key Changes, and Impact for major feature commits',
        badge: 'Detailed',
        example: `feat(ai-client): implement multi-protocol AI client with SSE streaming

[Overview]
Introduce a unified protocol layer supporting both OpenAI Responses and Anthropic Messages APIs.

[Key Changes]
- Added: SSE stream parser for /v1/responses and /v1/messages endpoints
- Added: Automatic model discovery via /v1/models
- Improved: Smart Git diff truncation preserving file stats and core hunks

[Impact]
- AI client layer, provider settings center, and SCM input synchronization`,
        systemPrompt: `Generate a structured, detailed Git commit message in English:

[Format]
<type>(<scope>): <high-level imperative summary>

[Overview]
<1-2 sentences describing the purpose or motivation of this change>

[Key Changes]
- <Categorized bullet points: Added / Changed / Fixed / Refactored>

[Impact]
- <Affected modules or compatibility notes (omit if none)>`
      }
    }
  },
  {
    id: 'angular',
    name: 'Angular 官方规范 (Angular Convention)',
    description: '严格遵循 Angular Commit Guideline，包含 Header、Motivation Body 及 Breaking Changes',
    badge: 'Angular 标准',
    icon: '$(shield)',
    isBuiltIn: true,
    example: '',
    systemPrompt: '',
    locales: {
      zh: {
        name: 'Angular 规范模板 (Angular Convention)',
        description: '遵循 Angular Commit Guideline 三段式结构（标题 + 动机对比正文 + 破坏性变更注脚）',
        badge: 'Angular 标准',
        example: `feat(scm): 在源代码管理标题栏集成内联 AI 提交生成按钮

此前用户需要手动复制 git diff 或通过命令面板生成提交信息，步骤繁琐。本次更新直接在 SCM 标题栏提供原生图标按钮，实现一键流式生成。`,
        systemPrompt: `请遵循 Angular Commit Message Guideline 的三段式规范生成中文提交信息：

【结构】
<type>(<scope>): <简短中文摘要>

<正文段落：说明本次修改的动机，以及与修改前行为的对比>

<页脚（可选）：仅在存在 BREAKING CHANGE 时注明>

【要求】
1. type 必须属于：build, ci, docs, feat, fix, perf, refactor, test。
2. 正文应聚焦于“为什么要做这次改动”而非单纯重复代码。`
      },
      en: {
        name: 'Angular Convention (Strict)',
        description: 'Strictly follows Angular Commit Message Guidelines (Header, Motivation Body, Footer)',
        badge: 'Angular',
        example: `feat(scm): integrate inline AI commit generator action into SCM toolbar

Previously developers had to invoke commit generation from the command palette. Adding a native action button in the SCM title bar enables single-click commit message generation.`,
        systemPrompt: `Generate a commit message strictly following the Angular Commit Message Guidelines in English:

[Structure]
<type>(<scope>): <short imperative summary>

<body: explain the motivation for the change and contrast it with previous behavior>

<footer (optional): include only for BREAKING CHANGE notes>

[Rules]
1. Type must be one of: build, ci, docs, feat, fix, perf, refactor, test.
2. Summary must use imperative present tense, lowercase first letter, no trailing period.`
      }
    }
  },
  {
    id: 'module',
    name: '模块化业务规范 ([模块] 动作：描述)',
    description: '研发团队常用的方括号模块前缀风格，直观展示业务模块与变更性质',
    badge: '团队规范',
    icon: '$(organization)',
    isBuiltIn: true,
    example: '',
    systemPrompt: '',
    locales: {
      zh: {
        name: '模块化业务规范 ([模块] 动作：描述)',
        description: '国内研发团队常用的方括号模块前缀风格，直观展示业务模块与变更性质',
        badge: '团队规范',
        example: `[供应商中心] 新增：支持 OpenAI Response 与 Anthropic Message 协议配置

1. 新增供应商协议切换器与 Base URL 智能补全预览
2. 支持一键请求 /v1/models 自动拉取并筛选模型
3. 新增供应商连接连通性测试与耗时展示`,
        systemPrompt: `请按照研发团队的中文模块化规范生成 Git Commit Message：

【格式结构】
[<模块名称>] <动作类型>：<核心变更摘要（不超过 45 字）>

1. <具体改动说明 1>
2. <具体改动说明 2>

【动作类型】
新增 | 修复 | 优化 | 重构 | 样式 | 文档 | 配置 | 测试

【要求】
- 方括号内使用简短中文或模块名概括所属模块（例如：[源代码管理]、[AI接口]、[配置中心]）。
- 如果改动极小（仅单点修改），可省略下方的编号列表。`
      },
      en: {
        name: 'Module Prefix Convention ([Module] Action: Summary)',
        description: 'Bracketed module prefix format clearly highlighting business module and action type',
        badge: 'Team Style',
        example: `[Provider Center] Add: support OpenAI Response and Anthropic Message protocols

1. Add protocol selector and live endpoint URL preview
2. Support automatic model discovery via /v1/models
3. Add provider connectivity test with latency metrics`,
        systemPrompt: `Generate a Git commit message using the Bracketed Module Prefix convention in English:

[Format]
[<Module Name>] <Action>: <concise summary under 65 chars>

1. <key change detail 1>
2. <key change detail 2>

[Allowed Actions]
Add | Fix | Optimize | Refactor | Style | Docs | Config | Test

[Rules]
- Place the affected module or component name inside square brackets.
- Omit the numbered list if the change is a single minor edit.`
      }
    }
  }
];

/**
 * 根据目标语言返回已填充对应中英文名称、示例与提示词的内置模板列表
 */
export function getLocalizedBuiltInTemplates(lang: ResolvedLanguage): CommitTemplate[] {
  return BUILT_IN_TEMPLATES.map((tpl) => {
    const loc = tpl.locales ? tpl.locales[lang] : undefined;
    if (!loc) {
      return tpl;
    }
    return {
      ...tpl,
      name: loc.name,
      description: loc.description,
      badge: loc.badge,
      example: loc.example,
      systemPrompt: loc.systemPrompt
    };
  });
}
