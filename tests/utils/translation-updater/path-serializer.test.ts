import { describe, it, expect, beforeEach } from '@jest/globals';
import { runSerializedByPath, resetPathSerializer } from '../../../src/utils/translation-updater/path-serializer.js';

describe('runSerializedByPath', () => {
  beforeEach(() => resetPathSerializer());

  it('runs sequential calls for the same path in order', async () => {
    const order: number[] = [];
    await Promise.all([
      runSerializedByPath('same.yml', async () => { await sleep(20); order.push(1); }),
      runSerializedByPath('same.yml', async () => { await sleep(10); order.push(2); }),
      runSerializedByPath('same.yml', async () => { await sleep(1); order.push(3); }),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('runs calls for different paths in parallel', async () => {
    const order: string[] = [];
    await Promise.all([
      runSerializedByPath('a.yml', async () => { await sleep(30); order.push('a'); }),
      runSerializedByPath('b.yml', async () => { await sleep(10); order.push('b'); }),
    ]);
    expect(order).toEqual(['b', 'a']);
  });

  it('continues processing the queue after an error in a previous call', async () => {
    const order: string[] = [];
    const p1 = runSerializedByPath('same.yml', async () => {
      await sleep(5);
      throw new Error('boom');
    });
    const p2 = runSerializedByPath('same.yml', async () => {
      order.push('ran');
      return 'ok';
    });

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
    expect(order).toEqual(['ran']);
  });

  it('propagates the return value of the inner function', async () => {
    const result = await runSerializedByPath('x.yml', async () => 42);
    expect(result).toBe(42);
  });
});

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
