import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ConfigManager } from '../storage/configManager';
import { fetchProviderModels, testProviderConnection } from '../ai/aiClient';
import { AIProtocol, CommitLanguage } from '../types';
import { getUiLanguage, t } from '../i18n';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];

  public static createOrShow(
    context: vscode.ExtensionContext,
    configManager: ConfigManager,
    initialTab: 'providers' | 'templates' | 'settings' = 'providers'
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel._panel.reveal(column);
      DashboardPanel.currentPanel.postMessage({
        type: 'switchTab',
        tab: initialTab
      });
      DashboardPanel.currentPanel.syncState();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'aiGitMessageDashboard',
      t('AI Git Message 配置中心', 'AI Git Message Settings'),
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel, context, configManager, initialTab);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly configManager: ConfigManager,
    private readonly initialTab: 'providers' | 'templates' | 'settings'
  ) {
    this._panel = panel;
    this._panel.webview.html = this.getHtmlForWebview(this._panel.webview, initialTab);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (msg) => {
        await this.handleMessage(msg);
      },
      null,
      this._disposables
    );

    this._disposables.push(
      this.configManager.onDidChange(() => {
        this.syncState();
      })
    );
  }

  public postMessage(message: any): void {
    this._panel.webview.postMessage(message);
  }

  public async syncState(): Promise<void> {
    const providers = await this.configManager.getProvidersWithKeys();
    const resolvedCommitLanguage = this.configManager.getResolvedCommitLanguage();
    const templates = this.configManager.getAllTemplates(resolvedCommitLanguage);
    const preferences = this.configManager.getPreferences();
    const uiLanguage = getUiLanguage();

    this.postMessage({
      type: 'stateUpdated',
      payload: {
        providers,
        templates,
        preferences,
        uiLanguage,
        resolvedCommitLanguage
      }
    });
  }

  private async handleMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready': {
          await this.syncState();
          break;
        }

        case 'saveProvider': {
          const p = msg.payload;
          const saved = await this.configManager.upsertProvider(
            {
              id: p.id || undefined,
              name: p.name,
              protocol: p.protocol as AIProtocol,
              baseUrl: p.baseUrl,
              models: Array.isArray(p.models) ? p.models : [],
              defaultModel: p.defaultModel || '',
              apiKey: p.apiKey
            },
            Boolean(p.setAsActive)
          );
          await this.syncState();
          this.postMessage({
            type: 'providerSaved',
            providerId: saved.id,
            message: t(`已保存供应商「${saved.name}」`, `Saved provider "${saved.name}"`)
          });
          vscode.window.setStatusBarMessage(
            t(`$(check) AI Git Message: 已保存 ${saved.name}`, `$(check) AI Git Message: Saved ${saved.name}`),
            3000
          );
          break;
        }

        case 'deleteProvider': {
          const { providerId, providerName } = msg.payload;
          const btnDel = t('删除', 'Delete');
          const confirm = await vscode.window.showWarningMessage(
            t(
              `确定要删除供应商「${providerName || providerId}」吗？`,
              `Are you sure you want to delete provider "${providerName || providerId}"?`
            ),
            { modal: true },
            btnDel
          );
          if (confirm === btnDel) {
            await this.configManager.deleteProvider(providerId);
            await this.syncState();
            this.postMessage({
              type: 'toast',
              level: 'info',
              message: t(`已删除供应商「${providerName || providerId}」`, `Deleted "${providerName || providerId}"`)
            });
          }
          break;
        }

        case 'setActiveProviderModel': {
          const { providerId, modelId } = msg.payload;
          await this.configManager.setActiveProviderAndModel(providerId, modelId);
          await this.syncState();
          this.postMessage({
            type: 'toast',
            level: 'success',
            message: t(`已切换当前模型为: ${modelId}`, `Active model switched to: ${modelId}`)
          });
          break;
        }

        case 'fetchModels': {
          const { baseUrl, apiKey, protocol } = msg.payload;
          this.postMessage({ type: 'fetchModelsStatus', loading: true });
          try {
            const result = await fetchProviderModels(baseUrl, apiKey, protocol as AIProtocol);
            this.postMessage({
              type: 'fetchModelsResult',
              ok: true,
              models: result.models,
              endpoint: result.endpoint
            });
          } catch (err: any) {
            this.postMessage({
              type: 'fetchModelsResult',
              ok: false,
              error: err?.message || String(err)
            });
          }
          break;
        }

        case 'testConnection': {
          const { baseUrl, apiKey, protocol, model } = msg.payload;
          this.postMessage({ type: 'testConnectionStatus', loading: true });
          const res = await testProviderConnection({
            baseUrl,
            apiKey,
            protocol: protocol as AIProtocol,
            model
          });
          this.postMessage({
            type: 'testConnectionResult',
            ...res
          });
          break;
        }

        case 'selectTemplate': {
          const { templateId } = msg.payload;
          await this.configManager.updatePreferences({ activeTemplateId: templateId });
          await this.syncState();
          const tpl = this.configManager.getActiveTemplate();
          this.postMessage({
            type: 'toast',
            level: 'success',
            message: t(`默认模板已切换为「${tpl.name}」`, `Default template set to "${tpl.name}"`)
          });
          break;
        }

        case 'setCommitLanguage': {
          const { language } = msg.payload as { language: CommitLanguage };
          await this.configManager.updatePreferences({ commitLanguage: language });
          await this.syncState();
          const resolved = this.configManager.getResolvedCommitLanguage();
          this.postMessage({
            type: 'toast',
            level: 'success',
            message: t(
              `已切换模板与提交语言为：${resolved === 'zh' ? '中文' : 'English'}`,
              `Switched template & commit language to: ${resolved === 'zh' ? '中文' : 'English'}`
            )
          });
          break;
        }

        case 'generateWithTemplateId': {
          const { templateId } = msg.payload;
          await vscode.commands.executeCommand('aiGitMessage.generate', undefined, templateId);
          break;
        }

        case 'saveCustomTemplate': {
          const tpl = msg.payload;
          const saved = await this.configManager.upsertCustomTemplate(
            {
              id: tpl.id || undefined,
              name: tpl.name,
              description: tpl.description,
              badge: tpl.badge || t('自定义', 'Custom'),
              icon: tpl.icon || '$(bookmark)',
              example: tpl.example || '',
              systemPrompt: tpl.systemPrompt
            },
            Boolean(tpl.setAsActive)
          );
          await this.syncState();
          this.postMessage({
            type: 'customTemplateSaved',
            templateId: saved.id,
            message: t(`已保存模板「${saved.name}」`, `Saved template "${saved.name}"`)
          });
          break;
        }

        case 'deleteCustomTemplate': {
          const { templateId, templateName } = msg.payload;
          const btnDel = t('删除', 'Delete');
          const confirm = await vscode.window.showWarningMessage(
            t(
              `确定要删除自定义模板「${templateName}」吗？`,
              `Delete custom template "${templateName}"?`
            ),
            { modal: true },
            btnDel
          );
          if (confirm === btnDel) {
            await this.configManager.deleteCustomTemplate(templateId);
            await this.syncState();
            this.postMessage({
              type: 'toast',
              level: 'info',
              message: t(`已删除自定义模板「${templateName}」`, `Deleted "${templateName}"`)
            });
          }
          break;
        }

        case 'updatePreferences': {
          await this.configManager.updatePreferences(msg.payload);
          await this.syncState();
          this.postMessage({
            type: 'toast',
            level: 'success',
            message: t('设置已保存', 'Preferences saved')
          });
          break;
        }

        case 'triggerGenerateNow': {
          await vscode.commands.executeCommand('aiGitMessage.generate');
          break;
        }
      }
    } catch (err: any) {
      this.postMessage({
        type: 'toast',
        level: 'error',
        message: err?.message || String(err)
      });
    }
  }

  public dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  private getHtmlForWebview(
    webview: vscode.Webview,
    initialTab: 'providers' | 'templates' | 'settings'
  ): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const isZh = getUiLanguage() === 'zh';

    return /* html */ `<!DOCTYPE html>
<html lang="${isZh ? 'zh-CN' : 'en'}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>AI Git Message</title>
  <style>
    :root {
      --radius-sm: 4px;
      --radius-md: 6px;
      --radius-lg: 8px;
      --border-subtle: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.22));
      --bg-card: var(--vscode-sideBar-background, var(--vscode-editor-background));
      --bg-elevated: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
      --accent: var(--vscode-button-background, #0078d4);
      --accent-hover: var(--vscode-button-hoverBackground, #106ebe);
      --accent-fg: var(--vscode-button-foreground, #ffffff);
      --text-main: var(--vscode-foreground);
      --text-muted: var(--vscode-descriptionForeground);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--text-main);
      background-color: var(--vscode-editor-background);
      line-height: 1.45;
    }

    .app-container {
      max-width: 1120px;
      margin: 0 auto;
      padding: 12px 20px 40px;
    }

    /* 紧凑单行顶部导航与状态栏 */
    .compact-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-bottom: var(--border-subtle);
      margin-bottom: 16px;
      padding-bottom: 0;
      flex-wrap: wrap;
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .brand-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      font-size: 13px;
      padding: 6px 10px 8px 2px;
      margin-right: 6px;
      color: var(--text-main);
      white-space: nowrap;
    }

    .brand-dot {
      width: 20px;
      height: 20px;
      border-radius: 5px;
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
    }

    .nav-tabs {
      display: flex;
      gap: 2px;
    }

    .nav-tab {
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-muted);
      padding: 8px 13px;
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      transition: color 0.15s, border-color 0.15s;
    }

    .nav-tab:hover {
      color: var(--text-main);
    }

    .nav-tab.active {
      color: var(--text-main);
      border-bottom-color: var(--vscode-focusBorder, var(--accent));
      font-weight: 600;
    }

    .topbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
      padding-bottom: 4px;
      flex-wrap: wrap;
    }

    .summary-brief {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
      color: var(--text-muted);
      background: var(--bg-elevated);
      border: var(--border-subtle);
      padding: 3px 10px;
      border-radius: 999px;
      max-width: 460px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .summary-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--vscode-testing-iconPassed, #10b981);
      flex-shrink: 0;
    }

    .summary-dot.warn {
      background: var(--vscode-errorForeground, #f14c4c);
    }

    .tab-pane {
      display: none;
    }

    .tab-pane.active {
      display: block;
    }

    /* 通用按钮（防折行） */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 500;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
      flex-shrink: 0;
      transition: opacity 0.15s, background 0.15s;
    }

    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--accent);
      color: var(--accent-fg);
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--accent-hover);
    }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.16));
      color: var(--vscode-button-secondaryForeground, var(--text-main));
      border-color: var(--vscode-widget-border, rgba(128, 128, 128, 0.2));
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.25));
    }

    .btn-danger {
      background: transparent;
      color: var(--vscode-errorForeground, #f14c4c);
      border-color: rgba(241, 76, 76, 0.35);
    }

    .btn-danger:hover:not(:disabled) {
      background: rgba(241, 76, 76, 0.12);
    }

    .btn-sm {
      padding: 3px 9px;
      font-size: 11.5px;
    }

    /* 分段语言切换按钮组 */
    .segmented-group {
      display: inline-flex;
      border: var(--border-subtle);
      border-radius: var(--radius-sm);
      overflow: hidden;
      background: var(--vscode-editor-background);
    }

    .segmented-btn {
      border: none;
      background: transparent;
      color: var(--text-muted);
      padding: 4px 11px;
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      font-family: inherit;
      transition: all 0.12s;
    }

    .segmented-btn:hover {
      color: var(--text-main);
    }

    .segmented-btn.active {
      background: var(--accent);
      color: var(--accent-fg);
      font-weight: 600;
    }

    /* 供应商管理双栏布局 */
    .providers-grid {
      display: grid;
      grid-template-columns: 280px 1fr;
      gap: 16px;
      align-items: start;
    }

    @media (max-width: 780px) {
      .providers-grid {
        grid-template-columns: 1fr;
      }
    }

    .sidebar-panel,
    .detail-panel {
      background: var(--bg-card);
      border: var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 14px 16px;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 10px;
    }

    .panel-title {
      font-size: 13px;
      font-weight: 600;
      margin: 0;
    }

    .preset-buttons {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;
      margin-bottom: 10px;
    }

    .preset-btn {
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      border: 1px dashed var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
      background: var(--bg-elevated);
      color: var(--text-main);
      font-size: 11.5px;
      cursor: pointer;
      text-align: left;
      transition: border-color 0.15s;
    }

    .preset-btn:hover {
      border-style: solid;
      border-color: var(--vscode-focusBorder, var(--accent));
    }

    .preset-btn strong {
      display: block;
      font-size: 11.5px;
    }

    .preset-btn span {
      font-size: 10.5px;
      color: var(--text-muted);
    }

    .provider-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .provider-item {
      padding: 9px 11px;
      border-radius: var(--radius-md);
      border: var(--border-subtle);
      background: var(--vscode-editor-background);
      cursor: pointer;
      transition: border-color 0.15s;
    }

    .provider-item:hover {
      border-color: var(--vscode-focusBorder, var(--accent));
    }

    .provider-item.selected {
      border-color: var(--vscode-focusBorder, var(--accent));
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, var(--accent));
    }

    .provider-item-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 3px;
    }

    .provider-item-name {
      font-weight: 600;
      font-size: 12.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 500;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .badge-active {
      background: rgba(16, 185, 129, 0.2);
      color: var(--vscode-testing-iconPassed, #10b981);
      border: 1px solid rgba(16, 185, 129, 0.4);
    }

    .provider-item-meta {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    /* 表单控件 */
    .form-row-2col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }

    @media (max-width: 680px) {
      .form-row-2col {
        grid-template-columns: 1fr;
      }
    }

    .form-group {
      margin-bottom: 12px;
    }

    .form-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 5px;
    }

    .form-hint {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .input,
    .select,
    .textarea {
      width: 100%;
      padding: 6px 9px;
      font-size: 12.5px;
      font-family: inherit;
      color: var(--vscode-input-foreground, var(--text-main));
      background: var(--vscode-input-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.32));
      border-radius: var(--radius-sm);
      outline: none;
    }

    .input:focus,
    .select:focus,
    .textarea:focus {
      border-color: var(--vscode-focusBorder, var(--accent));
    }

    .textarea {
      min-height: 95px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }

    /* 紧凑协议选择卡片 */
    .protocol-selector {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }

    @media (max-width: 680px) {
      .protocol-selector {
        grid-template-columns: 1fr;
      }
    }

    .protocol-card {
      padding: 7px 10px;
      border-radius: var(--radius-sm);
      border: var(--border-subtle);
      background: var(--vscode-editor-background);
      cursor: pointer;
      transition: all 0.12s;
    }

    .protocol-card:hover {
      border-color: var(--vscode-focusBorder, var(--accent));
    }

    .protocol-card.active {
      border-color: var(--vscode-focusBorder, var(--accent));
      background: rgba(37, 99, 235, 0.08);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, var(--accent));
    }

    .protocol-card-title {
      font-weight: 600;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }

    .protocol-card-desc {
      font-size: 10.5px;
      color: var(--text-muted);
      font-family: var(--vscode-editor-font-family, monospace);
      margin-top: 2px;
    }

    /* 紧凑单行端点预览 */
    .endpoint-preview {
      margin-top: 5px;
      padding: 5px 9px;
      border-radius: var(--radius-sm);
      background: var(--bg-elevated);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
    }

    .endpoint-preview code {
      color: var(--text-main);
    }

    .input-row {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    /* 模型列表自动获取区域 */
    .models-box {
      border: var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 10px;
      background: var(--vscode-editor-background);
    }

    .models-toolbar {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }

    .models-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      max-height: 185px;
      overflow-y: auto;
      padding: 2px 1px;
    }

    .model-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border-radius: var(--radius-sm);
      border: var(--border-subtle);
      background: var(--bg-card);
      color: var(--text-main);
      font-size: 11.5px;
      font-family: var(--vscode-editor-font-family, monospace);
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.12s;
    }

    .model-chip:hover {
      border-color: var(--vscode-focusBorder, var(--accent));
    }

    .model-chip.active {
      background: var(--accent);
      color: var(--accent-fg);
      border-color: var(--accent);
      font-weight: 600;
    }

    .model-chip .remove-model {
      opacity: 0.65;
      font-size: 12px;
      padding: 0 2px;
    }

    .model-chip .remove-model:hover {
      opacity: 1;
    }

    /* 模板网格 */
    .templates-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      flex-wrap: wrap;
      gap: 10px;
      background: var(--bg-card);
      border: var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 10px 14px;
    }

    .templates-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 14px;
    }

    .template-card {
      background: var(--bg-card);
      border: var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 14px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      transition: border-color 0.15s;
    }

    .template-card.active {
      border-color: var(--vscode-focusBorder, var(--accent));
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, var(--accent));
    }

    .template-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 5px;
    }

    .template-card-title {
      font-size: 13.5px;
      font-weight: 600;
      margin: 0;
    }

    .template-card-desc {
      font-size: 11.5px;
      color: var(--text-muted);
      margin-bottom: 8px;
    }

    .template-example {
      background: var(--vscode-editor-background);
      border: var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 8px 10px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      white-space: pre-wrap;
      color: var(--text-main);
      margin-bottom: 10px;
      max-height: 120px;
      overflow-y: auto;
    }

    .template-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      justify-content: space-between;
      padding-top: 8px;
      border-top: var(--border-subtle);
    }

    /* 偏好设置卡片 */
    .settings-card {
      background: var(--bg-card);
      border: var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 14px 18px;
    }

    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 0;
      border-bottom: var(--border-subtle);
    }

    .setting-row:last-child {
      border-bottom: none;
    }

    .setting-info h4 {
      margin: 0 0 2px 0;
      font-size: 12.5px;
    }

    .setting-info p {
      margin: 0;
      font-size: 11.5px;
      color: var(--text-muted);
    }

    .status-banner {
      margin-top: 10px;
      padding: 7px 11px;
      border-radius: var(--radius-sm);
      font-size: 11.5px;
      display: none;
    }

    .status-banner.show {
      display: block;
    }

    .status-banner.success {
      background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.4);
      color: var(--vscode-testing-iconPassed, #10b981);
    }

    .status-banner.error {
      background: rgba(241, 76, 76, 0.14);
      border: 1px solid rgba(241, 76, 76, 0.4);
      color: var(--vscode-errorForeground, #f14c4c);
    }

    .toast-floating {
      position: fixed;
      bottom: 16px;
      right: 20px;
      padding: 8px 14px;
      border-radius: var(--radius-md);
      background: var(--vscode-notifications-background, var(--bg-card));
      color: var(--vscode-notifications-foreground, var(--text-main));
      border: 1px solid var(--vscode-focusBorder, var(--accent));
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.3);
      font-size: 12px;
      z-index: 999;
      display: none;
    }

    .toast-floating.show {
      display: block;
    }

    .custom-editor-box {
      background: var(--bg-card);
      border: 1px solid var(--vscode-focusBorder, var(--accent));
      border-radius: var(--radius-lg);
      padding: 14px 16px;
      margin-bottom: 14px;
      display: none;
    }

    .custom-editor-box.show {
      display: block;
    }
  </style>
</head>
<body>
  <div class="app-container">
    <!-- 紧凑单行顶部导航与状态概览 -->
    <div class="compact-topbar">
      <div class="topbar-left">
        <div class="brand-chip">
          <span class="brand-dot">✨</span>
          <span>AI Git Message</span>
        </div>
        <div class="nav-tabs">
          <button class="nav-tab ${initialTab === 'providers' ? 'active' : ''}" data-tab="providers" id="tabBtnProviders">
            🤖 ${isZh ? '模型供应商' : 'AI Providers'}
          </button>
          <button class="nav-tab ${initialTab === 'templates' ? 'active' : ''}" data-tab="templates" id="tabBtnTemplates">
            📋 ${isZh ? '提交模板库' : 'Templates'}
          </button>
          <button class="nav-tab ${initialTab === 'settings' ? 'active' : ''}" data-tab="settings" id="tabBtnSettings">
            ⚙️ ${isZh ? '偏好设置' : 'Preferences'}
          </button>
        </div>
      </div>

      <div class="topbar-right">
        <div class="summary-brief" id="compactStatusBrief" title="">
          <span class="summary-dot" id="summaryDot"></span>
          <span id="summaryText">${isZh ? '加载中...' : 'Loading...'}</span>
        </div>
        <button class="btn btn-primary btn-sm" id="btnGenerateNow">
          ✨ ${isZh ? '立即生成' : 'Generate'}
        </button>
      </div>
    </div>

    <!-- TAB 1: AI 模型供应商 -->
    <div class="tab-pane ${initialTab === 'providers' ? 'active' : ''}" id="tab-providers">
      <div class="providers-grid">
        <!-- 左侧供应商列表 -->
        <div class="sidebar-panel">
          <div class="panel-header">
            <h3 class="panel-title">${isZh ? '已配置的供应商' : 'Configured Providers'}</h3>
          </div>
          <div class="preset-buttons">
            <button class="preset-btn" id="btnPresetOpenAI">
              <strong>+ OpenAI Response</strong>
              <span>/v1/responses</span>
            </button>
            <button class="preset-btn" id="btnPresetAnthropic">
              <strong>+ Anthropic Message</strong>
              <span>/v1/messages</span>
            </button>
          </div>
          <div class="provider-list" id="providerListContainer"></div>
        </div>

        <!-- 右侧供应商编辑表单 -->
        <div class="detail-panel">
          <div class="panel-header">
            <h3 class="panel-title" id="providerFormTitle">${isZh ? '添加 AI 模型供应商' : 'Add AI Provider'}</h3>
            <span class="badge" id="providerFormModeBadge">${isZh ? '新建模式' : 'New'}</span>
          </div>

          <input type="hidden" id="providerIdInput" value="" />

          <div class="form-group">
            <label class="form-label">${isZh ? '接口协议类型' : 'API Protocol'}</label>
            <div class="protocol-selector" id="protocolSelector">
              <div class="protocol-card active" data-protocol="openai-responses">
                <div class="protocol-card-title">
                  <span>OpenAI Response</span>
                  <span class="badge">${isZh ? '推荐' : 'Default'}</span>
                </div>
                <div class="protocol-card-desc">POST /v1/responses</div>
              </div>
              <div class="protocol-card" data-protocol="anthropic-messages">
                <div class="protocol-card-title">
                  <span>Anthropic Message</span>
                  <span class="badge">Claude</span>
                </div>
                <div class="protocol-card-desc">POST /v1/messages</div>
              </div>
              <div class="protocol-card" data-protocol="openai-chat">
                <div class="protocol-card-title">
                  <span>OpenAI Chat</span>
                </div>
                <div class="protocol-card-desc">POST /v1/chat/completions</div>
              </div>
            </div>
          </div>

          <div class="form-row-2col">
            <div class="form-group">
              <label class="form-label">${isZh ? '供应商名称' : 'Provider Name'}</label>
              <input type="text" class="input" id="providerNameInput" placeholder="${isZh ? '例如：OpenAI / Anthropic' : 'e.g. OpenAI / Anthropic'}" />
            </div>

            <div class="form-group">
              <label class="form-label">${isZh ? 'API Key (加密存储于 SecretStorage)' : 'API Key (Stored in SecretStorage)'}</label>
              <div class="input-row">
                <input type="password" class="input" id="providerApiKeyInput" placeholder="sk-..." />
                <button class="btn btn-secondary" type="button" id="btnToggleApiKey">${isZh ? '显示' : 'Show'}</button>
              </div>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">${isZh ? 'API Base URL (接口地址)' : 'API Base URL'}</label>
            <input type="text" class="input" id="providerBaseUrlInput" placeholder="https://api.openai.com/v1" />
            <div class="endpoint-preview" id="endpointPreviewBox">
              <span>${isZh ? '生成端点:' : 'Generate:'} <code id="previewGenEndpoint">-</code></span>
              <span>${isZh ? '模型端点:' : 'Models:'} <code id="previewModelsEndpoint">-</code></span>
            </div>
          </div>

          <div class="form-group" style="margin-bottom: 8px;">
            <label class="form-label">${isZh ? '模型选择与自动获取' : 'Model Selection & Auto-Discovery'}</label>
            <div class="models-box">
              <div class="models-toolbar">
                <div class="input-row" style="flex:1; min-width: 200px;">
                  <input type="text" class="input" id="activeModelInput" placeholder="${isZh ? '当前模型 ID (如 gpt-4.1 / claude-sonnet-4-20250514)' : 'Active Model ID (e.g. gpt-4.1)'}" />
                  <button class="btn btn-secondary" type="button" id="btnAddManualModel">${isZh ? '+ 添加' : '+ Add'}</button>
                </div>
                <button class="btn btn-primary" type="button" id="btnFetchModels">
                  🔄 ${isZh ? '自动获取模型列表 (/v1/models)' : 'Fetch Models (/v1/models)'}
                </button>
              </div>

              <div class="input-row" style="margin-bottom: 6px;">
                <input type="text" class="input" id="modelSearchInput" placeholder="🔍 ${isZh ? '搜索过滤模型列表...' : 'Filter models...'}" />
              </div>

              <div class="models-chips" id="modelsChipsContainer"></div>
            </div>
          </div>

          <div class="status-banner" id="providerActionBanner"></div>

          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-top:12px; padding-top:12px; border-top:var(--border-subtle);">
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button class="btn btn-primary" type="button" id="btnSaveAndActivateProvider">
                💾 ${isZh ? '保存并设为当前供应商' : 'Save & Set Active'}
              </button>
              <button class="btn btn-secondary" type="button" id="btnSaveProviderOnly">
                ${isZh ? '仅保存' : 'Save Only'}
              </button>
              <button class="btn btn-secondary" type="button" id="btnTestConnection">
                ⚡ ${isZh ? '测试连接' : 'Test Connection'}
              </button>
            </div>
            <button class="btn btn-danger" type="button" id="btnDeleteProvider" style="display:none;">
              🗑️ ${isZh ? '删除' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- TAB 2: Git Message 模板库 -->
    <div class="tab-pane ${initialTab === 'templates' ? 'active' : ''}" id="tab-templates">
      <div class="templates-toolbar">
        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
          <span style="font-weight:600; font-size:12.5px;">
            🌐 ${isZh ? '模板与生成语言:' : 'Commit Output Language:'}
          </span>
          <div class="segmented-group" id="langSegmentedGroup">
            <button class="segmented-btn" data-lang="zh">中文</button>
            <button class="segmented-btn" data-lang="en">English</button>
          </div>
          <span style="font-size:11.5px; color:var(--text-muted);">
            ${isZh ? '（切换后所有内置模板示例与 AI 生成结果自动切换为对应语言）' : '(Switches template examples and AI output language)'}
          </span>
        </div>
        <button class="btn btn-primary btn-sm" id="btnNewCustomTemplate">
          + ${isZh ? '新建自定义模板' : 'New Custom Template'}
        </button>
      </div>

      <!-- 自定义模板编辑框 -->
      <div class="custom-editor-box" id="customTemplateEditor">
        <div class="panel-header">
          <h3 class="panel-title" id="customTplEditorTitle">${isZh ? '新建自定义 Git Message 模板' : 'New Custom Template'}</h3>
          <button class="btn btn-secondary btn-sm" id="btnCloseCustomEditor">${isZh ? '关闭' : 'Close'}</button>
        </div>
        <input type="hidden" id="customTplId" value="" />
        <div class="form-row-2col">
          <div class="form-group">
            <label class="form-label">${isZh ? '模板名称' : 'Template Name'}</label>
            <input type="text" class="input" id="customTplName" placeholder="${isZh ? '例如：团队 Jira 规范模板' : 'e.g. Team Jira Convention'}" />
          </div>
          <div class="form-group">
            <label class="form-label">${isZh ? '标签徽章' : 'Badge'}</label>
            <input type="text" class="input" id="customTplBadge" placeholder="${isZh ? '自定义' : 'Custom'}" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">${isZh ? '模板简短说明' : 'Description'}</label>
          <input type="text" class="input" id="customTplDesc" placeholder="${isZh ? '描述该模板适用的场景与格式特点' : 'Describe when and how this template is used'}" />
        </div>
        <div class="form-group">
          <label class="form-label">${isZh ? '格式输出示例' : 'Format Example'}</label>
          <textarea class="textarea" id="customTplExample" style="min-height:60px;" placeholder="feat(order): [PROJ-102] add order timeout handler"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">${isZh ? '模板 System Prompt (AI 生成指令规则)' : 'Template System Prompt'}</label>
          <textarea class="textarea" id="customTplPrompt" placeholder="${isZh ? '请详细描述希望 AI 遵循的 Git Commit Message 格式与规则...' : 'Describe the commit message structure and rules for the AI...'}"></textarea>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-primary" id="btnSaveCustomTpl">💾 ${isZh ? '保存自定义模板并设为默认' : 'Save & Set Default'}</button>
        </div>
      </div>

      <div class="templates-grid" id="templatesGridContainer"></div>
    </div>

    <!-- TAB 3: 生成规则与偏好设置 -->
    <div class="tab-pane ${initialTab === 'settings' ? 'active' : ''}" id="tab-settings">
      <div class="settings-card">
        <div class="setting-row">
          <div class="setting-info">
            <h4>${isZh ? '生成的 Git Message 语言模式' : 'Commit Message Language Mode'}</h4>
            <p>${isZh ? '默认「自动跟随 VS Code 语言」，也可固定为简体中文或英文。' : 'Defaults to following VS Code display language, or pin to Chinese / English.'}</p>
          </div>
          <div style="min-width:210px;">
            <select class="select" id="prefCommitLanguage">
              <option value="auto">${isZh ? '自动 (跟随 VS Code 语言)' : 'Auto (Follow VS Code Language)'}</option>
              <option value="zh">${isZh ? '简体中文 (Chinese)' : 'Simplified Chinese (简体中文)'}</option>
              <option value="en">English</option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <h4>${isZh ? '点击源代码管理处生成按钮时每次询问模板' : 'Ask Template Before Generating'}</h4>
            <p>${isZh ? '开启后每次点击生成按钮先弹出模板选择器；关闭则直接使用默认模板极速生成。' : 'Prompt to pick a template on every click, or generate immediately using default template.'}</p>
          </div>
          <div>
            <input type="checkbox" id="prefAskTemplate" style="width:16px; height:16px; cursor:pointer;" />
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <h4>${isZh ? 'Git Diff 变更读取范围' : 'Git Diff Scope'}</h4>
            <p>${isZh ? '智能模式：当暂存区 (Staged) 有文件时仅分析暂存区；否则自动分析工作区修改。' : 'Smart Auto: Analyze staged changes if present, otherwise analyze working tree changes.'}</p>
          </div>
          <div style="min-width:240px;">
            <select class="select" id="prefDiffScope">
              <option value="auto">${isZh ? '智能检测 (优先暂存区)' : 'Smart Auto (Staged first)'}</option>
              <option value="staged">${isZh ? '仅暂存区 (Staged Only)' : 'Staged Only'}</option>
              <option value="all">${isZh ? '全部变更 (All Changes)' : 'All Changes'}</option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <h4>${isZh ? '实时流式输出到 Git 输入框 (Streaming)' : 'Stream Output to SCM Input Box'}</h4>
            <p>${isZh ? '将 AI 生成的提交信息实时流式写入 VS Code 源代码管理输入框。' : 'Stream generated commit message into the SCM input box in real time.'}</p>
          </div>
          <div>
            <input type="checkbox" id="prefStreamOutput" style="width:16px; height:16px; cursor:pointer;" />
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <h4>${isZh ? '在底部状态栏显示快捷入口' : 'Show Status Bar Shortcut'}</h4>
            <p>${isZh ? '在 VS Code 底部状态栏展示当前 AI 模型与模板，点击可快速切换。' : 'Display active model and template in the VS Code status bar.'}</p>
          </div>
          <div>
            <input type="checkbox" id="prefShowStatusBar" style="width:16px; height:16px; cursor:pointer;" />
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-info">
            <h4>${isZh ? '最大 Diff 上下文行数限制' : 'Max Diff Lines'}</h4>
            <p>${isZh ? '防止超大变更超出模型上下文窗口（锁文件自动过滤）。' : 'Prevent oversized diffs from exceeding model context window.'}</p>
          </div>
          <div style="width:130px;">
            <input type="number" class="input" id="prefMaxDiffLines" min="200" max="10000" step="100" />
          </div>
        </div>

        <div class="setting-row" style="flex-direction:column; align-items:stretch;">
          <div class="setting-info" style="margin-bottom:6px;">
            <h4>${isZh ? '全局附加指令 (Custom Instructions)' : 'Global Custom Instructions'}</h4>
            <p>${isZh ? '附加给所有模板的额外规则（如特定 Issue 前缀约定等）。' : 'Extra instructions appended to all templates (e.g. JIRA issue prefix rules).'}</p>
          </div>
          <textarea class="textarea" id="prefCustomInstructions" style="min-height:70px;" placeholder="${isZh ? '例如：若分支名包含单号 PROJ-123，请将其附在提交标题末尾。' : 'e.g. Include branch issue key PROJ-123 at the end of the subject line.'}"></textarea>
          <div style="margin-top:8px;">
            <button class="btn btn-primary" id="btnSavePreferences">💾 ${isZh ? '保存偏好设置' : 'Save Preferences'}</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="toast-floating" id="toastEl"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const isZh = ${isZh ? 'true' : 'false'};

    let appState = {
      providers: [],
      templates: [],
      uiLanguage: isZh ? 'zh' : 'en',
      resolvedCommitLanguage: isZh ? 'zh' : 'en',
      preferences: {
        activeProviderId: '',
        activeModelId: '',
        activeTemplateId: 'conventional',
        commitLanguage: 'auto',
        askTemplateBeforeGenerate: false,
        diffScope: 'auto',
        streamOutput: true,
        maxDiffLines: 1500,
        customInstructions: '',
        showStatusBar: true
      }
    };

    let editingProviderId = '';
    let selectedProtocol = 'openai-responses';
    let currentProviderModels = [];
    let modelSearchKeyword = '';

    // Tab 切换
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchTab(btn.getAttribute('data-tab'));
      });
    });

    function switchTab(tabName) {
      document.querySelectorAll('.nav-tab').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-tab') === tabName);
      });
      document.querySelectorAll('.tab-pane').forEach((p) => {
        p.classList.toggle('active', p.id === 'tab-' + tabName);
      });
    }

    // 模板库顶部中英文按钮切换
    document.querySelectorAll('#langSegmentedGroup .segmented-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-lang');
        if (lang) {
          vscode.postMessage({
            type: 'setCommitLanguage',
            payload: { language: lang }
          });
        }
      });
    });

    function normalizeBase(raw) {
      let u = (raw || '').trim().replace(/\\/+$/, '');
      u = u.replace(/\\/responses$/i, '')
           .replace(/\\/messages$/i, '')
           .replace(/\\/chat\\/completions$/i, '')
           .replace(/\\/models$/i, '')
           .replace(/\\/+$/, '');
      return u;
    }

    function hasVer(u) {
      return /\\/v\\d+[a-z0-9_-]*$/i.test(u);
    }

    function updateEndpointPreview() {
      const raw = document.getElementById('providerBaseUrlInput').value;
      const base = normalizeBase(raw);
      const genEl = document.getElementById('previewGenEndpoint');
      const modEl = document.getElementById('previewModelsEndpoint');
      if (!base) {
        genEl.textContent = '-';
        modEl.textContent = '-';
        return;
      }
      const ver = hasVer(base) ? '' : '/v1';
      const suffix =
        selectedProtocol === 'openai-responses'
          ? '/responses'
          : selectedProtocol === 'anthropic-messages'
            ? '/messages'
            : '/chat/completions';
      genEl.textContent = 'POST ' + base + ver + suffix;
      modEl.textContent = 'GET ' + base + ver + '/models';
    }

    document.querySelectorAll('.protocol-card').forEach((card) => {
      card.addEventListener('click', () => {
        selectedProtocol = card.getAttribute('data-protocol') || 'openai-responses';
        document.querySelectorAll('.protocol-card').forEach((c) => {
          c.classList.toggle('active', c.getAttribute('data-protocol') === selectedProtocol);
        });
        const baseUrlInput = document.getElementById('providerBaseUrlInput');
        if (!baseUrlInput.value.trim() || baseUrlInput.value === 'https://api.openai.com/v1' || baseUrlInput.value === 'https://api.anthropic.com/v1') {
          baseUrlInput.value = selectedProtocol === 'anthropic-messages'
            ? 'https://api.anthropic.com/v1'
            : 'https://api.openai.com/v1';
        }
        updateEndpointPreview();
      });
    });

    document.getElementById('providerBaseUrlInput').addEventListener('input', updateEndpointPreview);

    document.getElementById('btnPresetOpenAI').addEventListener('click', () => {
      loadProviderIntoForm({
        id: '',
        name: 'OpenAI Response',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o4-mini'],
        defaultModel: 'gpt-4.1'
      });
    });

    document.getElementById('btnPresetAnthropic').addEventListener('click', () => {
      loadProviderIntoForm({
        id: '',
        name: 'Anthropic Claude',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: '',
        models: ['claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
        defaultModel: 'claude-sonnet-4-20250514'
      });
    });

    document.getElementById('btnToggleApiKey').addEventListener('click', () => {
      const inp = document.getElementById('providerApiKeyInput');
      const btn = document.getElementById('btnToggleApiKey');
      if (inp.type === 'password') {
        inp.type = 'text';
        btn.textContent = isZh ? '隐藏' : 'Hide';
      } else {
        inp.type = 'password';
        btn.textContent = isZh ? '显示' : 'Show';
      }
    });

    document.getElementById('btnAddManualModel').addEventListener('click', () => {
      const val = document.getElementById('activeModelInput').value.trim();
      if (!val) return;
      if (!currentProviderModels.includes(val)) {
        currentProviderModels.unshift(val);
      }
      renderModelChips();
    });

    document.getElementById('modelSearchInput').addEventListener('input', (e) => {
      modelSearchKeyword = (e.target.value || '').trim().toLowerCase();
      renderModelChips();
    });

    document.getElementById('btnFetchModels').addEventListener('click', () => {
      const baseUrl = document.getElementById('providerBaseUrlInput').value.trim();
      const apiKey = document.getElementById('providerApiKeyInput').value.trim();
      if (!baseUrl) {
        showBanner('error', isZh ? '请先填写供应商 Base URL' : 'Please enter Base URL first');
        return;
      }
      vscode.postMessage({
        type: 'fetchModels',
        payload: { baseUrl, apiKey, protocol: selectedProtocol }
      });
    });

    document.getElementById('btnTestConnection').addEventListener('click', () => {
      const baseUrl = document.getElementById('providerBaseUrlInput').value.trim();
      const apiKey = document.getElementById('providerApiKeyInput').value.trim();
      const model = document.getElementById('activeModelInput').value.trim() || currentProviderModels[0] || '';
      if (!baseUrl || !model) {
        showBanner('error', isZh ? '请先填写 Base URL 并选择或输入一个模型名称' : 'Please enter Base URL and select a model');
        return;
      }
      vscode.postMessage({
        type: 'testConnection',
        payload: { baseUrl, apiKey, protocol: selectedProtocol, model }
      });
    });

    function submitProviderForm(setAsActive) {
      const name = document.getElementById('providerNameInput').value.trim();
      const baseUrl = document.getElementById('providerBaseUrlInput').value.trim();
      const apiKey = document.getElementById('providerApiKeyInput').value.trim();
      const defaultModel = document.getElementById('activeModelInput').value.trim() || currentProviderModels[0] || '';

      if (!name) {
        showBanner('error', isZh ? '请填写供应商名称' : 'Provider name is required');
        return;
      }
      if (!baseUrl) {
        showBanner('error', isZh ? '请填写供应商 Base URL' : 'Base URL is required');
        return;
      }

      if (defaultModel && !currentProviderModels.includes(defaultModel)) {
        currentProviderModels.unshift(defaultModel);
      }

      vscode.postMessage({
        type: 'saveProvider',
        payload: {
          id: editingProviderId,
          name,
          protocol: selectedProtocol,
          baseUrl,
          apiKey,
          models: currentProviderModels,
          defaultModel,
          setAsActive
        }
      });
    }

    document.getElementById('btnSaveAndActivateProvider').addEventListener('click', () => submitProviderForm(true));
    document.getElementById('btnSaveProviderOnly').addEventListener('click', () => submitProviderForm(false));

    document.getElementById('btnDeleteProvider').addEventListener('click', () => {
      if (!editingProviderId) return;
      const name = document.getElementById('providerNameInput').value.trim();
      vscode.postMessage({
        type: 'deleteProvider',
        payload: { providerId: editingProviderId, providerName: name }
      });
    });

    document.getElementById('btnGenerateNow').addEventListener('click', () => {
      vscode.postMessage({ type: 'triggerGenerateNow' });
    });

    document.getElementById('btnNewCustomTemplate').addEventListener('click', () => {
      openCustomTemplateEditor({
        id: '',
        name: '',
        badge: isZh ? '自定义' : 'Custom',
        description: '',
        example: 'feat(module): concise summary\\n\\n- detail 1\\n- detail 2',
        systemPrompt: isZh
          ? '请按照以下格式生成 Git Commit Message：\\n<type>(<scope>): <摘要>\\n\\n- <改动要点>'
          : 'Generate a Git Commit Message following this format:\\n<type>(<scope>): <summary>\\n\\n- <key changes>'
      });
    });

    document.getElementById('btnCloseCustomEditor').addEventListener('click', () => {
      document.getElementById('customTemplateEditor').classList.remove('show');
    });

    document.getElementById('btnSaveCustomTpl').addEventListener('click', () => {
      const id = document.getElementById('customTplId').value.trim();
      const name = document.getElementById('customTplName').value.trim();
      const badge = document.getElementById('customTplBadge').value.trim();
      const description = document.getElementById('customTplDesc').value.trim();
      const example = document.getElementById('customTplExample').value;
      const systemPrompt = document.getElementById('customTplPrompt').value.trim();

      if (!name || !systemPrompt) {
        showToast(isZh ? '请填写模板名称与 System Prompt' : 'Please enter template name and System Prompt');
        return;
      }

      vscode.postMessage({
        type: 'saveCustomTemplate',
        payload: { id, name, badge, description, example, systemPrompt, setAsActive: true }
      });
      document.getElementById('customTemplateEditor').classList.remove('show');
    });

    function openCustomTemplateEditor(tpl) {
      document.getElementById('customTplId').value = tpl.id || '';
      document.getElementById('customTplName').value = tpl.name || '';
      document.getElementById('customTplBadge').value = tpl.badge || (isZh ? '自定义' : 'Custom');
      document.getElementById('customTplDesc').value = tpl.description || '';
      document.getElementById('customTplExample').value = tpl.example || '';
      document.getElementById('customTplPrompt').value = tpl.systemPrompt || '';
      document.getElementById('customTplEditorTitle').textContent = tpl.id
        ? (isZh ? '编辑自定义模板' : 'Edit Custom Template')
        : (isZh ? '新建自定义模板' : 'New Custom Template');
      const box = document.getElementById('customTemplateEditor');
      box.classList.add('show');
      box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function savePreferencesFromUI() {
      vscode.postMessage({
        type: 'updatePreferences',
        payload: {
          commitLanguage: document.getElementById('prefCommitLanguage').value,
          askTemplateBeforeGenerate: document.getElementById('prefAskTemplate').checked,
          diffScope: document.getElementById('prefDiffScope').value,
          streamOutput: document.getElementById('prefStreamOutput').checked,
          showStatusBar: document.getElementById('prefShowStatusBar').checked,
          maxDiffLines: Number(document.getElementById('prefMaxDiffLines').value) || 1500,
          customInstructions: document.getElementById('prefCustomInstructions').value
        }
      });
    }

    document.getElementById('prefCommitLanguage').addEventListener('change', savePreferencesFromUI);
    document.getElementById('prefAskTemplate').addEventListener('change', savePreferencesFromUI);
    document.getElementById('prefDiffScope').addEventListener('change', savePreferencesFromUI);
    document.getElementById('prefStreamOutput').addEventListener('change', savePreferencesFromUI);
    document.getElementById('prefShowStatusBar').addEventListener('change', savePreferencesFromUI);
    document.getElementById('btnSavePreferences').addEventListener('click', savePreferencesFromUI);

    function showBanner(type, text) {
      const el = document.getElementById('providerActionBanner');
      el.className = 'status-banner show ' + (type === 'error' ? 'error' : 'success');
      el.textContent = text;
    }

    function hideBanner() {
      const el = document.getElementById('providerActionBanner');
      el.className = 'status-banner';
      el.textContent = '';
    }

    let toastTimer = null;
    function showToast(text) {
      const el = document.getElementById('toastEl');
      el.textContent = text;
      el.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.classList.remove('show');
      }, 2800);
    }

    function loadProviderIntoForm(p) {
      hideBanner();
      editingProviderId = p.id || '';
      document.getElementById('providerIdInput').value = editingProviderId;
      document.getElementById('providerNameInput').value = p.name || '';
      document.getElementById('providerBaseUrlInput').value = p.baseUrl || '';
      document.getElementById('providerApiKeyInput').value = p.apiKey || '';
      selectedProtocol = p.protocol || 'openai-responses';
      currentProviderModels = Array.isArray(p.models) ? [...p.models] : [];

      const activeModel =
        (p.id && p.id === appState.preferences.activeProviderId && appState.preferences.activeModelId)
          ? appState.preferences.activeModelId
          : (p.defaultModel || currentProviderModels[0] || '');
      document.getElementById('activeModelInput').value = activeModel;

      document.querySelectorAll('.protocol-card').forEach((c) => {
        c.classList.toggle('active', c.getAttribute('data-protocol') === selectedProtocol);
      });

      document.getElementById('providerFormTitle').textContent = editingProviderId
        ? (isZh ? '编辑供应商：' : 'Edit Provider: ') + p.name
        : (isZh ? '添加 AI 模型供应商' : 'Add AI Provider');
      document.getElementById('providerFormModeBadge').textContent = editingProviderId
        ? (isZh ? '编辑模式' : 'Editing')
        : (isZh ? '新建模式' : 'New');
      document.getElementById('btnDeleteProvider').style.display = editingProviderId ? 'inline-flex' : 'none';

      updateEndpointPreview();
      renderProviderList();
      renderModelChips();
    }

    function renderCompactTopbarStatus() {
      const prefs = appState.preferences;
      const activeProvider = appState.providers.find((p) => p.id === prefs.activeProviderId) || appState.providers[0];
      const activeTemplate = appState.templates.find((tpl) => tpl.id === prefs.activeTemplateId) || appState.templates[0];
      const dot = document.getElementById('summaryDot');
      const textEl = document.getElementById('summaryText');
      const briefBox = document.getElementById('compactStatusBrief');
      const langTag = appState.resolvedCommitLanguage === 'zh' ? '中文' : 'EN';

      if (activeProvider) {
        const modelName = prefs.activeModelId || activeProvider.defaultModel || activeProvider.models[0] || (isZh ? '未选模型' : 'No model');
        const tplName = activeTemplate ? activeTemplate.name.split(' (')[0] : 'Conventional';
        dot.className = 'summary-dot';
        const summaryStr = modelName + ' · ' + tplName + ' (' + langTag + ')';
        textEl.textContent = summaryStr;
        briefBox.title = activeProvider.name + ' | ' + modelName + ' | ' + (activeTemplate ? activeTemplate.name : '');
      } else {
        dot.className = 'summary-dot warn';
        textEl.textContent = isZh ? '未配置供应商' : 'No provider configured';
      }

      // 更新模板库语言按钮高亮
      document.querySelectorAll('#langSegmentedGroup .segmented-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === appState.resolvedCommitLanguage);
      });
    }

    function renderProviderList() {
      const container = document.getElementById('providerListContainer');
      container.innerHTML = '';

      if (appState.providers.length === 0) {
        const empty = document.createElement('div');
        empty.style.color = 'var(--text-muted)';
        empty.style.fontSize = '11.5px';
        empty.style.padding = '8px 2px';
        empty.textContent = isZh
          ? '暂无供应商，点击上方预设或右侧添加。'
          : 'No providers yet. Click a preset above or use the form.';
        container.appendChild(empty);
        return;
      }

      appState.providers.forEach((p) => {
        const isCurrentActive = p.id === appState.preferences.activeProviderId;
        const isSelected = p.id === editingProviderId;
        const item = document.createElement('div');
        item.className = 'provider-item' + (isSelected ? ' selected' : '');

        const top = document.createElement('div');
        top.className = 'provider-item-top';

        const nameEl = document.createElement('div');
        nameEl.className = 'provider-item-name';
        nameEl.textContent = p.name;
        top.appendChild(nameEl);

        const badgesWrap = document.createElement('div');
        badgesWrap.style.display = 'flex';
        badgesWrap.style.gap = '4px';

        if (isCurrentActive) {
          const actBadge = document.createElement('span');
          actBadge.className = 'badge badge-active';
          actBadge.textContent = isZh ? '当前' : 'Active';
          badgesWrap.appendChild(actBadge);
        }

        const protoBadge = document.createElement('span');
        protoBadge.className = 'badge';
        protoBadge.textContent =
          p.protocol === 'anthropic-messages'
            ? 'Anthropic'
            : p.protocol === 'openai-responses'
              ? 'Responses'
              : 'Chat';
        badgesWrap.appendChild(protoBadge);

        top.appendChild(badgesWrap);
        item.appendChild(top);

        const meta = document.createElement('div');
        meta.className = 'provider-item-meta';
        const modelText = isCurrentActive
          ? (appState.preferences.activeModelId || p.defaultModel || '-')
          : (p.defaultModel || p.models[0] || '-');
        meta.innerHTML = '<span><strong>' + escapeHtml(modelText) + '</strong> (' + (p.models ? p.models.length : 0) + ')</span>' +
                         '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(p.baseUrl) + '</span>';
        item.appendChild(meta);

        item.addEventListener('click', () => {
          loadProviderIntoForm(p);
        });

        container.appendChild(item);
      });
    }

    function renderModelChips() {
      const container = document.getElementById('modelsChipsContainer');
      const currentInputVal = document.getElementById('activeModelInput').value.trim();
      container.innerHTML = '';

      const filtered = currentProviderModels.filter((m) =>
        !modelSearchKeyword || m.toLowerCase().includes(modelSearchKeyword)
      );

      if (filtered.length === 0) {
        const hint = document.createElement('span');
        hint.style.color = 'var(--text-muted)';
        hint.style.fontSize = '11.5px';
        hint.textContent = currentProviderModels.length === 0
          ? (isZh ? '点击「🔄 自动获取模型列表」拉取可用模型，或直接输入模型 ID。' : 'Click "Fetch Models" to discover models, or enter a model ID above.')
          : (isZh ? '无匹配模型' : 'No matching models');
        container.appendChild(hint);
        return;
      }

      filtered.forEach((modelId) => {
        const chip = document.createElement('div');
        const isActive = modelId === currentInputVal;
        chip.className = 'model-chip' + (isActive ? ' active' : '');

        const label = document.createElement('span');
        label.textContent = (isActive ? '✓ ' : '') + modelId;
        chip.appendChild(label);

        const del = document.createElement('span');
        del.className = 'remove-model';
        del.textContent = '×';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          currentProviderModels = currentProviderModels.filter((item) => item !== modelId);
          renderModelChips();
        });
        chip.appendChild(del);

        chip.addEventListener('click', () => {
          document.getElementById('activeModelInput').value = modelId;
          renderModelChips();
          if (editingProviderId) {
            vscode.postMessage({
              type: 'setActiveProviderModel',
              payload: { providerId: editingProviderId, modelId }
            });
          }
        });

        container.appendChild(chip);
      });
    }

    function renderTemplatesGrid() {
      const container = document.getElementById('templatesGridContainer');
      container.innerHTML = '';
      const activeId = appState.preferences.activeTemplateId;

      appState.templates.forEach((tpl) => {
        const isActive = tpl.id === activeId;
        const card = document.createElement('div');
        card.className = 'template-card' + (isActive ? ' active' : '');

        const topWrap = document.createElement('div');

        const header = document.createElement('div');
        header.className = 'template-card-header';

        const title = document.createElement('h4');
        title.className = 'template-card-title';
        title.textContent = tpl.name;
        header.appendChild(title);

        const badgeWrap = document.createElement('div');
        badgeWrap.style.display = 'flex';
        badgeWrap.style.gap = '4px';

        if (isActive) {
          const act = document.createElement('span');
          act.className = 'badge badge-active';
          act.textContent = isZh ? '✓ 默认' : '✓ Default';
          badgeWrap.appendChild(act);
        }

        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = tpl.badge || (tpl.isBuiltIn ? 'Built-in' : 'Custom');
        badgeWrap.appendChild(b);

        header.appendChild(badgeWrap);
        topWrap.appendChild(header);

        const desc = document.createElement('div');
        desc.className = 'template-card-desc';
        desc.textContent = tpl.description;
        topWrap.appendChild(desc);

        const ex = document.createElement('div');
        ex.className = 'template-example';
        ex.textContent = tpl.example || tpl.systemPrompt;
        topWrap.appendChild(ex);

        card.appendChild(topWrap);

        const actions = document.createElement('div');
        actions.className = 'template-actions';

        const leftBtns = document.createElement('div');
        leftBtns.style.display = 'flex';
        leftBtns.style.gap = '6px';

        const selectBtn = document.createElement('button');
        selectBtn.className = 'btn btn-sm ' + (isActive ? 'btn-secondary' : 'btn-primary');
        selectBtn.textContent = isActive
          ? (isZh ? '✓ 当前默认' : '✓ Default')
          : (isZh ? '设为默认' : 'Set Default');
        selectBtn.disabled = isActive;
        selectBtn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'selectTemplate',
            payload: { templateId: tpl.id }
          });
        });
        leftBtns.appendChild(selectBtn);

        const genBtn = document.createElement('button');
        genBtn.className = 'btn btn-sm btn-secondary';
        genBtn.textContent = isZh ? '✨ 用此模板生成' : '✨ Generate';
        genBtn.addEventListener('click', () => {
          vscode.postMessage({
            type: 'generateWithTemplateId',
            payload: { templateId: tpl.id }
          });
        });
        leftBtns.appendChild(genBtn);

        actions.appendChild(leftBtns);

        const rightBtns = document.createElement('div');
        rightBtns.style.display = 'flex';
        rightBtns.style.gap = '6px';

        if (tpl.isBuiltIn) {
          const dupBtn = document.createElement('button');
          dupBtn.className = 'btn btn-sm btn-secondary';
          dupBtn.textContent = isZh ? '复制自定义' : 'Duplicate';
          dupBtn.addEventListener('click', () => {
            openCustomTemplateEditor({
              id: '',
              name: tpl.name + (isZh ? ' (自定义)' : ' (Custom)'),
              badge: isZh ? '自定义' : 'Custom',
              description: tpl.description,
              example: tpl.example,
              systemPrompt: tpl.systemPrompt
            });
          });
          rightBtns.appendChild(dupBtn);
        } else {
          const editBtn = document.createElement('button');
          editBtn.className = 'btn btn-sm btn-secondary';
          editBtn.textContent = isZh ? '编辑' : 'Edit';
          editBtn.addEventListener('click', () => {
            openCustomTemplateEditor(tpl);
          });
          rightBtns.appendChild(editBtn);

          const delBtn = document.createElement('button');
          delBtn.className = 'btn btn-sm btn-danger';
          delBtn.textContent = isZh ? '删除' : 'Delete';
          delBtn.addEventListener('click', () => {
            vscode.postMessage({
              type: 'deleteCustomTemplate',
              payload: { templateId: tpl.id, templateName: tpl.name }
            });
          });
          rightBtns.appendChild(delBtn);
        }

        actions.appendChild(rightBtns);
        card.appendChild(actions);

        container.appendChild(card);
      });
    }

    function renderPreferences() {
      const prefs = appState.preferences;
      document.getElementById('prefCommitLanguage').value = prefs.commitLanguage || 'auto';
      document.getElementById('prefAskTemplate').checked = Boolean(prefs.askTemplateBeforeGenerate);
      document.getElementById('prefDiffScope').value = prefs.diffScope || 'auto';
      document.getElementById('prefStreamOutput').checked = prefs.streamOutput !== false;
      document.getElementById('prefShowStatusBar').checked = prefs.showStatusBar !== false;
      document.getElementById('prefMaxDiffLines').value = prefs.maxDiffLines || 1500;
      document.getElementById('prefCustomInstructions').value = prefs.customInstructions || '';
    }

    function escapeHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;

      switch (msg.type) {
        case 'switchTab': {
          if (msg.tab) switchTab(msg.tab);
          break;
        }

        case 'stateUpdated': {
          appState = msg.payload;
          renderCompactTopbarStatus();
          renderProviderList();
          renderTemplatesGrid();
          renderPreferences();

          const existing = appState.providers.find((p) => p.id === editingProviderId);
          if (existing) {
            loadProviderIntoForm(existing);
          } else if (appState.providers.length > 0) {
            const active =
              appState.providers.find((p) => p.id === appState.preferences.activeProviderId) ||
              appState.providers[0];
            loadProviderIntoForm(active);
          } else if (!document.getElementById('providerNameInput').value) {
            document.getElementById('btnPresetOpenAI').click();
          }
          break;
        }

        case 'providerSaved': {
          editingProviderId = msg.providerId;
          showBanner('success', '✓ ' + msg.message);
          showToast(msg.message);
          break;
        }

        case 'fetchModelsStatus': {
          const btn = document.getElementById('btnFetchModels');
          btn.disabled = Boolean(msg.loading);
          btn.textContent = msg.loading
            ? (isZh ? '⏳ 正在拉取...' : '⏳ Fetching...')
            : ('🔄 ' + (isZh ? '自动获取模型列表 (/v1/models)' : 'Fetch Models (/v1/models)'));
          break;
        }

        case 'fetchModelsResult': {
          const btn = document.getElementById('btnFetchModels');
          btn.disabled = false;
          btn.textContent = '🔄 ' + (isZh ? '自动获取模型列表 (/v1/models)' : 'Fetch Models (/v1/models)');

          if (msg.ok) {
            const fetchedIds = (msg.models || []).map((m) => m.id);
            const merged = Array.from(new Set([...fetchedIds, ...currentProviderModels]));
            currentProviderModels = merged;
            if (!document.getElementById('activeModelInput').value.trim() && fetchedIds.length > 0) {
              document.getElementById('activeModelInput').value = fetchedIds[0];
            }
            renderModelChips();
            showBanner(
              'success',
              isZh
                ? ('✓ 成功获取到 ' + fetchedIds.length + ' 个模型，点击下方标签即可选用。')
                : ('✓ Fetched ' + fetchedIds.length + ' models from ' + msg.endpoint)
            );
          } else {
            showBanner('error', '✗ ' + (msg.error || 'Failed to fetch models'));
          }
          break;
        }

        case 'testConnectionStatus': {
          const btn = document.getElementById('btnTestConnection');
          btn.disabled = Boolean(msg.loading);
          btn.textContent = msg.loading
            ? (isZh ? '⏳ 测试中...' : '⏳ Testing...')
            : ('⚡ ' + (isZh ? '测试连接' : 'Test Connection'));
          break;
        }

        case 'testConnectionResult': {
          const btn = document.getElementById('btnTestConnection');
          btn.disabled = false;
          btn.textContent = '⚡ ' + (isZh ? '测试连接' : 'Test Connection');

          if (msg.ok) {
            showBanner(
              'success',
              isZh
                ? ('✓ 连接成功 (' + msg.latencyMs + 'ms) · 端点: ' + msg.endpoint)
                : ('✓ Connected (' + msg.latencyMs + 'ms) · ' + msg.endpoint)
            );
          } else {
            showBanner('error', '✗ ' + (msg.error || 'Connection failed'));
          }
          break;
        }

        case 'customTemplateSaved': {
          showToast(msg.message);
          break;
        }

        case 'toast': {
          showToast(msg.message);
          break;
        }
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
