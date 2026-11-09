export type AIProtocol = 'openai-responses' | 'anthropic-messages' | 'openai-chat';

export type CommitLanguage = 'auto' | 'zh' | 'en';
export type ResolvedLanguage = 'zh' | 'en';

export interface AIProviderConfig {
  id: string;
  name: string;
  protocol: AIProtocol;
  baseUrl: string;
  models: string[];
  defaultModel?: string;
  customHeaders?: Record<string, string>;
  updatedAt?: number;
}

export interface AIProviderWithKey extends AIProviderConfig {
  apiKey: string;
  hasApiKey: boolean;
}

export interface FetchedModelInfo {
  id: string;
  displayName?: string;
  ownedBy?: string;
}

export interface TemplateLocaleContent {
  name: string;
  description: string;
  badge: string;
  example: string;
  systemPrompt: string;
}

export interface CommitTemplate {
  id: string;
  name: string;
  description: string;
  badge: string;
  icon: string;
  isBuiltIn?: boolean;
  example: string;
  systemPrompt: string;
  locales?: {
    zh: TemplateLocaleContent;
    en: TemplateLocaleContent;
  };
}

export type DiffScope = 'auto' | 'staged' | 'all';

export interface DiffContext {
  repoRoot: string;
  repoName: string;
  branch: string;
  scopeUsed: 'staged' | 'workingTree' | 'all';
  changedFilesCount: number;
  statusSummary: string;
  diffStat: string;
  diffContent: string;
  recentCommits: string[];
  truncated: boolean;
}

export interface ExtensionPreferences {
  activeProviderId: string;
  activeModelId: string;
  activeTemplateId: string;
  commitLanguage: CommitLanguage;
  askTemplateBeforeGenerate: boolean;
  diffScope: DiffScope;
  streamOutput: boolean;
  maxDiffLines: number;
  customInstructions: string;
  showStatusBar: boolean;
}
