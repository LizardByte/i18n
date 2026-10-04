import { describe, expect, it, jest } from '@jest/globals';
import { processInBatches } from '../src/batches.cjs';

describe('processInBatches', () => {
  it('waits for the whole batch and preserves input order', async () => {
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    const fn = jest.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce('third');

    const pending = processInBatches([1, 2, 3], 2, fn);
    expect(fn).toHaveBeenCalledTimes(2);

    second.resolve('second');
    await Promise.resolve();
    expect(fn).toHaveBeenCalledTimes(2);

    first.resolve('first');
    await expect(pending).resolves.toEqual(['first', 'second', 'third']);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('serializes operations when the batch size is one', async () => {
    const first = Promise.withResolvers();
    const fn = jest.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce('second');

    const pending = processInBatches([1, 2], 1, fn);
    expect(fn).toHaveBeenCalledTimes(1);
    first.resolve('first');

    await expect(pending).resolves.toEqual(['first', 'second']);
  });

  it('observes batch rejections and does not start a later batch', async () => {
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    const fn = jest.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const pending = processInBatches([1, 2, 3], 2, fn);
    const rejection = expect(pending).rejects.toThrow('first failure');
    first.reject(new Error('first failure'));
    second.reject(new Error('second failure'));

    await rejection;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates a synchronous callback error', async () => {
    const fn = jest.fn(() => { throw new Error('callback failure'); });
    await expect(processInBatches([1, 2], 1, fn)).rejects.toThrow('callback failure');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns no results and starts no work for empty input', async () => {
    const fn = jest.fn();
    await expect(processInBatches([], 2, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid batch size %s', async (batchSize) => {
    const fn = jest.fn();
    await expect(processInBatches([1], batchSize, fn)).rejects.toThrow(RangeError);
    expect(fn).not.toHaveBeenCalled();
  });
});
