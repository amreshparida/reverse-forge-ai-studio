import { describe, expect, it } from 'vitest';
import type { Page, Request, Response } from 'playwright';
import { createNetworkRecorder } from './index';

class FakePage {
  private handlers = new Map<string, Set<(value: unknown) => void>>();
  on(event: string, handler: (value: unknown) => void) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }
  off(event: string, handler: (value: unknown) => void) {
    this.handlers.get(event)?.delete(handler);
  }
  emit(event: string, value: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
  url() { return 'https://app.example.test'; }
}

function fakeRequest(): Request {
  return {
    url: () => 'https://api.example.test/items',
    resourceType: () => 'fetch',
    method: () => 'GET',
    allHeaders: async () => ({}),
    postData: () => null,
  } as unknown as Request;
}

function fakeResponse(request: Request, delayMs: number): Response {
  return {
    request: () => request,
    status: () => 200,
    statusText: () => 'OK',
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { id: 1 };
    },
  } as unknown as Response;
}

describe('createNetworkRecorder', () => {
  it('flushes concurrent same-URL responses without identity collisions', async () => {
    const page = new FakePage();
    const recorder = createNetworkRecorder(page as unknown as Page);
    const first = fakeRequest();
    const second = fakeRequest();
    page.emit('request', first);
    page.emit('request', second);
    page.emit('response', fakeResponse(first, 10));
    page.emit('response', fakeResponse(second, 1));

    await recorder.flush();
    const calls = recorder.getCalls();
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((entry) => entry.requestId)).size).toBe(2);
    expect(recorder.getHar().log.entries.map((entry) => entry._requestId).sort()).toEqual(
      calls.map((entry) => entry.requestId).sort(),
    );
    await recorder.stop();
  });

  it('waits for responses before reset clears the window', async () => {
    const page = new FakePage();
    const recorder = createNetworkRecorder(page as unknown as Page);
    const request = fakeRequest();
    page.emit('request', request);
    page.emit('response', fakeResponse(request, 5));
    await recorder.reset();
    expect(recorder.getCalls()).toEqual([]);
    expect(recorder.getHar().log.entries).toEqual([]);
    await recorder.stop();
  });
});
