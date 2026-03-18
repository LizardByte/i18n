import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';

import { parseCrowdinProjectIds, validateEnv } from '../src/common.js';

describe('parseCrowdinProjectIds', () => {
  const originalEnv = process.env.CROWDIN_PROJECT_IDS;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CROWDIN_PROJECT_IDS;
    else process.env.CROWDIN_PROJECT_IDS = originalEnv;
  });

  it('returns an array of trimmed project IDs', () => {
    process.env.CROWDIN_PROJECT_IDS = '123, 456 , 789';
    expect(parseCrowdinProjectIds()).toEqual(['123', '456', '789']);
  });

  it('filters out empty entries from extra commas', () => {
    process.env.CROWDIN_PROJECT_IDS = '123,,456';
    expect(parseCrowdinProjectIds()).toEqual(['123', '456']);
  });

  it('returns an empty array when the env var is not set', () => {
    delete process.env.CROWDIN_PROJECT_IDS;
    expect(parseCrowdinProjectIds()).toEqual([]);
  });

  it('returns an empty array when the env var is empty', () => {
    process.env.CROWDIN_PROJECT_IDS = '';
    expect(parseCrowdinProjectIds()).toEqual([]);
  });

  it('returns an empty array when the env var is only whitespace/commas', () => {
    process.env.CROWDIN_PROJECT_IDS = ' , , ';
    expect(parseCrowdinProjectIds()).toEqual([]);
  });

  it('handles a single project ID', () => {
    process.env.CROWDIN_PROJECT_IDS = '42';
    expect(parseCrowdinProjectIds()).toEqual(['42']);
  });
});

describe('validateEnv', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
  });

  afterEach(() => jest.restoreAllMocks());

  it('does not exit when all required vars are set and projectIds is non-empty', () => {
    const orig = process.env.SOME_VAR;
    process.env.SOME_VAR = 'value';
    expect(() => validateEnv(['SOME_VAR'], ['42'])).not.toThrow();
    if (orig === undefined) delete process.env.SOME_VAR;
    else process.env.SOME_VAR = orig;
  });

  it('exits when a required env var is missing', () => {
    delete process.env.MISSING_VAR;
    expect(() => validateEnv(['MISSING_VAR'], ['42'])).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('MISSING_VAR'));
  });

  it('exits when projectIds is empty', () => {
    expect(() => validateEnv([], [])).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('CROWDIN_PROJECT_IDS'));
  });

  it('exits on the first missing var without checking the rest', () => {
    delete process.env.FIRST_MISSING;
    delete process.env.SECOND_MISSING;
    expect(() => validateEnv(['FIRST_MISSING', 'SECOND_MISSING'], ['42'])).toThrow('process.exit');
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
