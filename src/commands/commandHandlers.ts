import * as vscode from 'vscode';
import { ConfigManager } from '../storage/configManager';
import { GitService } from '../git/gitService';
import { fetchProviderModels, generateCommitMessage } from '../ai/aiClient';
import { DashboardPanel } from '../webview/dashboardPanel';
import { AIProtocol, CommitTemplate } from '../types';
import { PROTOCOL_METADATA } from '../constants';
import { normalizeTemplateId, t } from '../i18n';

export class CommandHandlers {
  private activeAbortController: AbortController | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configManager: ConfigManager,
    private readonly gitService: GitService
  ) {}

  public stopGenerate(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = undefined;
    }
    vscode.commands.executeCommand('setContext', 'aiGitMessage.isGenerating', false);
    vscode.window.setStatusBarMessage(
      t('$(circle-slash) AI Git Message: 已停止生成', '$(circle-slash) AI Git Message: Generation stopped'),
      3000
    );
  }

  public async generate(scmArg?: any, forcedTemplateId?: string): Promise<void> {
    if (this.activeAbortController) {
      this.stopGenerate();
      return;
    }

    let { provider, modelId } = await this.configManager.getActiveProviderAndModel();
    if (!provider) {
      const btnDashboard = t('打开配置中心添加', 'Open Settings Center');
      const btnWizard = t('快速向导添加', 'Quick Add Wizard');
      const choice = await vscode.window.showInformationMessage(
        t(
          'AI Git Message: 尚未配置 AI 模型供应商（支持 OpenAI Response 与 Anthropic Message 协议）',
          'AI Git Message: No AI provider configured yet (supports OpenAI Response & Anthropic Message)'
        ),
        btnDashboard,
        btnWizard
      );
      if (choice === btnDashboard) {
        DashboardPanel.createOrShow(this.context, this.configManager, 'providers');
        return;
      } else if (choice === btnWizard) {
        const added = await this.addProviderQuickWizard();
        if (!added) {
          return;
        }
        const updated = await this.configManager.getActiveProviderAndModel();
        provider = updated.provider;
        modelId = updated.modelId;
      } else {
        return;
      }
    }

    if (!provider) {
      return;
    }

    if (!modelId) {
      const pickedModel = await this.promptModelForProvider(provider.id);
      if (!pickedModel) {
        return;
      }
      modelId = pickedModel;
    }

    const prefs = this.configManager.getPreferences();
    const resolvedLang = this.configManager.getResolvedCommitLanguage();
    let template: CommitTemplate | undefined;

    if (forcedTemplateId) {
      const normId = normalizeTemplateId(forcedTemplateId);
      template = this.configManager.getAllTemplates(resolvedLang).find((tpl) => tpl.id === normId);
    } else if (prefs.askTemplateBeforeGenerate) {
      template = await this.pickTemplateQuick(false);
      if (!template) {
        return;
      }
    } else {
      template = this.configManager.getActiveTemplate(resolvedLang);
    }

    if (!template) {
      template = this.configManager.getActiveTemplate(resolvedLang);
    }

    const repo = await this.gitService.resolveTargetRepository(scmArg);
    if (!repo) {
      return;
    }

    const diffContext = await this.gitService.collectDiffContext(
      repo,
      prefs.diffScope,
      prefs.maxDiffLines
    );
    if (!diffContext) {
      return;
    }

    const { systemPrompt, userPrompt } = this.gitService.buildPrompts(
      diffContext,
      template.systemPrompt,
      resolvedLang,
      prefs.customInstructions
    );

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    await vscode.commands.executeCommand('setContext', 'aiGitMessage.isGenerating', true);

    const previousInputValue = repo.inputBox.value;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.SourceControl,
          title: t(
            `AI 正在生成提交信息 (${provider.name} · ${modelId})`,
            `Generating commit message (${provider.name} · ${modelId})`
          ),
          cancellable: true
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => {
            abortController.abort();
          });

          vscode.window.setStatusBarMessage(
            t(
              `$(loading~spin) AI Git Message: 正在使用 [${template!.name}] 生成提交信息...`,
              `$(loading~spin) AI Git Message: Generating with [${template!.name}]...`
            )
          );

          const finalMessage = await generateCommitMessage({
            protocol: provider!.protocol,
            baseUrl: provider!.baseUrl,
            apiKey: provider!.apiKey,
            model: modelId,
            systemPrompt,
            userPrompt,
            stream: prefs.streamOutput,
            customHeaders: provider!.customHeaders,
            signal: abortController.signal,
            onUpdate: (fullText) => {
              if (prefs.streamOutput && fullText) {
                repo.inputBox.value = fullText;
              }
            }
          });

          if (!finalMessage) {
            throw new Error(
              t(
                '模型返回内容为空，请检查模型名称或协议配置是否正确',
                'Empty response from model. Please verify model ID and protocol settings.'
              )
            );
          }

          repo.inputBox.value = finalMessage;
          vscode.window.setStatusBarMessage(
            t(
              `$(check) AI Git Message: 已生成提交信息 (${template!.name} · ${modelId})`,
              `$(check) AI Git Message: Generated (${template!.name} · ${modelId})`
            ),
            5000
          );
        }
      );
    } catch (err: any) {
      if (abortController.signal.aborted) {
        if (!repo.inputBox.value.trim() && previousInputValue) {
          repo.inputBox.value = previousInputValue;
        }
        return;
      }
      const errMsg = err?.message || String(err);
      const btnCheck = t('打开配置中心检查', 'Open Settings Center');
      const btnSwitchModel = t('切换模型', 'Switch Model');
      const act = await vscode.window.showErrorMessage(
        t(`AI Git Message 生成失败: ${errMsg}`, `AI Git Message Failed: ${errMsg}`),
        btnCheck,
        btnSwitchModel
      );
      if (act === btnCheck) {
        DashboardPanel.createOrShow(this.context, this.configManager, 'providers');
      } else if (act === btnSwitchModel) {
        await this.selectModel();
      }
    } finally {
      this.activeAbortController = undefined;
      await vscode.commands.executeCommand('setContext', 'aiGitMessage.isGenerating', false);
    }
  }

  public async generateWithTemplate(scmArg?: any): Promise<void> {
    const picked = await this.pickTemplateQuick(false);
    if (!picked) {
      return;
    }
    await this.generate(scmArg, picked.id);
  }

  public async selectTemplate(): Promise<void> {
    const picked = await this.pickTemplateQuick(true);
    if (picked) {
      vscode.window.setStatusBarMessage(
        t(
          `$(check) AI Git Message: 默认模板已切换为「${picked.name}」`,
          `$(check) AI Git Message: Default template set to "${picked.name}"`
        ),
        3500
      );
    }
  }

  private async pickTemplateQuick(saveAsDefault: boolean): Promise<CommitTemplate | undefined> {
    const resolvedLang = this.configManager.getResolvedCommitLanguage();
    const templates = this.configManager.getAllTemplates(resolvedLang);
    const prefs = this.configManager.getPreferences();

    const toggleLangBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('globe'),
      tooltip: t(
        `切换提交语言 (当前: ${resolvedLang === 'zh' ? '中文' : 'English'})`,
        `Toggle Commit Language (Current: ${resolvedLang === 'zh' ? '中文' : 'English'})`
      )
    };

    const openDashboardBtn: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('settings-gear'),
      tooltip: t('打开模板管理与自定义配置中心', 'Open Template Settings Center')
    };

    const buildItems = (lang: 'zh' | 'en') => {
      const list = this.configManager.getAllTemplates(lang);
      return list.map((tpl) => {
        const isCurrent = tpl.id === prefs.activeTemplateId;
        return {
          label: `${isCurrent ? '$(check) ' : `${tpl.icon || '$(book)'} `}${tpl.name}`,
          description: `[${tpl.badge} · ${lang === 'zh' ? '中文' : 'EN'}]${isCurrent ? t(' · 当前默认', ' · Default') : ''}`,
          detail: tpl.description,
          template: tpl
        };
      });
    };

    let currentLang = resolvedLang;

    return new Promise<CommitTemplate | undefined>((resolve) => {
      const qp = vscode.window.createQuickPick<ReturnType<typeof buildItems>[number]>();
      const updateQpHeader = () => {
        const langBadge = currentLang === 'zh' ? '中文' : 'English';
        qp.title = saveAsDefault
          ? t(`选择默认 Git Message 模板 [语言: ${langBadge}]`, `Select Default Commit Template [Lang: ${langBadge}]`)
          : t(`选择本次使用的 Git Message 模板 [语言: ${langBadge}]`, `Select Commit Template [Lang: ${langBadge}]`);
        qp.placeholder = t(
          '搜索并选择模板（点击右上角地球图标可一键切换中/英文）',
          'Search and select a template (click the globe icon at top-right to switch Chinese/English)'
        );
      };

      updateQpHeader();
      qp.items = buildItems(currentLang);
      qp.buttons = [toggleLangBtn, openDashboardBtn];

      const activeItem = qp.items.find((i) => i.template.id === prefs.activeTemplateId);
      if (activeItem) {
        qp.activeItems = [activeItem];
      }

      qp.onDidTriggerButton(async (btn) => {
        if (btn === toggleLangBtn) {
          currentLang = currentLang === 'zh' ? 'en' : 'zh';
          await this.configManager.updatePreferences({ commitLanguage: currentLang });
          updateQpHeader();
          qp.items = buildItems(currentLang);
          return;
        }
        if (btn === openDashboardBtn) {
          qp.hide();
          DashboardPanel.createOrShow(this.context, this.configManager, 'templates');
          resolve(undefined);
        }
      });

      qp.onDidAccept(async () => {
        const selected = qp.selectedItems[0]?.template;
        qp.hide();
        if (selected && saveAsDefault) {
          await this.configManager.updatePreferences({ activeTemplateId: selected.id });
        }
        resolve(selected);
      });

      qp.onDidHide(() => {
        qp.dispose();
        resolve(undefined);
      });

      qp.show();
    });
  }

  public async selectModel(): Promise<void> {
    const providers = await this.configManager.getProvidersWithKeys();
    const prefs = this.configManager.getPreferences();

    if (providers.length === 0) {
      const btnDash = t('打开可视化配置中心', 'Open Settings Center');
      const btnWiz = t('使用快速向导添加', 'Quick Add Wizard');
      const action = await vscode.window.showInformationMessage(
        t('尚未添加任何 AI 模型供应商，请选择添加方式：', 'No AI provider configured yet. Choose how to add one:'),
        btnDash,
        btnWiz
      );
      if (action === btnDash) {
        DashboardPanel.createOrShow(this.context, this.configManager, 'providers');
      } else if (action === btnWiz) {
        await this.addProviderQuickWizard();
      }
      return;
    }

    interface ModelPickItem extends vscode.QuickPickItem {
      action?: 'fetchModels' | 'addProvider' | 'openDashboard';
      providerId?: string;
      modelId?: string;
    }

    const items: ModelPickItem[] = [
      {
        label: t(
          '$(sync) 从供应商自动获取最新模型列表 (/v1/models)...',
          '$(sync) Auto-fetch Model List from Provider (/v1/models)...'
        ),
        description: t('自动拉取并选择模型', 'Discover models automatically'),
        alwaysShow: true,
        action: 'fetchModels'
      },
      {
        label: t(
          '$(add) 添加新的 AI 供应商 (OpenAI Response / Anthropic Message)...',
          '$(add) Add New AI Provider (OpenAI Response / Anthropic Message)...'
        ),
        description: t('新建供应商', 'New provider'),
        alwaysShow: true,
        action: 'addProvider'
      },
      {
        label: t(
          '$(settings-gear) 打开 AI Git Message 配置中心',
          '$(settings-gear) Open AI Git Message Settings Center'
        ),
        description: t('可视化管理供应商、模型与模板', 'Manage providers, models & templates'),
        alwaysShow: true,
        action: 'openDashboard'
      },
      {
        label: t('已配置的供应商与模型', 'Configured Providers & Models'),
        kind: vscode.QuickPickItemKind.Separator
      }
    ];

    for (const p of providers) {
      const protoLabel = PROTOCOL_METADATA[p.protocol]?.shortBadge || p.protocol;
      const modelList = p.models.length > 0 ? p.models : p.defaultModel ? [p.defaultModel] : [];

      if (modelList.length === 0) {
        items.push({
          label: `$(hubot) ${p.name} — ${t('点击拉取模型列表', 'Click to fetch models')}`,
          description: `[${protoLabel}] ${p.baseUrl}`,
          providerId: p.id,
          action: 'fetchModels'
        });
      } else {
        for (const m of modelList) {
          const isCurrent = p.id === prefs.activeProviderId && m === prefs.activeModelId;
          items.push({
            label: `${isCurrent ? '$(check) ' : '$(sparkle) '}${m}`,
            description: `${p.name} · [${protoLabel}]${isCurrent ? t(' (当前激活)', ' (Active)') : ''}`,
            detail: p.baseUrl,
            providerId: p.id,
            modelId: m
          });
        }
      }
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: t('切换 AI 模型与供应商', 'Switch AI Model & Provider'),
      placeHolder: t(
        '搜索并选择要使用的 AI 模型，或从供应商接口自动拉取模型列表',
        'Search and select an AI model, or auto-fetch models from provider'
      ),
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (!picked) {
      return;
    }

    if (picked.action === 'openDashboard') {
      DashboardPanel.createOrShow(this.context, this.configManager, 'providers');
      return;
    }

    if (picked.action === 'addProvider') {
      await this.addProviderQuickWizard();
      return;
    }

    if (picked.action === 'fetchModels') {
      const targetProviderId = picked.providerId || prefs.activeProviderId || providers[0]?.id;
      if (targetProviderId) {
        await this.promptModelForProvider(targetProviderId, true);
      }
      return;
    }

    if (picked.providerId && picked.modelId) {
      await this.configManager.setActiveProviderAndModel(picked.providerId, picked.modelId);
      vscode.window.setStatusBarMessage(
        t(
          `$(check) AI Git Message: 已切换模型为 ${picked.modelId}`,
          `$(check) AI Git Message: Switched model to ${picked.modelId}`
        ),
        3500
      );
    }
  }

  public async promptModelForProvider(
    providerId: string,
    forceFetch = false
  ): Promise<string | undefined> {
    const providers = await this.configManager.getProvidersWithKeys();
    const provider = providers.find((p) => p.id === providerId);
    if (!provider) {
      return undefined;
    }

    let models = [...provider.models];

    if (forceFetch || models.length === 0) {
      try {
        const fetched = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t(
              `正在从 ${provider.name} 获取模型列表 (/v1/models)...`,
              `Fetching models from ${provider.name} (/v1/models)...`
            )
          },
          async () => {
            return await fetchProviderModels(
              provider.baseUrl,
              provider.apiKey,
              provider.protocol,
              provider.customHeaders
            );
          }
        );

        if (fetched.models.length > 0) {
          const fetchedIds = fetched.models.map((m) => m.id);
          models = Array.from(new Set([...fetchedIds, ...models]));
          await this.configManager.upsertProvider({
            ...provider,
            models,
            defaultModel: provider.defaultModel || models[0]
          });
        }
      } catch (err: any) {
        const btnManual = t('手动输入模型 ID', 'Enter Model ID Manually');
        const btnDash = t('打开配置中心', 'Open Settings Center');
        const manual = await vscode.window.showErrorMessage(
          t(
            `自动获取模型列表失败 (${err?.message || err})，是否手动输入模型名称？`,
            `Failed to fetch models (${err?.message || err}). Enter model ID manually?`
          ),
          btnManual,
          btnDash
        );
        if (manual === btnDash) {
          DashboardPanel.createOrShow(this.context, this.configManager, 'providers');
          return undefined;
        }
        if (manual === btnManual) {
          const inputModel = await vscode.window.showInputBox({
            title: t(`输入 ${provider.name} 的模型 ID`, `Enter Model ID for ${provider.name}`),
            placeHolder:
              provider.protocol === 'anthropic-messages'
                ? 'claude-sonnet-4-20250514'
                : 'gpt-4.1'
          });
          if (inputModel && inputModel.trim()) {
            const m = inputModel.trim();
            await this.configManager.setActiveProviderAndModel(provider.id, m);
            return m;
          }
        }
        return undefined;
      }
    }

    const items: (vscode.QuickPickItem & { modelId?: string; isManual?: boolean })[] = [
      ...models.map((m) => ({
        label: `$(sparkle) ${m}`,
        description: m === provider.defaultModel ? t('默认模型', 'Default') : provider.name,
        modelId: m
      })),
      {
        label: t('$(edit) 手动输入其他模型 ID...', '$(edit) Enter custom Model ID manually...'),
        description: t('直接输入未在列表中的模型名称', 'Type any model ID'),
        isManual: true
      }
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: t(
        `从 ${provider.name} 选择 AI 模型 (共 ${models.length} 个可用模型)`,
        `Select Model from ${provider.name} (${models.length} models available)`
      ),
      placeHolder: t('输入关键词搜索模型并回车选择', 'Type to filter models and press Enter')
    });

    if (!picked) {
      return undefined;
    }

    if (picked.isManual) {
      const manualId = await vscode.window.showInputBox({
        title: t('手动输入模型名称 (Model ID)', 'Enter Model ID'),
        placeHolder: 'gpt-4.1 / claude-sonnet-4-20250514'
      });
      if (manualId && manualId.trim()) {
        await this.configManager.setActiveProviderAndModel(provider.id, manualId.trim());
        return manualId.trim();
      }
      return undefined;
    }

    if (picked.modelId) {
      await this.configManager.setActiveProviderAndModel(provider.id, picked.modelId);
      return picked.modelId;
    }

    return undefined;
  }

  public async addProviderQuickWizard(): Promise<boolean> {
    const protoPick = await vscode.window.showQuickPick(
      [
        {
          label: '$(sparkle) OpenAI Response (/v1/responses)',
          description: t('推荐 · 标准 OpenAI Responses API', 'Recommended · OpenAI Responses API'),
          detail: t(
            '支持 OpenAI 官方及兼容 POST /v1/responses 的供应商',
            'Supports OpenAI and any POST /v1/responses compatible provider'
          ),
          protocol: 'openai-responses' as AIProtocol
        },
        {
          label: '$(hubot) Anthropic Message (/v1/messages)',
          description: t('Claude 标准 Anthropic Messages API', 'Anthropic Messages API'),
          detail: t(
            '支持 Anthropic 官方及兼容 POST /v1/messages 的供应商',
            'Supports Anthropic and any POST /v1/messages compatible provider'
          ),
          protocol: 'anthropic-messages' as AIProtocol
        },
        {
          label: '$(comment-discussion) OpenAI Chat (/v1/chat/completions)',
          description: t('传统 Chat Completions 兼容协议', 'Legacy Chat Completions API'),
          detail: 'POST /v1/chat/completions',
          protocol: 'openai-chat' as AIProtocol
        },
        {
          label: t(
            '$(settings-gear) 在可视化配置中心面板中添加...',
            '$(settings-gear) Open Visual Settings Center...'
          ),
          description: t('图形化配置界面', 'Visual configuration UI'),
          protocol: undefined
        }
      ],
      {
        title: t('步骤 1/4: 选择 AI 供应商接口协议', 'Step 1/4: Select AI Provider Protocol'),
        placeHolder: t(
          '请选择 OpenAI Response 或 Anthropic Message 协议',
          'Choose OpenAI Response or Anthropic Message protocol'
        )
      }
    );

    if (!protoPick) {
      return false;
    }

    if (!protoPick.protocol) {
      DashboardPanel.createOrShow(this.context, this.configManager, 'providers');
      return false;
    }

    const protocol = protoPick.protocol;
    const meta = PROTOCOL_METADATA[protocol];

    const name = await vscode.window.showInputBox({
      title: t('步骤 2/4: 输入供应商名称', 'Step 2/4: Enter Provider Name'),
      value: protocol === 'anthropic-messages' ? 'Anthropic Claude' : 'OpenAI Response',
      prompt: t('为该供应商起一个易于识别的名称', 'Enter a display name for this provider'),
      validateInput: (val) => (!val.trim() ? t('供应商名称不能为空', 'Provider name is required') : null)
    });
    if (!name) {
      return false;
    }

    const baseUrl = await vscode.window.showInputBox({
      title: t(`步骤 3/4: 输入 ${name} 的 Base URL`, `Step 3/4: Enter Base URL for ${name}`),
      value: meta.defaultBaseUrl,
      prompt: t(
        `将自动拼接请求端点 (${meta.endpointPath}) 与模型列表端点 (/v1/models)`,
        `Endpoints (${meta.endpointPath} & /v1/models) will be resolved automatically`
      ),
      validateInput: (val) => (!val.trim() ? t('Base URL 不能为空', 'Base URL is required') : null)
    });
    if (!baseUrl) {
      return false;
    }

    const apiKey = await vscode.window.showInputBox({
      title: t(`步骤 4/4: 输入 ${name} 的 API Key`, `Step 4/4: Enter API Key for ${name}`),
      password: true,
      placeHolder: 'sk-...',
      prompt: t(
        '密钥将安全加密保存在 VS Code SecretStorage 中',
        'Stored securely in VS Code SecretStorage'
      )
    });
    if (apiKey === undefined) {
      return false;
    }

    const saved = await this.configManager.upsertProvider(
      {
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        models: [],
        apiKey: apiKey.trim()
      },
      true
    );

    const selectedModel = await this.promptModelForProvider(saved.id, true);
    if (selectedModel) {
      vscode.window.showInformationMessage(
        t(
          `AI Git Message: 已成功添加供应商「${saved.name}」并选用模型「${selectedModel}」`,
          `AI Git Message: Added provider "${saved.name}" with model "${selectedModel}"`
        )
      );
    }
    return true;
  }
}
