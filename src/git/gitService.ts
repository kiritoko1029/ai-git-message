import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import { DiffContext, DiffScope, ResolvedLanguage } from '../types';
import { getBaseSystemRules } from '../constants';
import { t } from '../i18n';

const execFileAsync = promisify(execFile);

export interface GitRepositoryHandle {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  state?: {
    HEAD?: { name?: string };
    indexChanges?: any[];
    workingTreeChanges?: any[];
  };
}

const LOCKFILE_EXCLUDES = [
  ':(exclude)package-lock.json',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)yarn.lock',
  ':(exclude)bun.lockb',
  ':(exclude)Cargo.lock',
  ':(exclude)poetry.lock',
  ':(exclude)composer.lock',
  ':(exclude)*.min.js',
  ':(exclude)*.min.css',
  ':(exclude)*.map'
];

export class GitService {
  private async getGitApi(): Promise<any | undefined> {
    const ext = vscode.extensions.getExtension<any>('vscode.git');
    if (!ext) {
      return undefined;
    }
    if (!ext.isActive) {
      await ext.activate();
    }
    return ext.exports?.getAPI?.(1);
  }

  public async getRepositories(): Promise<GitRepositoryHandle[]> {
    const api = await this.getGitApi();
    if (!api || !Array.isArray(api.repositories)) {
      return [];
    }
    return api.repositories;
  }

  public async resolveTargetRepository(scmArg?: any): Promise<GitRepositoryHandle | undefined> {
    const repos = await this.getRepositories();
    if (repos.length === 0) {
      vscode.window.showWarningMessage(
        t(
          'AI Git Message: 当前工作区未检测到 Git 仓库',
          'AI Git Message: No Git repository found in current workspace'
        )
      );
      return undefined;
    }

    if (repos.length === 1) {
      return repos[0];
    }

    if (scmArg) {
      const targetUri: vscode.Uri | undefined =
        scmArg.rootUri instanceof vscode.Uri
          ? scmArg.rootUri
          : scmArg.sourceControl?.rootUri instanceof vscode.Uri
            ? scmArg.sourceControl.rootUri
            : undefined;

      if (targetUri) {
        const matched = repos.find((r) => r.rootUri.fsPath === targetUri.fsPath);
        if (matched) {
          return matched;
        }
      }
    }

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri && activeUri.scheme === 'file') {
      const matched = repos.find((r) => activeUri.fsPath.startsWith(r.rootUri.fsPath));
      if (matched) {
        return matched;
      }
    }

    const reposWithChanges = repos.filter(
      (r) =>
        (r.state?.indexChanges && r.state.indexChanges.length > 0) ||
        (r.state?.workingTreeChanges && r.state.workingTreeChanges.length > 0)
    );
    if (reposWithChanges.length === 1) {
      return reposWithChanges[0];
    }

    const picked = await vscode.window.showQuickPick(
      repos.map((r) => ({
        label: `$(repo) ${path.basename(r.rootUri.fsPath)}`,
        description: r.state?.HEAD?.name
          ? `${t('分支', 'Branch')}: ${r.state.HEAD.name}`
          : r.rootUri.fsPath,
        detail: r.rootUri.fsPath,
        repo: r
      })),
      {
        placeHolder: t(
          '检测到多个 Git 仓库，请选择要生成提交信息的仓库',
          'Multiple Git repositories detected, select one to generate commit message'
        )
      }
    );

    return picked?.repo;
  }

  private async runGit(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, {
        cwd,
        maxBuffer: 15 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C.UTF-8' }
      });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  public async collectDiffContext(
    repo: GitRepositoryHandle,
    diffScope: DiffScope,
    maxDiffLines: number
  ): Promise<DiffContext | undefined> {
    const cwd = repo.rootUri.fsPath;
    const repoName = path.basename(cwd);

    const statusSummary = await this.runGit(cwd, ['status', '--short']);
    if (!statusSummary) {
      vscode.window.showInformationMessage(
        t(
          'AI Git Message: 当前仓库没有检测到任何代码变更',
          'AI Git Message: No working tree or staged changes detected'
        )
      );
      return undefined;
    }

    const changedFilesCount = statusSummary.split(/\r?\n/).filter(Boolean).length;
    const branch =
      repo.state?.HEAD?.name ||
      (await this.runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])) ||
      'HEAD';

    const recentLogRaw = await this.runGit(cwd, ['log', '-n', '5', '--pretty=format:%s']);
    const recentCommits = recentLogRaw
      ? recentLogRaw
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const stagedStat = await this.runGit(cwd, ['diff', '--cached', '--stat']);
    const hasStaged = stagedStat.length > 0;

    let scopeUsed: 'staged' | 'workingTree' | 'all' = 'staged';
    let diffStat = '';
    let rawDiff = '';

    if (diffScope === 'staged') {
      if (!hasStaged) {
        const optWork = t('分析工作区变更', 'Analyze Working Tree');
        const optStageAll = t('暂存全部并生成 (git add -A)', 'Stage All & Generate (git add -A)');
        const optCancel = t('取消', 'Cancel');
        const action = await vscode.window.showWarningMessage(
          t(
            '当前暂存区 (Staged Changes) 为空，是否改为分析工作区未暂存变更，或先暂存全部文件？',
            'Staged changes are empty. Would you like to analyze working tree changes or stage all files first?'
          ),
          optWork,
          optStageAll,
          optCancel
        );
        if (action === optStageAll) {
          await this.runGit(cwd, ['add', '-A']);
          scopeUsed = 'staged';
          diffStat = await this.runGit(cwd, ['diff', '--cached', '--stat']);
          rawDiff = await this.runGit(cwd, [
            'diff',
            '--cached',
            '--no-color',
            '--unified=3',
            '--',
            '.',
            ...LOCKFILE_EXCLUDES
          ]);
        } else if (action === optWork) {
          scopeUsed = 'workingTree';
        } else {
          return undefined;
        }
      } else {
        scopeUsed = 'staged';
        diffStat = stagedStat;
        rawDiff = await this.runGit(cwd, [
          'diff',
          '--cached',
          '--no-color',
          '--unified=3',
          '--',
          '.',
          ...LOCKFILE_EXCLUDES
        ]);
      }
    } else if (diffScope === 'auto') {
      if (hasStaged) {
        scopeUsed = 'staged';
        diffStat = stagedStat;
        rawDiff = await this.runGit(cwd, [
          'diff',
          '--cached',
          '--no-color',
          '--unified=3',
          '--',
          '.',
          ...LOCKFILE_EXCLUDES
        ]);
      } else {
        scopeUsed = 'workingTree';
      }
    } else {
      scopeUsed = 'all';
    }

    if (scopeUsed === 'workingTree') {
      diffStat = await this.runGit(cwd, ['diff', '--stat']);
      rawDiff = await this.runGit(cwd, [
        'diff',
        '--no-color',
        '--unified=3',
        '--',
        '.',
        ...LOCKFILE_EXCLUDES
      ]);
      const untrackedSnippet = await this.collectUntrackedFilesPreview(cwd);
      if (untrackedSnippet) {
        rawDiff = [rawDiff, untrackedSnippet].filter(Boolean).join('\n\n');
      }
    } else if (scopeUsed === 'all') {
      diffStat = await this.runGit(cwd, ['diff', 'HEAD', '--stat']);
      rawDiff = await this.runGit(cwd, [
        'diff',
        'HEAD',
        '--no-color',
        '--unified=3',
        '--',
        '.',
        ...LOCKFILE_EXCLUDES
      ]);
      if (!rawDiff) {
        rawDiff = await this.runGit(cwd, [
          'diff',
          '--cached',
          '--no-color',
          '--unified=3',
          '--',
          '.',
          ...LOCKFILE_EXCLUDES
        ]);
      }
      const untrackedSnippet = await this.collectUntrackedFilesPreview(cwd);
      if (untrackedSnippet) {
        rawDiff = [rawDiff, untrackedSnippet].filter(Boolean).join('\n\n');
      }
    }

    if (!rawDiff) {
      rawDiff = diffStat || statusSummary;
    }

    const lines = rawDiff.split(/\r?\n/);
    const limit = Math.max(200, maxDiffLines || 1500);
    const truncated = lines.length > limit;
    const diffContent = truncated
      ? `${lines.slice(0, limit).join('\n')}\n\n... [Diff truncated: ${lines.length} total lines, showing first ${limit} lines]`
      : rawDiff;

    return {
      repoRoot: cwd,
      repoName,
      branch,
      scopeUsed,
      changedFilesCount,
      statusSummary,
      diffStat: diffStat || statusSummary,
      diffContent,
      recentCommits,
      truncated
    };
  }

  private async collectUntrackedFilesPreview(cwd: string): Promise<string> {
    const untrackedRaw = await this.runGit(cwd, ['ls-files', '--others', '--exclude-standard']);
    if (!untrackedRaw) {
      return '';
    }
    const files = untrackedRaw.split(/\r?\n/).filter(Boolean).slice(0, 15);
    const snippets: string[] = [];

    for (const relPath of files) {
      if (/\.(lock|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|pdf|zip|gz|map|min\.js)$/i.test(relPath)) {
        snippets.push(`diff --git a/${relPath} b/${relPath}\nnew file: ${relPath} (binary or asset)`);
        continue;
      }
      try {
        const fullPath = path.join(cwd, relPath);
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.size <= 32 * 1024) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const previewLines = content.split(/\r?\n/).slice(0, 60);
          const formatted = previewLines.map((l) => `+${l}`).join('\n');
          snippets.push(
            `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n${formatted}`
          );
        } else {
          snippets.push(`diff --git a/${relPath} b/${relPath}\nnew file: ${relPath} (${stat.size} bytes)`);
        }
      } catch {
        // ignore unreadable file
      }
    }

    return snippets.join('\n\n');
  }

  public buildPrompts(
    diffContext: DiffContext,
    templateSystemPrompt: string,
    lang: ResolvedLanguage,
    customInstructions?: string
  ): { systemPrompt: string; userPrompt: string } {
    const systemParts = [getBaseSystemRules(lang), templateSystemPrompt.trim()];
    if (customInstructions && customInstructions.trim()) {
      const header = lang === 'en' ? '[Additional User Instructions]' : '【用户附加全局要求】';
      systemParts.push(`${header}\n${customInstructions.trim()}`);
    }

    const scopeLabel =
      diffContext.scopeUsed === 'staged'
        ? 'Staged Changes'
        : diffContext.scopeUsed === 'workingTree'
          ? 'Working Tree Changes'
          : 'All Changes';

    const recentCommitsBlock =
      diffContext.recentCommits.length > 0
        ? `\n[Recent Commits (for style/scope reference only)]\n${diffContext.recentCommits
            .map((c) => `- ${c}`)
            .join('\n')}\n`
        : '';

    const userPrompt = `Generate a Git Commit Message for the following repository changes:

[Repository Info]
- Repository: ${diffContext.repoName}
- Branch: ${diffContext.branch}
- Scope: ${scopeLabel} (${diffContext.changedFilesCount} files)
- Output Language: ${lang === 'en' ? 'English' : 'Simplified Chinese (简体中文)'}
${recentCommitsBlock}
[File Status (git status --short)]
${diffContext.statusSummary}

[Diff Stat (git diff --stat)]
${diffContext.diffStat}

[Code Diff (git diff)]
${diffContext.diffContent}`;

    return {
      systemPrompt: systemParts.join('\n\n'),
      userPrompt
    };
  }
}
