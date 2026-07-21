import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { config } from '../config';
import { logger } from '../utils/logger';
import { withRetry } from '../utils/retry';

export interface LLMConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

// Re-export SDK type so callers don't need to import openai directly
export type LLMMessage = ChatCompletionMessageParam;

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** Use json_object response format for reliable JSON output */
  jsonMode?: boolean;
  /** Stream the response and collect the full text (good for large outputs) */
  stream?: boolean;
}

export class LLMClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly baseUrlLabel: string;

  constructor(cfg?: LLMConfig) {
    const baseURL = cfg?.baseUrl || config.llm.baseUrl;
    const apiKey = cfg?.apiKey || config.llm.apiKey;
    this.model = cfg?.model || config.llm.model;
    this.baseUrlLabel = baseURL || 'default';

    this.client = new OpenAI({
      baseURL: baseURL || undefined,
      apiKey: apiKey || 'placeholder', // some local providers (Ollama) don't need a key
      maxRetries: 0, // we handle retries ourselves
      timeout: 300_000,
    });
  }

  /** Single-shot chat completion */
  async chat(messages: LLMMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    const { maxTokens = 4096, temperature = 0.2, jsonMode = false, stream = false } = options;

    if (stream) {
      return this.chatStream(messages, { maxTokens, temperature });
    }

    return withRetry(
      async () => {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages,
          max_completion_tokens: maxTokens,
          temperature,
          response_format: jsonMode ? { type: 'json_object' } : undefined,
        });

        const content = completion.choices[0]?.message?.content ?? '';
        logger.debug('LLM response', {
          model: completion.model,
          baseUrl: this.baseUrlLabel,
          promptTokens: completion.usage?.prompt_tokens,
          completionTokens: completion.usage?.completion_tokens,
          contentChars: content.length,
        });

        return {
          content,
          model: completion.model,
          usage: completion.usage
            ? {
                promptTokens: completion.usage.prompt_tokens,
                completionTokens: completion.usage.completion_tokens,
                totalTokens: completion.usage.total_tokens,
              }
            : undefined,
        };
      },
      {
        maxAttempts: 3,
        delayMs: 2000,
        shouldRetry: (err) => {
          if (err instanceof OpenAI.APIError) {
            // Retry on rate-limit (429) and transient server errors (500/502/503)
            return err.status === 429 || (err.status >= 500 && err.status < 600);
          }
          return true;
        },
      },
      'OpenAI chat',
    );
  }

  /** Streaming chat — collects the full streamed text and returns it as one response */
  async chatStream(
    messages: LLMMessage[],
    options: Pick<ChatOptions, 'maxTokens' | 'temperature'> = {},
  ): Promise<LLMResponse> {
    const { maxTokens = 4096, temperature = 0.2 } = options;

    return withRetry(
      async () => {
        const stream = this.client.chat.completions.stream({
          model: this.model,
          messages,
          max_completion_tokens: maxTokens,
          temperature,
        });

        const completion = await stream.finalChatCompletion();
        const content = completion.choices[0]?.message?.content ?? '';

        return {
          content,
          model: completion.model,
          usage: completion.usage
            ? {
                promptTokens: completion.usage.prompt_tokens,
                completionTokens: completion.usage.completion_tokens,
                totalTokens: completion.usage.total_tokens,
              }
            : undefined,
        };
      },
      { maxAttempts: 2, delayMs: 3000 },
      'OpenAI stream',
    );
  }

  /** Chat and parse the response as JSON, with fallback code-block extraction */
  async chatJson<T>(
    messages: LLMMessage[],
    options: Pick<ChatOptions, 'maxTokens' | 'stream'> = {},
  ): Promise<T> {
    const response = await this.chat(messages, {
      jsonMode: !options.stream, // json_object mode doesn't work with streaming
      maxTokens: options.maxTokens ?? 4096,
      temperature: 1,
      stream: options.stream,
    });

    return parseJsonFromLLM<T>(response.content);
  }
}

/** Extract and parse JSON from an LLM response, handling markdown code blocks */
function parseJsonFromLLM<T>(raw: string): T {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new Error('Failed to parse JSON from LLM response: empty content (model may have exhausted max tokens on reasoning)');
  }

  // Direct JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // fall through
    }
  }

  // Wrapped in ```json ... ``` or ``` ... ```
  const codeBlock = trimmed.match(/```(?:json)?\s*\n?([\s\S]+?)\n?```/);
  if (codeBlock?.[1]) {
    return JSON.parse(codeBlock[1].trim()) as T;
  }

  // Last resort: try parsing anyway
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(
      `Failed to parse JSON from LLM response. First 300 chars: ${trimmed.slice(0, 300)}`,
    );
  }
}

export function createLLMClient(cfg?: LLMConfig): LLMClient {
  if (!cfg?.apiKey && !config.llm.apiKey) {
    logger.warn('No LLM API key configured — AI analysis will be skipped.');
  }
  return new LLMClient(cfg);
}

export function isLLMConfigured(cfg?: LLMConfig): boolean {
  return !!(cfg?.apiKey || config.llm.apiKey);
}

/**
 * LLM settings for Cursor-style synthesis agents.
 * Prefer SYNTHESIS_LLM_* (e.g. NVIDIA) so page-analysis can stay on OpenAI.
 * If SYNTHESIS_LLM_BASE_URL is set without SYNTHESIS_LLM_API_KEY, fall back to LLM_*
 * (avoids sending an OpenAI sk- key to NVIDIA).
 */
export function resolveSynthesisLlmConfig(override?: LLMConfig): LLMConfig {
  const synthesisBase = config.llm.synthesisBaseUrl;
  const synthesisKey = config.llm.synthesisApiKey;
  const synthesisModel = config.llm.synthesisModel;
  const wantsSeparate = !!(synthesisBase || synthesisKey || synthesisModel);

  if (wantsSeparate) {
    if (synthesisBase && !synthesisKey) {
      logger.warn(
        '[Synthesis] SYNTHESIS_LLM_BASE_URL is set but SYNTHESIS_LLM_API_KEY is empty — falling back to LLM_* for synthesis',
      );
    } else {
      return {
        baseUrl: synthesisBase || config.llm.baseUrl || override?.baseUrl,
        apiKey: synthesisKey || config.llm.apiKey || override?.apiKey,
        model: synthesisModel || config.llm.model || override?.model,
      };
    }
  }

  return {
    baseUrl: override?.baseUrl || config.llm.baseUrl,
    apiKey: override?.apiKey || config.llm.apiKey,
    model: override?.model || config.llm.model,
  };
}

