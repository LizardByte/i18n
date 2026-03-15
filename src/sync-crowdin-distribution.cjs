#!/usr/bin/env node
/**
 * Syncs Crowdin distribution files from distributions.crowdin.net to a local directory.
 * Designed to be run from GitHub Actions and produce a static-file artifact for GitHub Pages.
 *
 * Usage:
 *   node sync-crowdin-distribution.js
 *
 * Environment variables:
 *   OUTPUT_DIR  - Directory to write files into (default: dist-pages/dist)
 */

'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gunzip = promisify(zlib.gunzip);

const BASE_CDN = 'https://distributions.crowdin.net';
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || 'dist-pages/dist');

/** Number of simultaneous downloads per batch. */
const CONCURRENCY = 8;

/**
 * Distribution hashes to sync.
 * Read from the CROWDIN_DISTRIBUTION_IDS environment variable as a
 * comma-separated list (e.g. "hash1,hash2").  Store the value in GitHub
 * project variables under the name CROWDIN_DISTRIBUTION_IDS.
 */
const DISTRIBUTIONS = (process.env.CROWDIN_DISTRIBUTION_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const _isMain = require.main === module;

/* istanbul ignore next */
if (_isMain && DISTRIBUTIONS.length === 0) {
  console.error('ERROR: CROWDIN_DISTRIBUTION_IDS environment variable is not set or empty.');
  process.exit(1);
}

/**
 * Collects all data chunks from an HTTP response stream into a single Buffer.
 * @param {import('http').IncomingMessage} res
 * @returns {Promise<Buffer>}
 */
function collectBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/**
 * Fetches a URL, following redirects, and returns the body as a Buffer.
 * Transparently decompresses gzip-encoded responses so callers always receive
 * plain bytes (the Crowdin CDN stores content files with Content-Encoding: gzip,
 * but jsDelivr re-serves the raw bytes without that header).
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, async (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      try {
        const buffer = await collectBody(res);
        const isGzip = res.headers['content-encoding'] === 'gzip';
        resolve(isGzip ? await gunzip(buffer) : buffer);
      } catch (err) {
        reject(err);
      }
    }).on('error', reject);
  });
}

/**
 * Writes data to a file, creating parent directories as needed.
 * @param {string} filePath
 * @param {Buffer|string} data
 */
function saveFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

/**
 * Processes an array of items in fixed-size concurrent batches.
 * @template T
 * @param {T[]} items
 * @param {number} batchSize
 * @param {(item: T) => Promise<void>} fn
 */
async function processInBatches(items, batchSize, fn) {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}

/**
 * Downloads all distribution files for a single hash.
 * @param {string} hash  Distribution hash.
 * @param {string} [outputDir]  Override for the output directory (defaults to OUTPUT_DIR).
 * @returns {Promise<boolean>} true if all files were fetched without errors.
 */
async function syncDistribution(hash, outputDir) {
  const resolvedOutputDir = outputDir === undefined ? OUTPUT_DIR : outputDir;
  console.log(`\n=== Syncing distribution: ${hash} ===`);
  const hashDir = path.join(resolvedOutputDir, hash);

  // manifest.json
  console.log('  Fetching manifest.json...');
  const manifestBuf = await fetchUrl(`${BASE_CDN}/${hash}/manifest.json`);
  saveFile(path.join(hashDir, 'manifest.json'), manifestBuf);
  const manifest = JSON.parse(manifestBuf.toString('utf8'));

  console.log(`  Timestamp : ${manifest.timestamp}`);
  console.log(`  Languages : ${(manifest.languages || []).length}`);

  // languages.json
  console.log('  Fetching languages.json...');
  const langsBuf = await fetchUrl(`${BASE_CDN}/${hash}/languages.json`);
  saveFile(path.join(hashDir, 'languages.json'), langsBuf);

  // content files
  const contentPaths = new Set();
  if (manifest.content) {
    for (const paths of Object.values(manifest.content)) {
      for (const p of paths) {
        contentPaths.add(p);
      }
    }
  }

  const pathList = [...contentPaths];
  console.log(`  Content files: ${pathList.length} (concurrency=${CONCURRENCY})`);

  let fetched = 0;
  let failed = 0;

  await processInBatches(pathList, CONCURRENCY, async (contentPath) => {
    const url = `${BASE_CDN}/${hash}${contentPath}`;
    const localPath = path.join(hashDir, contentPath);
    try {
      const data = await fetchUrl(url);
      saveFile(localPath, data);
      fetched++;
      if ((fetched + failed) % 50 === 0) {
        console.log(`    Progress: ${fetched + failed}/${pathList.length}`);
      }
    } catch (err) {
      failed++;
      console.warn(`    WARN: failed to fetch ${contentPath}: ${err.message}`);
    }
  });

  console.log(`  Result: ${fetched} fetched, ${failed} failed`);
  return failed === 0;
}

async function main() {
  console.log('Crowdin Distribution Sync');
  console.log(`Output dir: ${OUTPUT_DIR}`);
  console.log(`Distributions: ${DISTRIBUTIONS.length}`);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let allOk = true;
  for (const hash of DISTRIBUTIONS) {
    try {
      const ok = await syncDistribution(hash);
      if (!ok) allOk = false;
    } catch (err) {
      console.error(`\nFATAL: Failed to sync ${hash}:`, err.message);
      allOk = false;
    }
  }

  if (!allOk) {
    console.error('\nSync completed with errors.');
    process.exit(1);
  }
  console.log('\nSync complete!');
}

/* istanbul ignore next */
if (_isMain) {
  main();
}

// Exports for unit testing
module.exports = {
  collectBody,
  fetchUrl,
  saveFile,
  processInBatches,
  syncDistribution,
  main,
  BASE_CDN,
  CONCURRENCY,
};
