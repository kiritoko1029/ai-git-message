import * as vscode from 'vscode';
import { CommitLanguage, ResolvedLanguage } from './types';

/**
 * 获取当前 VS Code 界面语言 ('zh' | 'en')
 */
export function getUiLanguage(): ResolvedLanguage {
  const lang = (vscode.env.language || 'en').toLowerCase();
  return lang.startsWith('zh') ? 'zh' : 'en';
}

/**
 * 解析最终用于生成 Git Message 与模板展示的语言
 * 当设置为 'auto' 时自动跟随用户 VS Code 语言环境
 */
export function resolveCommitLanguage(pref?: CommitLanguage): ResolvedLanguage {
  if (pref === 'zh' || pref === 'en') {
    return pref;
  }
  return getUiLanguage();
}

/**
 * 根据当前 VS Code 界面语言返回对应中英文文案
 */
export function t(zh: string, en: string): string {
  return getUiLanguage() === 'zh' ? zh : en;
}

/**
 * 兼容旧版带语言后缀的模板 ID，统一映射到合并后的模板 ID
 */
export function normalizeTemplateId(rawId?: string): string {
  if (!rawId) {
    return 'conventional';
  }
  const map: Record<string, string> = {
    'conventional-zh': 'conventional',
    'conventional-en': 'conventional',
    'gitmoji-zh': 'gitmoji',
    'gitmoji-en': 'gitmoji',
    'concise-zh': 'concise',
    'changelog-zh': 'changelog',
    'business-module-zh': 'module'
  };
  return map[rawId] || rawId;
}

