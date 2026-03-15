import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';

// collectBody, processInBatches, saveFile, BASE_CDN, CONCURRENCY are pure / fs-level helpers;
// fetchUrl and syncDistribution interact with the network and filesystem.
const {
  collectBody,
  processInBatches,
  saveFile,
  fetchUrl,
  syncDistribution,
  BASE_CDN,
  CONCURRENCY,
} = require('../src/sync-crowdin-distribution.cjs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('BASE_CDN points at the Crowdin distributions endpoint', () => {
    expect(BASE_CDN).toBe('https://distributions.crowdin.net');
  });

  it('CONCURRENCY is a positive integer', () => {
    expect(typeof CONCURRENCY).toBe('number');
    expect(CONCURRENCY).toBeGreaterThan(0);
    expect(Number.isInteger(CONCURRENCY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// collectBody
// ---------------------------------------------------------------------------

describe('collectBody', () => {
  it('resolves with the concatenated buffer from all data events', async () => {
    const { EventEmitter } = require('node:events');
    const mockRes = new EventEmitter();

    const promise = collectBody(mockRes);

    mockRes.emit('data', Buffer.from('hello '));
    mockRes.emit('data', Buffer.from('world'));
    mockRes.emit('end');

    const result = await promise;
    expect(result.toString('utf8')).toBe('hello world');
  });

  it('rejects when the stream emits an error', async () => {
    const { EventEmitter } = require('node:events');
    const mockRes = new EventEmitter();

    const promise = collectBody(mockRes);
    mockRes.emit('error', new Error('stream failure'));

    await expect(promise).rejects.toThrow('stream failure');
  });
});

// ---------------------------------------------------------------------------
// processInBatches
// ---------------------------------------------------------------------------

describe('processInBatches', () => {
  it('calls fn for every item', async () => {
    const results = [];
    const items = [1, 2, 3, 4, 5];
    await processInBatches(items, 2, async (item) => {
      results.push(item);
    });
    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('processes in batches no larger than batchSize', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    const items = Array.from({ length: 10 }, (_, i) => i);
    await processInBatches(items, 3, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent--;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('handles an empty array without calling fn', async () => {
    const fn = jest.fn();
    await processInBatches([], 5, fn);
    expect(fn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// saveFile
// ---------------------------------------------------------------------------

describe('saveFile', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdin-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes data to the specified path', () => {
    const filePath = path.join(tmpDir, 'output.txt');
    saveFile(filePath, 'hello');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('hello');
  });

  it('creates intermediate directories automatically', () => {
    const filePath = path.join(tmpDir, 'a', 'b', 'c', 'file.txt');
    saveFile(filePath, Buffer.from('data'));
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('overwrites existing files', () => {
    const filePath = path.join(tmpDir, 'file.txt');
    saveFile(filePath, 'first');
    saveFile(filePath, 'second');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// fetchUrl
// ---------------------------------------------------------------------------

describe('fetchUrl', () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');

  let httpsGetSpy;

  beforeEach(() => {
    httpsGetSpy = jest.spyOn(https, 'get');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Helper: creates a minimal IncomingMessage-like EventEmitter.
   */
  function makeResponse({ statusCode = 200, headers = {}, body = 'ok' }) {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = headers;
    // Schedule body/end asynchronously so the promise chain runs first
    setImmediate(() => {
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    return res;
  }

  /**
   * Helper: creates a minimal https.get return stub with an .on() method.
   */
  function makeReq() {
    return { on: jest.fn().mockReturnThis() };
  }

  it('resolves with the body buffer for a 200 response', async () => {
    const res = makeResponse({ body: 'hello world' });
    httpsGetSpy.mockImplementation((_url, cb) => {
      cb(res);
      return makeReq();
    });

    const buf = await fetchUrl('https://example.com/file');
    expect(buf.toString('utf8')).toBe('hello world');
  });

  it('follows a single redirect', async () => {
    const redirectRes = new EventEmitter();
    redirectRes.statusCode = 301;
    redirectRes.headers = { location: 'https://example.com/final' };

    const finalRes = makeResponse({ body: 'final body' });

    let callCount = 0;
    httpsGetSpy.mockImplementation((_url, cb) => {
      callCount++;
      if (callCount === 1) {
        cb(redirectRes);
      } else {
        cb(finalRes);
      }
      return makeReq();
    });

    const buf = await fetchUrl('https://example.com/redirect');
    expect(buf.toString('utf8')).toBe('final body');
    expect(callCount).toBe(2);
  });

  it('rejects for HTTP 4xx responses', async () => {
    const res = new EventEmitter();
    res.statusCode = 404;
    res.headers = {};

    httpsGetSpy.mockImplementation((_url, cb) => {
      cb(res);
      return makeReq();
    });

    await expect(fetchUrl('https://example.com/missing')).rejects.toThrow('HTTP 404');
  });

  it('rejects when the request emits an error', async () => {
    const req = new EventEmitter();
    req.on = (event, handler) => {
      if (event === 'error') {
        setImmediate(() => handler(new Error('network error')));
      }
      return req;
    };

    httpsGetSpy.mockImplementation((_url, _cb) => req);

    await expect(fetchUrl('https://example.com/error')).rejects.toThrow('network error');
  });

  it('decompresses a gzip-encoded response body', async () => {
    const zlib = require('node:zlib');
    const { promisify } = require('node:util');
    const gzip = promisify(zlib.gzip);

    const compressed = await gzip(Buffer.from('decompressed content'));

    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = { 'content-encoding': 'gzip' };
    setImmediate(() => {
      res.emit('data', compressed);
      res.emit('end');
    });

    httpsGetSpy.mockImplementation((_url, cb) => {
      cb(res);
      return makeReq();
    });

    const buf = await fetchUrl('https://example.com/gzipped');
    expect(buf.toString('utf8')).toBe('decompressed content');
  });

  it('rejects when collectBody fails inside the response handler', async () => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    // Emit an error on the response stream to trigger the catch path
    setImmediate(() => {
      res.emit('error', new Error('body read error'));
    });

    httpsGetSpy.mockImplementation((_url, cb) => {
      cb(res);
      return makeReq();
    });

    await expect(fetchUrl('https://example.com/body-error')).rejects.toThrow('body read error');
  });
});

// ---------------------------------------------------------------------------
// syncDistribution (integration-style with mocked I/O)
// ---------------------------------------------------------------------------

describe('syncDistribution', () => {
  const https = require('node:https');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { EventEmitter } = require('node:events');

  let tmpDir;
  let httpsGetSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdin-sync-test-'));
    httpsGetSpy = jest.spyOn(https, 'get');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeResponse({ statusCode = 200, headers = {}, body = '' }) {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = headers;
    setImmediate(() => {
      res.emit('data', typeof body === 'string' ? Buffer.from(body) : body);
      res.emit('end');
    });
    return res;
  }

  function makeReq() {
    return { on: jest.fn().mockReturnThis() };
  }

  it('returns true when all files are fetched successfully', async () => {
    const manifest = {
      timestamp: 12345,
      languages: ['en', 'fr'],
      content: {
        'en': ['/en/strings.json'],
        'fr': ['/fr/strings.json'],
      },
    };

    httpsGetSpy.mockImplementation((url, cb) => {
      if (url.endsWith('manifest.json')) {
        cb(makeResponse({ body: JSON.stringify(manifest) }));
      } else if (url.endsWith('languages.json')) {
        cb(makeResponse({ body: '{}' }));
      } else {
        cb(makeResponse({ body: '{"key":"value"}' }));
      }
      return makeReq();
    });

    const ok = await syncDistribution('testhash', tmpDir);
    expect(ok).toBe(true);
  });

  it('returns false when one content file fails to fetch', async () => {
    const manifest = {
      timestamp: 1,
      languages: [],
      content: { 'en': ['/en/fail.json'] },
    };

    let callCount = 0;
    httpsGetSpy.mockImplementation((url, cb) => {
      callCount++;
      if (url.endsWith('manifest.json')) {
        cb(makeResponse({ body: JSON.stringify(manifest) }));
        return makeReq();
      }
      if (url.endsWith('languages.json')) {
        cb(makeResponse({ body: '{}' }));
        return makeReq();
      }
      // Simulate a 404 for content files
      cb(makeResponse({ statusCode: 404, body: '' }));
      return makeReq();
    });

    const ok = await syncDistribution('failhash', tmpDir);
    expect(ok).toBe(false);
    expect(callCount).toBeGreaterThan(1);
  });

  it('writes manifest.json and languages.json to disk', async () => {
    const manifest = { timestamp: 99, languages: [], content: {} };

    httpsGetSpy.mockImplementation((url, cb) => {
      if (url.endsWith('manifest.json')) {
        cb(makeResponse({ body: JSON.stringify(manifest) }));
      } else {
        cb(makeResponse({ body: '{}' }));
      }
      return makeReq();
    });

    await syncDistribution('writehash', tmpDir);

    expect(fs.existsSync(path.join(tmpDir, 'writehash', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'writehash', 'languages.json'))).toBe(true);
  });

  it('handles manifest without a content property', async () => {
    // Covers the `if (manifest.content)` false branch
    const manifest = { timestamp: 7, languages: [] }; // no `content` key

    httpsGetSpy.mockImplementation((url, cb) => {
      if (url.endsWith('manifest.json')) {
        cb(makeResponse({ body: JSON.stringify(manifest) }));
      } else {
        cb(makeResponse({ body: '{}' }));
      }
      return makeReq();
    });

    const ok = await syncDistribution('nocontenthash', tmpDir);
    expect(ok).toBe(true);
  });

  it('handles manifest without a languages property', async () => {
    // Covers the `manifest.languages || []` fallback branch
    const manifest = { timestamp: 42, content: {} }; // no `languages` key

    httpsGetSpy.mockImplementation((url, cb) => {
      if (url.endsWith('manifest.json')) {
        cb(makeResponse({ body: JSON.stringify(manifest) }));
      } else {
        cb(makeResponse({ body: '{}' }));
      }
      return makeReq();
    });

    const ok = await syncDistribution('nolangshash', tmpDir);
    expect(ok).toBe(true);
  });

  it('logs progress every 50 files', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});

    // Build a manifest with exactly 50 content paths so the modulo fires.
    const contentPaths = {};
    for (let i = 0; i < 50; i++) {
      contentPaths[`lang${i}`] = [`/lang${i}/strings.json`];
    }
    const manifest = { timestamp: 1, languages: [], content: contentPaths };

    httpsGetSpy.mockImplementation((url, cb) => {
      if (url.endsWith('manifest.json')) {
        cb(makeResponse({ body: JSON.stringify(manifest) }));
      } else if (url.endsWith('languages.json')) {
        cb(makeResponse({ body: '{}' }));
      } else {
        cb(makeResponse({ body: '{}' }));
      }
      return makeReq();
    });

    await syncDistribution('progresshash', tmpDir);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Progress:'));
  });
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

describe('main', () => {
  const https = require('node:https');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { EventEmitter } = require('node:events');

  let tmpDir;
  let httpsGetSpy;
  let originalDistIds;
  let originalOutputDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crowdin-main-test-'));
    originalDistIds = process.env.CROWDIN_DISTRIBUTION_IDS;
    originalOutputDir = process.env.OUTPUT_DIR;
    httpsGetSpy = jest.spyOn(https, 'get');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalDistIds === undefined) {
      delete process.env.CROWDIN_DISTRIBUTION_IDS;
    } else {
      process.env.CROWDIN_DISTRIBUTION_IDS = originalDistIds;
    }
    if (originalOutputDir === undefined) {
      delete process.env.OUTPUT_DIR;
    } else {
      process.env.OUTPUT_DIR = originalOutputDir;
    }
  });

  function makeResponse({ statusCode = 200, headers = {}, body = '' }) {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = headers;
    setImmediate(() => {
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    return res;
  }

  function makeReq() {
    return { on: jest.fn().mockReturnThis() };
  }

  it('completes successfully when all distributions sync without error', async () => {
    // main() reads DISTRIBUTIONS at module load time, so we call syncDistribution
    // indirectly via main(). We need to provide OUTPUT_DIR and set up a working hash.
    // The DISTRIBUTIONS constant is already frozen at require time; we exercise main()
    // by passing a hash that succeeds.
    process.env.OUTPUT_DIR = tmpDir;

    const manifest = { timestamp: 1, languages: [], content: {} };
    httpsGetSpy.mockImplementation((url, cb) => {
      if (url.endsWith('manifest.json')) {
        cb(makeResponse({ body: JSON.stringify(manifest) }));
      } else {
        cb(makeResponse({ body: '{}' }));
      }
      return makeReq();
    });

    // Re-require the module with the new env set so DISTRIBUTIONS picks it up.
    jest.resetModules();
    process.env.CROWDIN_DISTRIBUTION_IDS = 'mainhash';
    const { main: mainFn } = require('../src/sync-crowdin-distribution.cjs');

    await mainFn();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sync complete'));
  });

  it('logs FATAL and calls process.exit(1) when a distribution throws', async () => {
    process.env.OUTPUT_DIR = tmpDir;
    process.env.CROWDIN_DISTRIBUTION_IDS = 'brokenhash';

    jest.resetModules();
    const { main: mainFn } = require('../src/sync-crowdin-distribution.cjs');

    // Make every https.get fail
    httpsGetSpy.mockImplementation((_url, cb) => {
      const res = new EventEmitter();
      res.statusCode = 500;
      res.headers = {};
      setImmediate(() => cb(res));
      return makeReq();
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

    await mainFn();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('FATAL'), expect.anything());
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls process.exit(1) when some distributions fail', async () => {
    process.env.OUTPUT_DIR = tmpDir;
    process.env.CROWDIN_DISTRIBUTION_IDS = 'partialfail';

    jest.resetModules();
    const { main: mainFn } = require('../src/sync-crowdin-distribution.cjs');

    // Make manifest fetch succeed but content fetch 404 (so failed > 0)
    const manifest = { timestamp: 1, languages: [], content: { en: ['/en/x.json'] } };
    httpsGetSpy.mockImplementation((url, cb) => {
      if (url.endsWith('manifest.json')) {
        cb(makeResponse({ body: JSON.stringify(manifest) }));
      } else if (url.endsWith('languages.json')) {
        cb(makeResponse({ body: '{}' }));
      } else {
        cb(makeResponse({ statusCode: 404, body: '' }));
      }
      return makeReq();
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

    await mainFn();

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Sync completed with errors'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
