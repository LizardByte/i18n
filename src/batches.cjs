'use strict';

/**
 * Lazily starts one batch at a time, limiting the number of pending operations.
 * Each batch settles before its results are yielded to the consumer.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} batchSize
 * @param {(item: T) => Promise<R>} fn
 * @returns {AsyncGenerator<R[]>}
 */
async function* pendingBatches(items, batchSize, fn) {
  for (let i = 0; i < items.length; i += batchSize) {
    yield Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}

/**
 * Maps items in fixed-size concurrent batches and returns results in input order.
 * Use a batch size of one for ordered writes or rate-limited operations.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} batchSize  Positive integer concurrency limit.
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function processInBatches(items, batchSize, fn) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }

  const results = [];
  for await (const batch of pendingBatches(items, batchSize, fn)) {
    results.push(...batch);
  }
  return results;
}

module.exports = { processInBatches };
