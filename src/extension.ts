import * as vscode from 'vscode';
import { ConfigManager } from './storage/configManager';
import { GitService } from './git/gitService';
import { CommandHandlers } from './commands/commandHandlers';
import { DashboardPanel } from './webview/dashboardPanel';
import { PROTOCOL_METADATA } from './constants';
import { t } from './i18n';

let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'aiGitMessage.isGenerating', false);

  const configManager = new ConfigManager(context);
  const gitService = new GitService();
  const handlers = new CommandHandlers(context, configManager, gitService);

  context.subscriptions.push(
    vscode.commands.registerCommand('aiGitMessage.generate', (scmArg?: any, forcedTemplateId?: string) =>
      handlers.generate(scmArg, forcedTemplateId)
    ),
    vscode.commands.registerCommand('aiGitMessage.stopGenerate', () => handlers.stopGenerate()),
    vscode.commands.registerCommand('aiGitMessage.generateWithTemplate', (scmArg?: any) =>
      handlers.generateWithTemplate(scmArg)
    ),
    vscode.commands.registerCommand('aiGitMessage.selectTemplate', () => handlers.selectTemplate()),
    vscode.commands.registerCommand('aiGitMessage.selectModel', () => handlers.selectModel()),
    vscode.commands.registerCommand('aiGitMessage.addProvider', () =>
      handlers.addProviderQuickWizard()
    ),
    vscode.commands.registerCommand(
      'aiGitMessage.openDashboard',
      (tab?: 'providers' | 'templates' | 'settings') =>
        DashboardPanel.createOrShow(context, configManager, tab || 'providers')
    ),
    vscode.commands.registerCommand('aiGitMessage.quickMenu', async () => {
      const { provider, modelId } = await configManager.getActiveProviderAndModel();
      const tpl = configManager.getActiveTemplate();
      const lang = configManager.getResolvedCommitLanguage();

      const picked = await vscode.window.showQuickPick(
        [
          {
            label: t('$(sparkle) 立即生成 Git Commit Message', '$(sparkle) Generate Git Commit Message Now'),
            description: `${tpl.name} (${lang === 'zh' ? '中文' : 'EN'})`,
            action: 'generate'
          },
          {
            label: t('$(wand) 选择模板并生成...', '$(wand) Select Template & Generate...'),
            description: t('临时指定模板或切换中英文', 'Pick a template or toggle language'),
            action: 'generateWithTemplate'
          },
          {
            label: t('$(book) 切换默认 Git Message 模板', '$(book) Switch Default Template'),
            description: `${tpl.name}`,
            action: 'selectTemplate'
          },
          {
            label: t('$(hubot) 切换 AI 模型 / 自动获取模型列表', '$(hubot) Switch AI Model / Auto-fetch Models'),
            description: provider
              ? `${provider.name} · ${modelId || t('未选模型', 'No model')}`
              : t('尚未配置供应商', 'Not configured'),
            action: 'selectModel'
          },
          {
            label: t(
              '$(add) 添加 AI 模型供应商 (OpenAI Response / Anthropic Message)',
              '$(add) Add AI Provider (OpenAI Response / Anthropic Message)'
            ),
            description: t('快速向导', 'Quick wizard'),
            action: 'addProvider'
          },
          {
            label: t('$(settings-gear) 打开 AI Git Message 配置中心', '$(settings-gear) Open Settings Center'),
            description: t('可视化管理供应商、模型与模板', 'Visual settings dashboard'),
            action: 'openDashboard'
          }
        ],
        {
          title: t('AI Git Message 快捷菜单', 'AI Git Message Quick Menu'),
          placeHolder: t('选择要执行的操作', 'Choose an action')
        }
      );

      if (!picked) {
        return;
      }
      await vscode.commands.executeCommand(`aiGitMessage.${picked.action}`);
    })
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  statusBarItem.command = 'aiGitMessage.quickMenu';
  context.subscriptions.push(statusBarItem);

  const updateStatusBar = async () => {
    if (!statusBarItem) {
      return;
    }
    const prefs = configManager.getPreferences();
    if (!prefs.showStatusBar) {
      statusBarItem.hide();
      return;
    }

    const { provider, modelId } = await configManager.getActiveProviderAndModel();
    const tpl = configManager.getActiveTemplate();
    const lang = configManager.getResolvedCommitLanguage();

    if (provider && modelId) {
      const shortModel = modelId.length > 22 ? `${modelId.slice(0, 20)}..` : modelId;
      statusBarItem.text = `$(sparkle) ${shortModel}`;
    } else {
      statusBarItem.text = t('$(sparkle) AI Git (未配置)', '$(sparkle) AI Git (Setup)');
    }

    const protoName = provider ? PROTOCOL_METADATA[provider.protocol]?.shortBadge : t('未配置', 'None');
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    md.appendMarkdown(`**$(sparkle) AI Git Message**\n\n`);
    md.appendMarkdown(
      `- **${t('供应商', 'Provider')}**: ${provider ? `${provider.name} (\`${protoName}\`)` : t('未配置', 'Not configured')}\n`
    );
    md.appendMarkdown(`- **${t('模型', 'Model')}**: \`${modelId || t('未选择', 'None')}\`\n`);
    md.appendMarkdown(`- **${t('模板', 'Template')}**: ${tpl.name} (\`${lang === 'zh' ? '中文' : 'EN'}\`)\n\n`);
    md.appendMarkdown(
      `[$(sparkle) ${t('立即生成', 'Generate')}](command:aiGitMessage.generate) &nbsp;|&nbsp; ` +
        `[$(book) ${t('切换模板', 'Template')}](command:aiGitMessage.selectTemplate) &nbsp;|&nbsp; ` +
        `[$(hubot) ${t('切换模型', 'Model')}](command:aiGitMessage.selectModel) &nbsp;|&nbsp; ` +
        `[$(settings-gear) ${t('配置中心', 'Settings')}](command:aiGitMessage.openDashboard)`
    );

    statusBarItem.tooltip = md;
    statusBarItem.show();
  };

  await updateStatusBar();
  context.subscriptions.push(
    configManager.onDidChange(() => {
      updateStatusBar();
    })
  );
}

export function deactivate(): void {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}
