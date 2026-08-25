import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  stream: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('openai', () => {
  class APIError extends Error {
    status: number;

    constructor(status: number) {
      super(`API error ${status}`);
      this.status = status;
    }
  }

  class OpenAI {
    static APIError = APIError;

    chat = {
      completions: {
        create: mocks.create,
        stream: mocks.stream,
      },
    };

    constructor(public options: unknown) {}
  }

  return { default: OpenAI };
});

vi.mock('../config', () => ({
  config: {
    llm: {
      baseUrl: undefined as string | undefined,
      apiKey: '',
      model: 'gpt-test-default',
      analysisBaseUrl: undefined as string | undefined,
      analysisApiKey: undefined as string | undefined,
      analysisModel: undefined as string | undefined,
      synthesisBaseUrl: undefined as string | undefined,
      synthesisApiKey: undefined as string | undefined,
      synthesisModel: undefined as string | undefined,
    },
  },
}));

vi.mock('../utils/logger', () => ({
  logger: {
    warn: mocks.warn,
    debug: mocks.debug,
  },
}));

import { config } from '../config';
import { createLLMClient, isLLMConfigured, LLMClient, resolveAnalysisLlmConfig } from './llm';

describe('LLM service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects whether an LLM API key is configured', () => {
    expect(isLLMConfigured()).toBe(false);
    expect(isLLMConfigured({ apiKey: 'test-key' })).toBe(true);
    expect(isLLMConfigured({ apiKey: '' })).toBe(false);
  });

  it('warns when creating a client without any API key', () => {
    const client = createLLMClient();

    expect(client).toBeInstanceOf(LLMClient);
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('No LLM API key configured'));
  });

  it('sends chat completions with the selected model and json mode options', async () => {
    mocks.create.mockResolvedValueOnce({
      model: 'gpt-test-model',
      choices: [{ message: { content: '{"ok":true}' } }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      },
    });

    const client = new LLMClient({ apiKey: 'key', model: 'gpt-test-model' });
    const response = await client.chat(
      [{ role: 'user', content: 'Return JSON' }],
      { maxTokens: 77, temperature: 0.4, jsonMode: true },
    );

    expect(mocks.create).toHaveBeenCalledWith({
      model: 'gpt-test-model',
      messages: [{ role: 'user', content: 'Return JSON' }],
      max_completion_tokens: 77,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    });
    expect(response).toEqual({
      content: '{"ok":true}',
      model: 'gpt-test-model',
      usage: {
        promptTokens: 12,
        completionTokens: 3,
        totalTokens: 15,
      },
    });
    expect(mocks.debug).toHaveBeenCalledWith('LLM response', {
      model: 'gpt-test-model',
      baseUrl: 'default',
      promptTokens: 12,
      completionTokens: 3,
      contentChars: 11,
    });
  });

  it('parses direct JSON responses from chatJson', async () => {
    mocks.create.mockResolvedValueOnce({
      model: 'gpt-test-model',
      choices: [{ message: { content: '{"action":"click","confidence":0.9}' } }],
    });

    const client = new LLMClient({ apiKey: 'key', model: 'gpt-test-model' });
    const parsed = await client.chatJson<{ action: string; confidence: number }>(
      [{ role: 'user', content: 'Pick action' }],
      { maxTokens: 25 },
    );

    expect(parsed).toEqual({ action: 'click', confidence: 0.9 });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      response_format: { type: 'json_object' },
      max_completion_tokens: 25,
    }));
  });

  it('uses a model-compatible default temperature for chatJson', async () => {
    mocks.create.mockResolvedValueOnce({
      model: 'gpt-5.5-2026-04-23',
      choices: [{ message: { content: '{"ok":true}' } }],
    });

    const client = new LLMClient({ apiKey: 'key', model: 'gpt-5.5' });

    await client.chatJson<{ ok: boolean }>(
      [{ role: 'user', content: 'Return ok JSON' }],
      { maxTokens: 25 },
    );

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.5',
      temperature: 1,
    }));
  });

  it('parses fenced JSON responses from streamed chatJson', async () => {
    mocks.stream.mockReturnValueOnce({
      finalChatCompletion: vi.fn().mockResolvedValue({
        model: 'gpt-test-model',
        choices: [{ message: { content: '```json\n{"type":"done"}\n```' } }],
      }),
    });

    const client = new LLMClient({ apiKey: 'key', model: 'gpt-test-model' });
    const parsed = await client.chatJson<{ type: string }>(
      [{ role: 'user', content: 'Pick action' }],
      { stream: true },
    );

    expect(parsed).toEqual({ type: 'done' });
    expect(mocks.stream).toHaveBeenCalledWith({
      model: 'gpt-test-model',
      messages: [{ role: 'user', content: 'Pick action' }],
      max_completion_tokens: 4096,
      temperature: 1,
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('prefers ANALYSIS_LLM_MODEL for page analysis / OCR', () => {
    config.llm.analysisModel = 'gpt-4o-mini';
    try {
      const resolved = resolveAnalysisLlmConfig({ apiKey: 'key', model: 'gpt-5.5' });
      expect(resolved.model).toBe('gpt-4o-mini');
      expect(resolved.apiKey).toBe('key');
    } finally {
      config.llm.analysisModel = undefined;
    }
  });

  it('falls back to LLM_MODEL when ANALYSIS_LLM_MODEL is unset', () => {
    const resolved = resolveAnalysisLlmConfig({ apiKey: 'key', model: 'gpt-5.5' });
    expect(resolved.model).toBe('gpt-5.5');
  });

  it('throws a useful error when JSON parsing fails', async () => {
    mocks.create.mockResolvedValueOnce({
      model: 'gpt-test-model',
      choices: [{ message: { content: 'not json at all' } }],
    });

    const client = new LLMClient({ apiKey: 'key', model: 'gpt-test-model' });

    await expect(
      client.chatJson([{ role: 'user', content: 'Pick action' }]),
    ).rejects.toThrow('Failed to parse JSON from LLM response');
  });

  it('repairs Nemotron-style duplicate brace prefixes in chatJson', async () => {
    mocks.create.mockResolvedValueOnce({
      model: 'nvidia/nemotron',
      choices: [{ message: { content: '{\n{"chunk": 831, "observations": []}' } }],
    });

    const client = new LLMClient({ apiKey: 'key', model: 'nvidia/nemotron' });
    const parsed = await client.chatJson<{ chunk: number; observations: unknown[] }>(
      [{ role: 'user', content: 'Analyze chunk' }],
    );

    expect(parsed).toEqual({ chunk: 831, observations: [] });
  });

  it('repairs Nemotron spurious "{\\" line prefixes in chatJson', async () => {
    mocks.create.mockResolvedValueOnce({
      model: 'nvidia/nemotron',
      choices: [{ message: { content: '{\n  "{\n  "chunk": 831, "observations": []}' } }],
    });

    const client = new LLMClient({ apiKey: 'key', model: 'nvidia/nemotron' });
    const parsed = await client.chatJson<{ chunk: number; observations: unknown[] }>(
      [{ role: 'user', content: 'Analyze chunk' }],
    );

    expect(parsed).toEqual({ chunk: 831, observations: [] });
  });

  it('salvages truncated JSON objects from chatJson', async () => {
    mocks.create.mockResolvedValueOnce({
      model: 'nvidia/nemotron',
      choices: [{
        message: {
          content: '{"chunk": 831, "observations": [{"area": "security", "finding": "RBAC matrix"',
        },
      }],
    });

    const client = new LLMClient({ apiKey: 'key', model: 'nvidia/nemotron' });
    const parsed = await client.chatJson<{ chunk: number; observations: Array<{ area: string }> }>(
      [{ role: 'user', content: 'Analyze chunk' }],
    );

    expect(parsed.chunk).toBe(831);
    expect(parsed.observations[0]?.area).toBe('security');
  });
});
