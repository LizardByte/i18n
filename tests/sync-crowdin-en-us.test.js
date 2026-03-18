import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';

// Module-level mocks
//
// jest.mock() factories are hoisted to the very top of the compiled output,
// before ANY other code runs. Therefore, the factory functions must be
// completely self-contained and cannot reference variables declared below.

jest.mock('../src/common.js', () => ({
  parseCrowdinProjectIds: jest.fn().mockReturnValue([]),
  validateEnv: jest.fn(),
}));

jest.mock('@crowdin/crowdin-api-client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    sourceStringsApi: {
      withFetchAll: jest.fn().mockReturnValue({
        listProjectStrings: jest.fn().mockResolvedValue({ data: [] }),
      }),
    },
    stringTranslationsApi: {
      withFetchAll: jest.fn().mockReturnValue({
        listStringTranslations: jest.fn().mockResolvedValue({ data: [] }),
        listTranslationApprovals: jest.fn().mockResolvedValue({ data: [] }),
        listLanguageTranslations: jest.fn().mockResolvedValue({ data: [] }),
      }),
      addTranslation: jest.fn().mockResolvedValue({ data: { id: 100, text: 'source text' } }),
      deleteTranslation: jest.fn().mockResolvedValue({}),
      addApproval: jest.fn().mockResolvedValue({ data: { id: 200, translationId: 100 } }),
    },
    projectsGroupsApi: {
      getProject: jest.fn().mockResolvedValue({ data: { identifier: 'fake-project-slug' } }),
    },
  })),
}));

// Import the mocked constructor so we can inspect .mock.results
import { Client as CrowdinClient } from '@crowdin/crowdin-api-client';

import {
  EN_US,
  fetchSourceStrings,
  fetchApprovedProjectTranslations,
  fetchTranslations,
  fetchApprovals,
  addTranslation,
  deleteTranslation,
  approveTranslation,
  normalisedTextEntries,
  stringLogPrefix,
  ensureTranslation,
  isFullyApproved,
  syncStringTranslation,
  syncProject,
  main,
} from '../src/sync-crowdin-en-us.js';

// Extract mock fn references from the singleton instances created at module
// load time (the first constructor call in .mock.results[0].value).

/** The CrowdinClient instance that the module captured. */
const _crowdinInst = CrowdinClient.mock.results[0].value;

// Source strings mocks
const mockSourceStringsWithFetchAll = _crowdinInst.sourceStringsApi.withFetchAll;
const mockListProjectStrings = mockSourceStringsWithFetchAll().listProjectStrings;

// String translations mocks
const mockTranslationsWithFetchAll = _crowdinInst.stringTranslationsApi.withFetchAll;
const mockListStringTranslations = mockTranslationsWithFetchAll().listStringTranslations;
const mockListTranslationApprovals = mockTranslationsWithFetchAll().listTranslationApprovals;
const mockListLanguageTranslations = mockTranslationsWithFetchAll().listLanguageTranslations;
const mockAddTranslation = _crowdinInst.stringTranslationsApi.addTranslation;
const mockDeleteTranslation = _crowdinInst.stringTranslationsApi.deleteTranslation;
const mockAddApproval = _crowdinInst.stringTranslationsApi.addApproval;

// Helpers

/** Build a minimal source string object. */
function makeSourceString(overrides = {}) {
  return {
    id: 1,
    text: 'Hello world',
    ...overrides,
  };
}

/** Build a minimal translation object. */
function makeTranslation(overrides = {}) {
  return {
    id: 100,
    text: 'Hello world',
    pluralCategoryName: null,
    ...overrides,
  };
}

/** Build a minimal approval object. */
function makeApproval(overrides = {}) {
  return {
    id: 200,
    translationId: 100,
    ...overrides,
  };
}

// EN_US constant

describe('EN_US', () => {
  it('is the string "en-US"', () => {
    expect(EN_US).toBe('en-US');
  });
});

// normalisedTextEntries

describe('normalisedTextEntries', () => {
  it('returns a single entry with null pluralCategoryName for a plain string', () => {
    const entries = normalisedTextEntries('Hello world');
    expect(entries).toEqual([{ pluralCategoryName: null, text: 'Hello world' }]);
  });

  it('returns multiple entries for a plural text object', () => {
    const plural = { one: 'One item', other: 'Many items' };
    const entries = normalisedTextEntries(plural);
    expect(entries).toHaveLength(2);
    expect(entries).toContainEqual({ pluralCategoryName: 'one', text: 'One item' });
    expect(entries).toContainEqual({ pluralCategoryName: 'other', text: 'Many items' });
  });

  it('returns entries for all six plural forms when present', () => {
    const plural = {
      zero: 'zero',
      one: 'one',
      two: 'two',
      few: 'few',
      many: 'many',
      other: 'other',
    };
    const entries = normalisedTextEntries(plural);
    expect(entries).toHaveLength(6);
    for (const category of ['zero', 'one', 'two', 'few', 'many', 'other']) {
      expect(entries).toContainEqual({ pluralCategoryName: category, text: category });
    }
  });

  it('returns an empty array for an empty plural object', () => {
    expect(normalisedTextEntries({})).toEqual([]);
  });
});

// fetchSourceStrings

describe('fetchSourceStrings', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns unwrapped source string data objects', async () => {
    const raw = [
      { data: makeSourceString({ id: 1 }) },
      { data: makeSourceString({ id: 2 }) },
    ];
    mockListProjectStrings.mockResolvedValue({ data: raw });

    const result = await fetchSourceStrings('123');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(2);
  });

  it('returns an empty array when response.data is null/undefined', async () => {
    mockListProjectStrings.mockResolvedValue({});
    const result = await fetchSourceStrings('999');
    expect(result).toEqual([]);
  });

  it('calls withFetchAll and listProjectStrings with the project ID', async () => {
    mockListProjectStrings.mockResolvedValue({ data: [] });
    await fetchSourceStrings('777');
    expect(mockSourceStringsWithFetchAll).toHaveBeenCalled();
    expect(mockListProjectStrings).toHaveBeenCalledWith('777');
  });
});

// fetchTranslations

describe('fetchTranslations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns unwrapped translation data objects', async () => {
    const raw = [
      { data: makeTranslation({ id: 10 }) },
      { data: makeTranslation({ id: 11 }) },
    ];
    mockListStringTranslations.mockResolvedValue({ data: raw });

    const result = await fetchTranslations('42', 99);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(10);
    expect(result[1].id).toBe(11);
  });

  it('returns an empty array when response.data is null/undefined', async () => {
    mockListStringTranslations.mockResolvedValue({});
    const result = await fetchTranslations('42', 99);
    expect(result).toEqual([]);
  });

  it('calls listStringTranslations with projectId, stringId, and EN_US', async () => {
    mockListStringTranslations.mockResolvedValue({ data: [] });
    await fetchTranslations('42', 99);
    expect(mockTranslationsWithFetchAll).toHaveBeenCalled();
    expect(mockListStringTranslations).toHaveBeenCalledWith('42', 99, EN_US);
  });
});

// fetchApprovals

describe('fetchApprovals', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns unwrapped approval data objects', async () => {
    const raw = [
      { data: makeApproval({ id: 20, translationId: 10 }) },
    ];
    mockListTranslationApprovals.mockResolvedValue({ data: raw });

    const result = await fetchApprovals('42', 99);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(20);
  });

  it('returns an empty array when response.data is null/undefined', async () => {
    mockListTranslationApprovals.mockResolvedValue({});
    const result = await fetchApprovals('42', 99);
    expect(result).toEqual([]);
  });

  it('calls listTranslationApprovals with projectId, stringId, and EN_US', async () => {
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    await fetchApprovals('42', 99);
    expect(mockTranslationsWithFetchAll).toHaveBeenCalled();
    expect(mockListTranslationApprovals).toHaveBeenCalledWith('42', {
      stringId: 99,
      languageId: EN_US,
    });
  });
});

// addTranslation

describe('addTranslation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls addTranslation with correct args and returns data', async () => {
    mockAddTranslation.mockResolvedValue({ data: { id: 50 } });
    const result = await addTranslation('42', 1, 'Hello');
    expect(result).toEqual({ id: 50 });
    expect(mockAddTranslation).toHaveBeenCalledWith('42', {
      stringId: 1,
      languageId: EN_US,
      text: 'Hello',
    });
  });

  it('includes pluralCategoryName when provided', async () => {
    mockAddTranslation.mockResolvedValue({ data: { id: 51 } });
    await addTranslation('42', 1, 'One item', 'one');
    expect(mockAddTranslation).toHaveBeenCalledWith('42', {
      stringId: 1,
      languageId: EN_US,
      text: 'One item',
      pluralCategoryName: 'one',
    });
  });

  it('does not include pluralCategoryName when null', async () => {
    mockAddTranslation.mockResolvedValue({ data: { id: 52 } });
    await addTranslation('42', 1, 'Hello', null);
    const call = mockAddTranslation.mock.calls[0][1];
    expect(call).not.toHaveProperty('pluralCategoryName');
  });
});

// deleteTranslation

describe('deleteTranslation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls deleteTranslation with the correct args', async () => {
    mockDeleteTranslation.mockResolvedValue({});
    await deleteTranslation('42', 999);
    expect(mockDeleteTranslation).toHaveBeenCalledWith('42', 999);
  });
});

// approveTranslation

describe('approveTranslation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls addApproval with the correct translationId and returns data', async () => {
    mockAddApproval.mockResolvedValue({ data: { id: 300, translationId: 999 } });
    const result = await approveTranslation('42', 999);
    expect(result).toEqual({ id: 300, translationId: 999 });
    expect(mockAddApproval).toHaveBeenCalledWith('42', { translationId: 999 });
  });
});

// stringLogPrefix

describe('stringLogPrefix', () => {
  it('returns a prefix without bracket suffix for plain strings (null category)', () => {
    expect(stringLogPrefix(42, null)).toBe('String 42');
  });

  it('returns a prefix with bracket suffix for plural categories', () => {
    expect(stringLogPrefix(42, 'one')).toBe('String 42 [one]');
  });
});

// ensureTranslation

describe('ensureTranslation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the existing translation id when text matches (no delete/add)', async () => {
    const existing = makeTranslation({ id: 77, text: 'Hello' });
    const result = await ensureTranslation('42', 1, 'Hello', null, existing);
    expect(result).toBe(77);
    expect(mockDeleteTranslation).not.toHaveBeenCalled();
    expect(mockAddTranslation).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('matches'));
  });

  it('deletes stale translation, adds new one and returns new id', async () => {
    const existing = makeTranslation({ id: 77, text: 'Old text' });
    mockAddTranslation.mockResolvedValue({ data: { id: 78, text: 'New text' } });

    const result = await ensureTranslation('42', 1, 'New text', null, existing);
    expect(result).toBe(78);
    expect(mockDeleteTranslation).toHaveBeenCalledWith('42', 77);
    expect(mockAddTranslation).toHaveBeenCalledWith('42', expect.objectContaining({
      text: 'New text',
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('updated'));
  });

  it('adds a new translation when no existing one and returns new id', async () => {
    mockAddTranslation.mockResolvedValue({ data: { id: 50, text: 'Hello' } });

    const result = await ensureTranslation('42', 1, 'Hello', null, null);
    expect(result).toBe(50);
    expect(mockDeleteTranslation).not.toHaveBeenCalled();
    expect(mockAddTranslation).toHaveBeenCalledWith('42', expect.objectContaining({
      text: 'Hello',
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('added'));
  });

  it('passes pluralCategoryName through when set', async () => {
    mockAddTranslation.mockResolvedValue({ data: { id: 90 } });
    await ensureTranslation('42', 1, 'One', 'one', null);
    expect(mockAddTranslation).toHaveBeenCalledWith('42', expect.objectContaining({
      pluralCategoryName: 'one',
    }));
  });
});

// syncStringTranslation

describe('syncStringTranslation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('adds and approves a translation when none exists (plain string)', async () => {
    const sourceString = makeSourceString({ id: 1, text: 'Hello' });
    mockListStringTranslations.mockResolvedValue({ data: [] });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddTranslation.mockResolvedValue({ data: { id: 50, text: 'Hello' } });
    mockAddApproval.mockResolvedValue({ data: { id: 200, translationId: 50 } });

    await syncStringTranslation('42', sourceString);

    expect(mockAddTranslation).toHaveBeenCalledWith('42', expect.objectContaining({
      stringId: 1,
      text: 'Hello',
      languageId: EN_US,
    }));
    expect(mockAddApproval).toHaveBeenCalledWith('42', { translationId: 50 });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('added'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('approved'));
  });

  it('does not delete/add translation when it already matches, and approves it', async () => {
    const sourceString = makeSourceString({ id: 1, text: 'Hello' });
    const existingTranslation = makeTranslation({ id: 77, text: 'Hello' });
    mockListStringTranslations.mockResolvedValue({ data: [{ data: existingTranslation }] });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddApproval.mockResolvedValue({ data: { id: 200, translationId: 77 } });

    await syncStringTranslation('42', sourceString);

    expect(mockDeleteTranslation).not.toHaveBeenCalled();
    expect(mockAddTranslation).not.toHaveBeenCalled();
    expect(mockAddApproval).toHaveBeenCalledWith('42', { translationId: 77 });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('matches'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('approved'));
  });

  it('replaces a stale translation and approves the new one', async () => {
    const sourceString = makeSourceString({ id: 1, text: 'Hello updated' });
    const staleTranslation = makeTranslation({ id: 77, text: 'Hello old' });
    mockListStringTranslations.mockResolvedValue({ data: [{ data: staleTranslation }] });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddTranslation.mockResolvedValue({ data: { id: 78, text: 'Hello updated' } });
    mockAddApproval.mockResolvedValue({ data: { id: 200, translationId: 78 } });

    await syncStringTranslation('42', sourceString);

    expect(mockDeleteTranslation).toHaveBeenCalledWith('42', 77);
    expect(mockAddTranslation).toHaveBeenCalledWith('42', expect.objectContaining({
      text: 'Hello updated',
    }));
    expect(mockAddApproval).toHaveBeenCalledWith('42', { translationId: 78 });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('updated'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('approved'));
  });

  it('does not call addApproval when translation is already approved', async () => {
    const sourceString = makeSourceString({ id: 1, text: 'Hello' });
    const existingTranslation = makeTranslation({ id: 77, text: 'Hello' });
    const existingApproval = makeApproval({ translationId: 77 });
    mockListStringTranslations.mockResolvedValue({ data: [{ data: existingTranslation }] });
    mockListTranslationApprovals.mockResolvedValue({ data: [{ data: existingApproval }] });

    await syncStringTranslation('42', sourceString);

    expect(mockAddApproval).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already approved'));
  });

  it('handles plural strings: adds/approves each plural form', async () => {
    const sourceString = makeSourceString({
      id: 2,
      text: { one: 'One item', other: 'Many items' },
    });
    mockListStringTranslations.mockResolvedValue({ data: [] });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddTranslation
      .mockResolvedValueOnce({ data: { id: 60, text: 'One item' } })
      .mockResolvedValueOnce({ data: { id: 61, text: 'Many items' } });
    mockAddApproval
      .mockResolvedValueOnce({ data: { id: 300, translationId: 60 } })
      .mockResolvedValueOnce({ data: { id: 301, translationId: 61 } });

    await syncStringTranslation('42', sourceString);

    expect(mockAddTranslation).toHaveBeenCalledTimes(2);
    expect(mockAddTranslation).toHaveBeenCalledWith('42', expect.objectContaining({
      pluralCategoryName: 'one',
      text: 'One item',
    }));
    expect(mockAddTranslation).toHaveBeenCalledWith('42', expect.objectContaining({
      pluralCategoryName: 'other',
      text: 'Many items',
    }));
    expect(mockAddApproval).toHaveBeenCalledTimes(2);
  });

  it('replaces only the stale plural form while keeping matching ones', async () => {
    const sourceString = makeSourceString({
      id: 3,
      text: { one: 'One item', other: 'Many items' },
    });
    const matchingTranslation = makeTranslation({ id: 60, text: 'One item', pluralCategoryName: 'one' });
    const staleTranslation = makeTranslation({ id: 61, text: 'Old many', pluralCategoryName: 'other' });
    mockListStringTranslations.mockResolvedValue({
      data: [{ data: matchingTranslation }, { data: staleTranslation }],
    });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddTranslation.mockResolvedValue({ data: { id: 62, text: 'Many items' } });
    mockAddApproval
      .mockResolvedValueOnce({ data: { id: 300, translationId: 60 } })
      .mockResolvedValueOnce({ data: { id: 301, translationId: 62 } });

    await syncStringTranslation('42', sourceString);

    expect(mockDeleteTranslation).toHaveBeenCalledTimes(1);
    expect(mockDeleteTranslation).toHaveBeenCalledWith('42', 61);
    expect(mockAddTranslation).toHaveBeenCalledTimes(1);
    expect(mockAddApproval).toHaveBeenCalledTimes(2);
  });

  it('does not approve plural forms that are already approved', async () => {
    const sourceString = makeSourceString({
      id: 4,
      text: { one: 'One', other: 'Other' },
    });
    const t1 = makeTranslation({ id: 70, text: 'One', pluralCategoryName: 'one' });
    const t2 = makeTranslation({ id: 71, text: 'Other', pluralCategoryName: 'other' });
    const a1 = makeApproval({ translationId: 70 });
    const a2 = makeApproval({ translationId: 71 });
    mockListStringTranslations.mockResolvedValue({ data: [{ data: t1 }, { data: t2 }] });
    mockListTranslationApprovals.mockResolvedValue({ data: [{ data: a1 }, { data: a2 }] });

    await syncStringTranslation('42', sourceString);

    expect(mockAddApproval).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('already approved'));
  });

  it('logs with plural category name suffix when plural', async () => {
    const sourceString = makeSourceString({ id: 5, text: { one: 'One' } });
    mockListStringTranslations.mockResolvedValue({ data: [] });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddTranslation.mockResolvedValue({ data: { id: 80 } });
    mockAddApproval.mockResolvedValue({ data: { id: 300 } });

    await syncStringTranslation('42', sourceString);

    const logCalls = console.log.mock.calls.map((c) => c[0]);
    expect(logCalls.some((m) => m.includes('[one]'))).toBe(true);
  });
});

// fetchApprovedProjectTranslations

describe('fetchApprovedProjectTranslations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns unwrapped translation data objects', async () => {
    const raw = [
      { data: { translationId: 10, stringId: 1, pluralCategoryName: null } },
      { data: { translationId: 11, stringId: 2, pluralCategoryName: 'one' } },
    ];
    mockListLanguageTranslations.mockResolvedValue({ data: raw });

    const result = await fetchApprovedProjectTranslations('42');
    expect(result).toHaveLength(2);
    expect(result[0].translationId).toBe(10);
    expect(result[1].translationId).toBe(11);
  });

  it('returns an empty array when response.data is null/undefined', async () => {
    mockListLanguageTranslations.mockResolvedValue({});
    expect(await fetchApprovedProjectTranslations('42')).toEqual([]);
  });

  it('calls listLanguageTranslations with projectId, EN_US, and approvedOnly:1', async () => {
    mockListLanguageTranslations.mockResolvedValue({ data: [] });
    await fetchApprovedProjectTranslations('42');
    expect(mockTranslationsWithFetchAll).toHaveBeenCalled();
    expect(mockListLanguageTranslations).toHaveBeenCalledWith('42', EN_US, { approvedOnly: 1 });
  });
});

// isFullyApproved

describe('isFullyApproved', () => {
  it('returns true for a plain string with an approved translation', () => {
    const string = makeSourceString({ id: 1, text: 'Hello' });
    const map = new Map([[1, new Set([null])]]);
    expect(isFullyApproved(string, map)).toBe(true);
  });

  it('returns false for a plain string with no entry in the map', () => {
    const string = makeSourceString({ id: 1, text: 'Hello' });
    expect(isFullyApproved(string, new Map())).toBe(false);
  });

  it('returns false for a plain string whose category is not in the approved set', () => {
    const string = makeSourceString({ id: 1, text: 'Hello' });
    // Map has the string but an empty set – no category approved
    const map = new Map([[1, new Set()]]);
    expect(isFullyApproved(string, map)).toBe(false);
  });

  it('returns true for a plural string when all forms are approved', () => {
    const string = makeSourceString({ id: 2, text: { one: 'One', other: 'Other' } });
    const map = new Map([[2, new Set(['one', 'other'])]]);
    expect(isFullyApproved(string, map)).toBe(true);
  });

  it('returns false for a plural string when only some forms are approved', () => {
    const string = makeSourceString({ id: 2, text: { one: 'One', other: 'Other' } });
    const map = new Map([[2, new Set(['one'])]]);
    expect(isFullyApproved(string, map)).toBe(false);
  });

  it('returns false for a plural string when no forms are approved', () => {
    const string = makeSourceString({ id: 2, text: { one: 'One', other: 'Other' } });
    const map = new Map([[2, new Set()]]);
    expect(isFullyApproved(string, map)).toBe(false);
  });

  it('does not consider approvals belonging to other strings', () => {
    const string = makeSourceString({ id: 1, text: 'Hello' });
    // Only string 2 has an approved null category; string 1 has no entry
    const map = new Map([[2, new Set([null])]]);
    expect(isFullyApproved(string, map)).toBe(false);
  });
});

// syncProject

describe('syncProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs the project and string count', async () => {
    const strings = [makeSourceString({ id: 1 }), makeSourceString({ id: 2 })];
    mockListProjectStrings.mockResolvedValue({ data: strings.map((s) => ({ data: s })) });
    mockListLanguageTranslations.mockResolvedValue({ data: [] });
    mockListStringTranslations.mockResolvedValue({ data: [] });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddTranslation.mockResolvedValue({ data: { id: 50 } });
    mockAddApproval.mockResolvedValue({ data: { id: 200 } });

    await syncProject('42');

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Project 42'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 source string(s)'));
  });

  it('processes strings that are not fully approved', async () => {
    const strings = [makeSourceString({ id: 10 }), makeSourceString({ id: 11 })];
    mockListProjectStrings.mockResolvedValue({ data: strings.map((s) => ({ data: s })) });
    // No approved translations upfront → both strings need processing
    mockListLanguageTranslations.mockResolvedValue({ data: [] });
    mockListStringTranslations.mockResolvedValue({ data: [] });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddTranslation.mockResolvedValue({ data: { id: 50 } });
    mockAddApproval.mockResolvedValue({ data: { id: 200 } });

    await syncProject('42');

    // One fetchTranslations call per string that needs processing
    expect(mockListStringTranslations).toHaveBeenCalledTimes(2);
  });

  it('skips strings that are already fully approved', async () => {
    const string = makeSourceString({ id: 5, text: 'Hello' });
    mockListProjectStrings.mockResolvedValue({ data: [{ data: string }] });
    // approvedOnly response includes stringId=5, category=null → fully covered
    mockListLanguageTranslations.mockResolvedValue({
      data: [{ data: { translationId: 77, stringId: 5, pluralCategoryName: null } }],
    });

    await syncProject('42');

    expect(mockListStringTranslations).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 string(s) skipped'));
  });

  it('processes only unapproved strings, skipping the rest', async () => {
    const approvedString = makeSourceString({ id: 5, text: 'Hello' });
    const unapprovedString = makeSourceString({ id: 6, text: 'World' });
    mockListProjectStrings.mockResolvedValue({
      data: [{ data: approvedString }, { data: unapprovedString }],
    });
    // Only string 5 is approved
    mockListLanguageTranslations.mockResolvedValue({
      data: [{ data: { translationId: 77, stringId: 5, pluralCategoryName: null } }],
    });
    mockListStringTranslations.mockResolvedValue({ data: [] });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddTranslation.mockResolvedValue({ data: { id: 50 } });
    mockAddApproval.mockResolvedValue({ data: { id: 200 } });

    await syncProject('42');

    // Only one per-string fetch (for string 6)
    expect(mockListStringTranslations).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 string(s) skipped'));
  });

  it('skips a plural string only when all its forms are approved', async () => {
    const string = makeSourceString({ id: 8, text: { one: 'One', other: 'Other' } });
    mockListProjectStrings.mockResolvedValue({ data: [{ data: string }] });
    // Two entries share the same stringId=8 — exercises the map-accumulation branch
    mockListLanguageTranslations.mockResolvedValue({
      data: [
        { data: { translationId: 80, stringId: 8, pluralCategoryName: 'one' } },
        { data: { translationId: 81, stringId: 8, pluralCategoryName: 'other' } },
      ],
    });

    await syncProject('42');

    expect(mockListStringTranslations).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('1 string(s) skipped'));
  });

  it('does not log skipped message when no strings are skipped', async () => {
    const string = makeSourceString({ id: 7, text: 'Test' });
    mockListProjectStrings.mockResolvedValue({ data: [{ data: string }] });
    mockListLanguageTranslations.mockResolvedValue({ data: [] });
    mockListStringTranslations.mockResolvedValue({ data: [] });
    mockListTranslationApprovals.mockResolvedValue({ data: [] });
    mockAddTranslation.mockResolvedValue({ data: { id: 50 } });
    mockAddApproval.mockResolvedValue({ data: { id: 200 } });

    await syncProject('42');

    const logs = console.log.mock.calls.map((c) => c[0]);
    expect(logs.some((m) => m.includes('skipped'))).toBe(false);
  });

  it('handles a project with no source strings', async () => {
    mockListProjectStrings.mockResolvedValue({ data: [] });
    mockListLanguageTranslations.mockResolvedValue({ data: [] });

    await syncProject('99');

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('0 source string(s)'));
    expect(mockAddTranslation).not.toHaveBeenCalled();
  });
});

// main

describe('main', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('completes successfully with no projects configured', async () => {
    await main();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sync complete'));
  });

  it('calls syncProject for each project ID when projects are configured', async () => {
    const origProjectIds = process.env.CROWDIN_PROJECT_IDS;
    process.env.CROWDIN_PROJECT_IDS = '111,222';

    let freshMain;
    await jest.isolateModulesAsync(async () => {
      // Make parseCrowdinProjectIds return the expected IDs for this isolated load.
      const common = await import('../src/common.js');
      common.parseCrowdinProjectIds.mockReturnValue(['111', '222']);
      const mod = await import('../src/sync-crowdin-en-us.js');
      freshMain = mod.main;
    });

    mockListProjectStrings.mockResolvedValue({ data: [] });
    mockListLanguageTranslations.mockResolvedValue({ data: [] });

    await freshMain();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sync complete'));
    // Should have processed both projects
    const projectLogs = console.log.mock.calls
      .map((c) => c[0])
      .filter((m) => typeof m === 'string' && m.includes('Project'));
    expect(projectLogs.some((m) => m.includes('111'))).toBe(true);
    expect(projectLogs.some((m) => m.includes('222'))).toBe(true);

    // Restore
    if (origProjectIds === undefined) delete process.env.CROWDIN_PROJECT_IDS;
    else process.env.CROWDIN_PROJECT_IDS = origProjectIds;
  });
});
