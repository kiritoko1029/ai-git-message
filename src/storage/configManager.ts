import * as vscode from 'vscode';
import * as crypto from 'crypto';
import {
  AIProviderConfig,
  AIProviderWithKey,
  CommitLanguage,
  CommitTemplate,
  DiffScope,
  ExtensionPreferences,
  ResolvedLanguage
} from '../types';
import { getLocalizedBuiltInTemplates } from '../constants';
import { normalizeTemplateId, resolveCommitLanguage, t } from '../i18n';

const CONFIG_SECTION = 'aiGitMessage';
const SECRET_PREFIX = 'aiGitMessage.provider.apiKey.';

export class ConfigManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(CONFIG_SECTION)) {
          this._onDidChange.fire();
        }
      })
    );
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  /**
   * 获取全部偏好设置
   */
  public getPreferences(): ExtensionPreferences {
    const cfg = this.config;
    const rawTplId = cfg.get<string>('activeTemplateId', 'conventional');
    return {
      activeProviderId: cfg.get<string>('activeProviderId', ''),
      activeModelId: cfg.get<string>('activeModelId', ''),
      activeTemplateId: normalizeTemplateId(rawTplId),
      commitLanguage: cfg.get<CommitLanguage>('commitLanguage', 'auto'),
      askTemplateBeforeGenerate: cfg.get<boolean>('askTemplateBeforeGenerate', false),
      diffScope: cfg.get<DiffScope>('diffScope', 'auto'),
      streamOutput: cfg.get<boolean>('streamOutput', true),
      maxDiffLines: cfg.get<number>('maxDiffLines', 1500),
      customInstructions: cfg.get<string>('customInstructions', ''),
      showStatusBar: cfg.get<boolean>('showStatusBar', true)
    };
  }

  /**
   * 获取当前实际生效的模板与提交语言 ('zh' | 'en')
   */
  public getResolvedCommitLanguage(): ResolvedLanguage {
    const prefs = this.getPreferences();
    return resolveCommitLanguage(prefs.commitLanguage);
  }

  /**
   * 更新单项或多项偏好设置
   */
  public async updatePreferences(partial: Partial<ExtensionPreferences>): Promise<void> {
    const cfg = this.config;
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        await cfg.update(key, value, vscode.ConfigurationTarget.Global);
      }
    }
    this._onDidChange.fire();
  }

  /**
   * 获取所有已配置的 AI 供应商（不含密钥）
   */
  public getProviders(): AIProviderConfig[] {
    const raw = this.config.get<AIProviderConfig[]>('providers', []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol || 'openai-responses',
      baseUrl: p.baseUrl || '',
      models: Array.isArray(p.models) ? p.models : [],
      defaultModel: p.defaultModel || (Array.isArray(p.models) ? p.models[0] : ''),
      customHeaders: p.customHeaders || {},
      updatedAt: p.updatedAt
    }));
  }

  /**
   * 获取包含 SecretStorage API Key 的全部供应商信息
   */
  public async getProvidersWithKeys(): Promise<AIProviderWithKey[]> {
    const providers = this.getProviders();
    const results: AIProviderWithKey[] = [];
    for (const p of providers) {
      const apiKey = (await this.getProviderApiKey(p.id)) || '';
      results.push({
        ...p,
        apiKey,
        hasApiKey: apiKey.trim().length > 0
      });
    }
    return results;
  }

  /**
   * 获取单个供应商的 API Key
   */
  public async getProviderApiKey(providerId: string): Promise<string> {
    if (!providerId) {
      return '';
    }
    return (await this.context.secrets.get(`${SECRET_PREFIX}${providerId}`)) || '';
  }

  /**
   * 保存或新增供应商配置（并将 API Key 存入 SecretStorage）
   */
  public async upsertProvider(
    input: Omit<AIProviderConfig, 'id'> & { id?: string; apiKey?: string },
    setAsActive = false
  ): Promise<AIProviderConfig> {
    const providers = this.getProviders();
    const id = input.id || `provider_${crypto.randomUUID().slice(0, 8)}`;
    const models = Array.from(new Set((input.models || []).map((m) => m.trim()).filter(Boolean)));
    const defaultModel =
      input.defaultModel && models.includes(input.defaultModel)
        ? input.defaultModel
        : input.defaultModel?.trim() || models[0] || '';

    if (defaultModel && !models.includes(defaultModel)) {
      models.unshift(defaultModel);
    }

    const record: AIProviderConfig = {
      id,
      name: input.name.trim() || t('未命名供应商', 'Unnamed Provider'),
      protocol: input.protocol,
      baseUrl: input.baseUrl.trim(),
      models,
      defaultModel,
      customHeaders: input.customHeaders || {},
      updatedAt: Date.now()
    };

    const existingIdx = providers.findIndex((p) => p.id === id);
    if (existingIdx >= 0) {
      providers[existingIdx] = record;
    } else {
      providers.push(record);
    }

    await this.config.update('providers', providers, vscode.ConfigurationTarget.Global);

    if (input.apiKey !== undefined) {
      const trimmedKey = input.apiKey.trim();
      if (trimmedKey) {
        await this.context.secrets.store(`${SECRET_PREFIX}${id}`, trimmedKey);
      } else {
        await this.context.secrets.delete(`${SECRET_PREFIX}${id}`);
      }
    }

    const prefs = this.getPreferences();
    if (setAsActive || !prefs.activeProviderId || providers.length === 1) {
      const nextActiveModel =
        defaultModel ||
        (prefs.activeProviderId === id && models.includes(prefs.activeModelId)
          ? prefs.activeModelId
          : '');
      await this.updatePreferences({
        activeProviderId: id,
        activeModelId: nextActiveModel
      });
    } else if (prefs.activeProviderId === id) {
      if (defaultModel && defaultModel !== prefs.activeModelId) {
        await this.updatePreferences({
          activeModelId: defaultModel
        });
      } else if (models.length === 0 && prefs.activeModelId) {
        await this.updatePreferences({
          activeModelId: ''
        });
      } else if (models.length > 0 && !models.includes(prefs.activeModelId)) {
        await this.updatePreferences({
          activeModelId: defaultModel || models[0]
        });
      }
    }

    this._onDidChange.fire();
    return record;
  }

  /**
   * 删除供应商配置及其密钥
   */
  public async deleteProvider(providerId: string): Promise<void> {
    const providers = this.getProviders().filter((p) => p.id !== providerId);
    await this.config.update('providers', providers, vscode.ConfigurationTarget.Global);
    await this.context.secrets.delete(`${SECRET_PREFIX}${providerId}`);

    const prefs = this.getPreferences();
    if (prefs.activeProviderId === providerId) {
      const nextProvider = providers[0];
      await this.updatePreferences({
        activeProviderId: nextProvider ? nextProvider.id : '',
        activeModelId: nextProvider ? nextProvider.defaultModel || nextProvider.models[0] || '' : ''
      });
    }
    this._onDidChange.fire();
  }

  /**
   * 获取当前激活的供应商（含 API Key）及模型
   */
  public async getActiveProviderAndModel(): Promise<{
    provider: AIProviderWithKey | undefined;
    modelId: string;
  }> {
    const providers = await this.getProvidersWithKeys();
    const prefs = this.getPreferences();

    let provider = providers.find((p) => p.id === prefs.activeProviderId);
    if (!provider && providers.length > 0) {
      provider = providers[0];
    }

    const validActiveModel =
      provider &&
      prefs.activeModelId &&
      (provider.models.length === 0 || provider.models.includes(prefs.activeModelId))
        ? prefs.activeModelId
        : '';

    const modelId =
      validActiveModel ||
      provider?.defaultModel ||
      provider?.models[0] ||
      '';

    return { provider, modelId };
  }

  /**
   * 设置当前激活的供应商与模型
   */
  public async setActiveProviderAndModel(providerId: string, modelId: string): Promise<void> {
    const providers = this.getProviders();
    const target = providers.find((p) => p.id === providerId);
    if (target && modelId) {
      if (!target.models.includes(modelId)) {
        target.models.unshift(modelId);
      }
      target.defaultModel = modelId;
      await this.config.update('providers', providers, vscode.ConfigurationTarget.Global);
    }

    await this.updatePreferences({
      activeProviderId: providerId,
      activeModelId: modelId
    });
  }

  /**
   * 获取全部模板（根据当前解析语言填充中英文的内置模板 + 用户自定义模板）
   */
  public getAllTemplates(langOverride?: ResolvedLanguage): CommitTemplate[] {
    const lang = langOverride || this.getResolvedCommitLanguage();
    const builtIns = getLocalizedBuiltInTemplates(lang);
    const custom = this.getCustomTemplates();
    return [...builtIns, ...custom];
  }

  /**
   * 获取用户自定义模板
   */
  public getCustomTemplates(): CommitTemplate[] {
    const raw = this.config.get<CommitTemplate[]>('customTemplates', []);
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.map((tpl) => ({
      ...tpl,
      isBuiltIn: false,
      icon: tpl.icon || '$(bookmark)',
      badge: tpl.badge || t('自定义', 'Custom')
    }));
  }

  /**
   * 获取当前激活的模板
   */
  public getActiveTemplate(langOverride?: ResolvedLanguage): CommitTemplate {
    const prefs = this.getPreferences();
    const all = this.getAllTemplates(langOverride);
    return all.find((tpl) => tpl.id === prefs.activeTemplateId) || all[0];
  }

  /**
   * 新增或修改自定义模板
   */
  public async upsertCustomTemplate(
    template: Omit<CommitTemplate, 'id' | 'isBuiltIn'> & { id?: string },
    setAsActive = false
  ): Promise<CommitTemplate> {
    const customList = this.getCustomTemplates();
    const id = template.id || `custom_${crypto.randomUUID().slice(0, 8)}`;

    const record: CommitTemplate = {
      id,
      name: template.name.trim() || t('自定义模板', 'Custom Template'),
      description: template.description.trim() || t('用户自定义 Git Commit 模板', 'Custom Git Commit Template'),
      badge: template.badge?.trim() || t('自定义', 'Custom'),
      icon: template.icon || '$(bookmark)',
      isBuiltIn: false,
      example: template.example || '',
      systemPrompt: template.systemPrompt.trim()
    };

    const idx = customList.findIndex((tpl) => tpl.id === id);
    if (idx >= 0) {
      customList[idx] = record;
    } else {
      customList.push(record);
    }

    await this.config.update('customTemplates', customList, vscode.ConfigurationTarget.Global);
    if (setAsActive) {
      await this.updatePreferences({ activeTemplateId: id });
    }
    this._onDidChange.fire();
    return record;
  }

  /**
   * 删除自定义模板
   */
  public async deleteCustomTemplate(templateId: string): Promise<void> {
    const customList = this.getCustomTemplates().filter((tpl) => tpl.id !== templateId);
    await this.config.update('customTemplates', customList, vscode.ConfigurationTarget.Global);

    const prefs = this.getPreferences();
    if (prefs.activeTemplateId === templateId) {
      await this.updatePreferences({ activeTemplateId: 'conventional' });
    }
    this._onDidChange.fire();
  }
}
