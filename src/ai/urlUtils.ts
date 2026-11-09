import { AIProtocol } from '../types';

/**
 * 清理用户输入的 Base URL，剥离末尾斜杠以及误填的具体端点后缀
 */
export function normalizeBaseUrl(rawUrl: string): string {
  let url = (rawUrl || '').trim().replace(/\/+$/, '');
  // 如果用户直接粘贴了完整端点，先还原到基础前缀以便统一构造
  url = url
    .replace(/\/responses$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/+$/, '');
  return url;
}

/**
 * 判断 URL 末尾是否已经包含版本路径段（例如 /v1, /v2, /v4）
 */
function hasVersionSuffix(url: string): boolean {
  return /\/v\d+[a-z0-9_-]*$/i.test(url);
}

/**
 * 根据协议构造生成接口完整 URL
 * - openai-responses -> .../v1/responses
 * - anthropic-messages -> .../v1/messages
 * - openai-chat -> .../v1/chat/completions
 */
export function buildGenerationEndpoint(rawBaseUrl: string, protocol: AIProtocol): string {
  const trimmed = (rawBaseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    return '';
  }

  // 若用户已显式填入完整端点，则按所选协议做对应适配
  const base = normalizeBaseUrl(trimmed);
  const versionPrefix = hasVersionSuffix(base) ? '' : '/v1';

  switch (protocol) {
    case 'openai-responses':
      return `${base}${versionPrefix}/responses`;
    case 'anthropic-messages':
      return `${base}${versionPrefix}/messages`;
    case 'openai-chat':
      return `${base}${versionPrefix}/chat/completions`;
    default:
      return `${base}${versionPrefix}/responses`;
  }
}

/**
 * 构造获取模型列表接口 URL (.../v1/models)
 */
export function buildModelsEndpoint(rawBaseUrl: string): string {
  const base = normalizeBaseUrl(rawBaseUrl);
  if (!base) {
    return '';
  }
  const versionPrefix = hasVersionSuffix(base) ? '' : '/v1';
  return `${base}${versionPrefix}/models`;
}

