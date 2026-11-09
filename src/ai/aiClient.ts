import { AIProtocol, FetchedModelInfo } from '../types';
import { buildGenerationEndpoint, buildModelsEndpoint } from './urlUtils';

export interface GenerateRequestOptions {
  protocol: AIProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  stream: boolean;
  customHeaders?: Record<string, string>;
  signal?: AbortSignal;
  onUpdate?: (fullText: string, delta: string) => void;
}

/**
 * 构造不同协议所需的请求头
 */
function buildHeaders(
  protocol: AIProtocol,
  apiKey: string,
  customHeaders?: Record<string, string>,
  includeBearerForAnthropic = true
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(customHeaders || {})
  };

  const trimmedKey = (apiKey || '').trim();
  if (!trimmedKey) {
    return headers;
  }

  if (protocol === 'anthropic-messages') {
    headers['x-api-key'] = trimmedKey;
    headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
    // 兼容部分使用 Bearer 鉴权的 Anthropic 协议网关（非官方域名时同时携带或按需回退）
    if (includeBearerForAnthropic) {
      headers['Authorization'] = `Bearer ${trimmedKey}`;
    }
  } else {
    headers['Authorization'] = `Bearer ${trimmedKey}`;
  }

  return headers;
}

/**
 * 清理模型输出的外层包裹代码块，保留纯粹的 Git Commit Message
 */
export function sanitizeCommitMessage(raw: string): string {
  let text = (raw || '').trim();
  // 移除可能包裹在最外层的 ```commit / ```git / ```text / ``` 代码块
  const codeBlockMatch = text.match(/^```(?:git|commit|text|markdown|plaintext)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim();
  }
  // 如果流式输出开头带有 ```xxx\n，剥离首尾围栏
  text = text.replace(/^```(?:git|commit|text|markdown|plaintext)?\s*\r?\n/i, '');
  text = text.replace(/\r?\n```\s*$/i, '');
  return text.trim();
}

/**
 * 自动从供应商获取可用模型列表 (GET /v1/models)
 */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  protocol: AIProtocol,
  customHeaders?: Record<string, string>,
  signal?: AbortSignal
): Promise<{ models: FetchedModelInfo[]; endpoint: string }> {
  const endpoint = buildModelsEndpoint(baseUrl);
  if (!endpoint) {
    throw new Error('请先填写有效的供应商 Base URL');
  }

  const isOfficialAnthropic = /api\.anthropic\.com/i.test(endpoint);
  let response = await fetch(endpoint, {
    method: 'GET',
    headers: buildHeaders(protocol, apiKey, customHeaders, !isOfficialAnthropic),
    signal
  });

  // 如果因为同时携带了 Authorization 与 x-api-key 被部分严格网关拒绝，回退重试
  if ((response.status === 401 || response.status === 400) && protocol === 'anthropic-messages') {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: buildHeaders(protocol, apiKey, customHeaders, isOfficialAnthropic),
      signal
    });
  }

  if (!response.ok) {
    const errBody = await safeReadErrorText(response);
    throw new Error(`获取模型列表失败 (HTTP ${response.status}): ${errBody || response.statusText}`);
  }

  const json: any = await response.json();
  const rawList: any[] = Array.isArray(json)
    ? json
    : Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json?.models)
        ? json.models
        : [];

  const seen = new Set<string>();
  const models: FetchedModelInfo[] = [];

  for (const item of rawList) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        models.push({ id });
      }
    } else if (item && typeof item === 'object') {
      const rawId = item.id || item.name || item.model;
      if (typeof rawId === 'string' && rawId.trim()) {
        // 处理部分网关返回 models/xxx 格式
        const id = rawId.trim();
        if (!seen.has(id)) {
          seen.add(id);
          models.push({
            id,
            displayName: item.display_name || item.displayName || id,
            ownedBy: item.owned_by || item.type || undefined
          });
        }
      }
    }
  }

  return { models, endpoint };
}

/**
 * 调用供应商生成 Git Commit Message（支持 OpenAI Response 与 Anthropic Message 协议，支持流式与非流式）
 */
export async function generateCommitMessage(options: GenerateRequestOptions): Promise<string> {
  const { protocol, baseUrl, apiKey, model, systemPrompt, userPrompt, stream, customHeaders, signal, onUpdate } =
    options;

  const endpoint = buildGenerationEndpoint(baseUrl, protocol);
  if (!endpoint) {
    throw new Error('供应商 Base URL 未配置或格式无效');
  }
  if (!model) {
    throw new Error('未选择 AI 模型，请先在配置中心或状态栏选择模型');
  }

  const body = buildRequestBody(protocol, model, systemPrompt, userPrompt, stream);
  const isOfficialAnthropic = /api\.anthropic\.com/i.test(endpoint);

  let response = await fetch(endpoint, {
    method: 'POST',
    headers: buildHeaders(protocol, apiKey, customHeaders, !isOfficialAnthropic),
    body: JSON.stringify(body),
    signal
  });

  // 针对 Anthropic 协议鉴权头兼容回退
  if ((response.status === 401 || response.status === 400) && protocol === 'anthropic-messages') {
    const retryResponse = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(protocol, apiKey, customHeaders, isOfficialAnthropic),
      body: JSON.stringify(body),
      signal
    });
    if (retryResponse.ok) {
      response = retryResponse;
    }
  }

  if (!response.ok) {
    const errText = await safeReadErrorText(response);
    throw new Error(`AI 请求失败 (${response.status} @ ${endpoint}): ${errText || response.statusText}`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const isEventStream = stream && (contentType.includes('text/event-stream') || !contentType.includes('application/json'));

  if (isEventStream && response.body) {
    const streamedResult = await consumeSseStream(response.body, protocol, onUpdate, signal);
    return sanitizeCommitMessage(streamedResult);
  }

  // 非流式或服务端直接返回 JSON
  const json: any = await response.json();
  const fullText = extractNonStreamText(json, protocol);
  const cleaned = sanitizeCommitMessage(fullText);
  if (onUpdate && cleaned) {
    onUpdate(cleaned, cleaned);
  }
  return cleaned;
}

/**
 * 测试供应商与模型连通性
 */
export async function testProviderConnection(options: {
  protocol: AIProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  customHeaders?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; latencyMs: number; reply?: string; endpoint: string; error?: string }> {
  const endpoint = buildGenerationEndpoint(options.baseUrl, options.protocol);
  const start = Date.now();
  try {
    const reply = await generateCommitMessage({
      ...options,
      systemPrompt: 'You are a connectivity check assistant. Reply strictly with the single word: OK',
      userPrompt: 'Ping',
      stream: false
    });
    return {
      ok: true,
      latencyMs: Date.now() - start,
      reply: reply || 'OK',
      endpoint
    };
  } catch (err: any) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      endpoint,
      error: err?.message || String(err)
    };
  }
}

/**
 * 根据协议组装请求体
 */
function buildRequestBody(
  protocol: AIProtocol,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  stream: boolean
): Record<string, any> {
  if (protocol === 'openai-responses') {
    // OpenAI Responses API (/v1/responses) 标准请求结构
    return {
      model,
      instructions: systemPrompt,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: userPrompt
            }
          ]
        }
      ],
      stream
    };
  }

  if (protocol === 'anthropic-messages') {
    // Anthropic Messages API (/v1/messages) 标准请求结构
    return {
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ],
      stream
    };
  }

  // OpenAI Chat Completions (/v1/chat/completions)
  return {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream
  };
}

/**
 * 解析非流式 JSON 响应内容
 */
function extractNonStreamText(json: any, protocol: AIProtocol): string {
  if (!json) {
    return '';
  }

  if (json.error) {
    const msg = typeof json.error === 'string' ? json.error : json.error.message || JSON.stringify(json.error);
    throw new Error(msg);
  }

  // 1. OpenAI Responses API 格式: output_text 或 output 数组
  if (typeof json.output_text === 'string' && json.output_text) {
    return json.output_text;
  }

  const outputArray = Array.isArray(json.output)
    ? json.output
    : Array.isArray(json.response?.output)
      ? json.response.output
      : null;

  if (outputArray) {
    const parts: string[] = [];
    for (const item of outputArray) {
      if (typeof item?.text === 'string') {
        parts.push(item.text);
      }
      if (Array.isArray(item?.content)) {
        for (const block of item.content) {
          if (
            (block?.type === 'output_text' || block?.type === 'text' || !block?.type) &&
            typeof block?.text === 'string'
          ) {
            parts.push(block.text);
          }
        }
      }
    }
    if (parts.length > 0) {
      return parts.join('');
    }
  }

  // 2. Anthropic Messages API 格式: content: [{ type: 'text', text: '...' }]
  if (Array.isArray(json.content)) {
    const parts: string[] = [];
    for (const block of json.content) {
      if ((block?.type === 'text' || block?.type === 'output_text') && typeof block?.text === 'string') {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) {
      return parts.join('');
    }
  }

  // 3. OpenAI Chat Completions 兼容格式: choices[0].message.content
  if (Array.isArray(json.choices) && json.choices.length > 0) {
    const content = json.choices[0]?.message?.content ?? json.choices[0]?.text;
    if (typeof content === 'string') {
      return content;
    }
  }

  return '';
}

/**
 * 解析 SSE 流式响应（同时支持 OpenAI Responses、Anthropic Messages 与 OpenAI Chat Completions 事件流）
 */
async function consumeSseStream(
  bodyStream: ReadableStream<Uint8Array>,
  protocol: AIProtocol,
  onUpdate?: (fullText: string, delta: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let accumulated = '';
  let currentEvent = '';

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('生成已取消');
      }
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          currentEvent = '';
          continue;
        }

        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
          continue;
        }

        if (!line.startsWith('data:')) {
          // 兼容某些网关虽开启了 stream 但直接返回一整段 JSON 的情况
          if (line.startsWith('{') && line.endsWith('}')) {
            try {
              const directObj = JSON.parse(line);
              const extracted = extractNonStreamText(directObj, protocol);
              if (extracted) {
                accumulated += extracted;
                onUpdate?.(sanitizeCommitMessage(accumulated), extracted);
              }
            } catch {
              // ignore partial line
            }
          }
          continue;
        }

        const dataPayload = line.slice(5).trim();
        if (!dataPayload || dataPayload === '[DONE]') {
          continue;
        }

        let parsed: any;
        try {
          parsed = JSON.parse(dataPayload);
        } catch {
          continue;
        }

        // 检查流内错误事件
        if (parsed?.type === 'error' || parsed?.error) {
          const errMsg =
            parsed?.error?.message ||
            (typeof parsed?.error === 'string' ? parsed.error : '') ||
            parsed?.message ||
            '流式响应返回错误';
          throw new Error(errMsg);
        }

        let deltaText = '';

        // A. OpenAI Responses API 流式事件:
        //    type === 'response.output_text.delta' -> parsed.delta (string)
        if (
          parsed?.type === 'response.output_text.delta' ||
          currentEvent === 'response.output_text.delta'
        ) {
          if (typeof parsed?.delta === 'string') {
            deltaText = parsed.delta;
          }
        }
        // 如果网关仅在 response.completed / response.done 中返回完整文本且之前未收到 delta
        else if (
          (parsed?.type === 'response.completed' ||
            parsed?.type === 'response.done' ||
            currentEvent === 'response.completed') &&
          !accumulated
        ) {
          const completedText = extractNonStreamText(parsed.response || parsed, protocol);
          if (completedText) {
            deltaText = completedText;
          }
        }
        // B. Anthropic Messages API 流式事件:
        //    type === 'content_block_delta' && delta.type === 'text_delta' -> parsed.delta.text
        else if (
          parsed?.type === 'content_block_delta' ||
          currentEvent === 'content_block_delta'
        ) {
          if (typeof parsed?.delta?.text === 'string') {
            deltaText = parsed.delta.text;
          }
        }
        // C. OpenAI Chat Completions 兼容流式事件:
        //    choices[0].delta.content
        else if (Array.isArray(parsed?.choices) && parsed.choices.length > 0) {
          const choiceDelta = parsed.choices[0]?.delta?.content;
          if (typeof choiceDelta === 'string') {
            deltaText = choiceDelta;
          }
        }
        // D. 通用兜底: 如果 parsed.delta 是直接字符串
        else if (typeof parsed?.delta === 'string') {
          deltaText = parsed.delta;
        }

        if (deltaText) {
          accumulated += deltaText;
          onUpdate?.(sanitizeCommitMessage(accumulated), deltaText);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return accumulated;
}

/**
 * 安全读取错误响应文本并提取可读错误信息
 */
async function safeReadErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text) {
      return '';
    }
    try {
      const json = JSON.parse(text);
      if (json?.error?.message) {
        return json.error.message;
      }
      if (typeof json?.error === 'string') {
        return json.error;
      }
      if (json?.message) {
        return json.message;
      }
    } catch {
      // plain text error
    }
    return text.slice(0, 400);
  } catch {
    return '';
  }
}

