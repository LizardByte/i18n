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
// before ANY other code runs. Therefore the factory functions must be
// completely self-contained and cannot reference variables declared below.

jest.mock('@crowdin/crowdin-api-client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    projectsGroupsApi: {
      withFetchAll: jest.fn().mockReturnValue({
        listProjects: jest.fn().mockResolvedValue({ data: [] }),
      }),
    },
    translationStatusApi: {
      withFetchAll: jest.fn().mockReturnValue({
        getProjectProgress: jest.fn().mockResolvedValue({ data: [] }),
      }),
    },
  })),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      issues: {
        createLabel: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ data: { number: 1 } }),
        update: jest.fn().mockResolvedValue({ data: {} }),
        listForRepo: jest.fn(),
      },
    },
    paginate: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('node:fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

jest.mock('../src/common.js', () => ({
  parseCrowdinProjectIds: jest.fn().mockReturnValue([]),
  validateEnv: jest.fn(),
}));

// Mock language-managers.json so tests never depend on real usernames.
jest.mock('../language-managers.json', () => ({
  'fr': [
    { discord: 'fake-discord-fr', crowdin: 'fake-crowdin-fr', github: 'fake-github-fr' },
  ],
  'de': [
    { discord: 'fake-discord-de', crowdin: 'fake-crowdin-de', github: 'fake-github-de' },
    { discord: 'fake-discord-de2', crowdin: 'fake-crowdin-de2', github: 'fake-github-de2' },
  ],
  'es': [
    { discord: 'fake-discord-es', crowdin: 'fake-crowdin-es', github: 'fake-github-es' },
  ],
  'ja': [
    { discord: 'fake-discord-ja', crowdin: 'fake-crowdin-ja', github: null },
  ],
  'pt': [
    { discord: 'fake-discord-pt', crowdin: 'fake-crowdin-pt', github: 'fake-github-pt' },
  ],
  'pt-BR': [
    { discord: 'fake-discord-ptbr', crowdin: 'fake-crowdin-ptbr', github: 'fake-github-ptbr' },
  ],
  'aa': [],
}), { virtual: false });

// Import mocked constructors
import { Client as CrowdinClient } from '@crowdin/crowdin-api-client';
import { Octokit } from '@octokit/rest';
import fs from 'node:fs';

import {
  PINNED_ISSUE_MARKER,
  PINNED_ISSUE_TITLE,
  PROGRESS_LABEL,
  PROGRESS_LABEL_COLOR,
  BAR_LENGTH,
  fetchProjects,
  fetchProjectProgress,
  getLanguageManagers,
  formatManagers,
  buildProgressBar,
  getLanguageName,
  sortProgressEntries,
  buildProjectTable,
  buildPinnedIssueBody,
  generateProjectSvg,
  escapeXml,
  ensureProgressLabel,
  findPinnedIssue,
  createPinnedIssue,
  updateIssue,
  upsertPinnedIssue,
  fetchAllProjectsProgress,
  generateAllSvgs,
  main,
} from '../src/crowdin-progress.js';

/** The Octokit instance that the module captured. */
const _octokitInst = Octokit.mock.results[0].value;
/** The CrowdinClient instance that the module captured. */
const _crowdinInst = CrowdinClient.mock.results[0].value;

const mockListProjects = _crowdinInst.projectsGroupsApi.withFetchAll().listProjects;
const mockGetProjectProgress = _crowdinInst.translationStatusApi.withFetchAll().getProjectProgress;

const mockCreateLabel = _octokitInst.rest.issues.createLabel;
const mockCreate = _octokitInst.rest.issues.create;
const mockUpdate = _octokitInst.rest.issues.update;
const mockPaginate = _octokitInst.paginate;

function makeEntry(overrides = {}) {
  return {
    language: { id: 'fr', name: 'French' },
    translationProgress: 50,
    approvalProgress: 20,
    ...overrides,
  };
}

function makeProject(overrides = {}) {
  return {
    id: 42,
    name: 'TestProject',
    identifier: 'test-project',
    ...overrides,
  };
}

function makeGhIssue(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    title: PINNED_ISSUE_TITLE,
    body: `body\n${PINNED_ISSUE_MARKER}`,
    ...overrides,
  };
}

const SVG_TEST_OUT = 'test-out';
const SVG_OUT = 'out';

describe('PINNED_ISSUE_MARKER', () => {
  it('is the expected HTML comment string', () => {
    expect(PINNED_ISSUE_MARKER).toBe('<!-- crowdin-progress-pinned-issue -->');
  });
});

describe('PINNED_ISSUE_TITLE', () => {
  it('is non-empty', () => {
    expect(typeof PINNED_ISSUE_TITLE).toBe('string');
    expect(PINNED_ISSUE_TITLE.length).toBeGreaterThan(0);
  });
});

describe('PROGRESS_LABEL', () => {
  it('is the string "crowdin-progress"', () => {
    expect(PROGRESS_LABEL).toBe('crowdin-progress');
  });
});

describe('PROGRESS_LABEL_COLOR', () => {
  it('is a 6-char hex string without #', () => {
    expect(PROGRESS_LABEL_COLOR).toMatch(/^[0-9a-fA-F]{6}$/);
  });
});

describe('BAR_LENGTH', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(BAR_LENGTH)).toBe(true);
    expect(BAR_LENGTH).toBeGreaterThan(0);
  });
});

describe('buildProgressBar', () => {
  it('returns all filled segments at 100%', () => {
    const bar = buildProgressBar(100);
    expect(bar).toContain('█'.repeat(BAR_LENGTH));
    expect(bar).toContain('100%');
  });

  it('returns all empty segments at 0%', () => {
    const bar = buildProgressBar(0);
    expect(bar).toContain('░'.repeat(BAR_LENGTH));
    expect(bar).toContain('0%');
  });

  it('returns mixed segments at 50%', () => {
    const bar = buildProgressBar(50);
    const half = BAR_LENGTH / 2;
    expect(bar).toContain('█'.repeat(half));
    expect(bar).toContain('░'.repeat(half));
    expect(bar).toContain('50%');
  });

  it('includes the percentage number at the end', () => {
    expect(buildProgressBar(73)).toContain('73%');
  });
});

describe('getLanguageName', () => {
  it('returns the API-provided name field', () => {
    expect(getLanguageName({ id: 'fr', name: 'French' })).toBe('French');
  });

  it('returns undefined when name field is absent', () => {
    expect(getLanguageName({ id: 'de' })).toBeUndefined();
  });

  it('returns undefined for an object with no name field', () => {
    expect(getLanguageName({ id: 'xx-unknown' })).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(getLanguageName(null)).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(getLanguageName(undefined)).toBeUndefined();
  });
});

describe('getLanguageManagers', () => {
  it('returns managers for a known language', () => {
    const managers = getLanguageManagers('fr');
    expect(managers).toHaveLength(1);
    expect(managers[0].github).toBe('fake-github-fr');
  });

  it.each([
    ['pt_BR', 'pt-BR'],
    ['pt-br', 'pt-BR'],
    ['es-ES', 'es'],
    ['pt_PT', 'pt'],
    ['esES', 'es'],
  ])('resolves %s the same as %s', (inputCode, expectedCode) => {
    expect(getLanguageManagers(inputCode)).toEqual(getLanguageManagers(expectedCode));
  });

  it('handles multi-level locale variants with no configured managers', () => {
    expect(getLanguageManagers('zz-Hant-TW')).toEqual([]);
  });

  it.each(['aa', 'zz', 'abcd'])('returns an empty array for %s when no managers are found', (languageId) => {
    expect(getLanguageManagers(languageId)).toEqual([]);
  });

  it('returns an empty array when languageId is null', () => {
    expect(getLanguageManagers(null)).toEqual([]);
  });

  it('returns an empty array when languageId is undefined', () => {
    expect(getLanguageManagers(undefined)).toEqual([]);
  });
});

describe('formatManagers', () => {
  it('returns @github mentions for managers with a github field', () => {
    expect(formatManagers('fr')).toBe('@fake-github-fr');
  });

  it('returns multiple @mentions separated by comma for multi-manager languages', () => {
    const result = formatManagers('de');
    expect(result).toContain('@fake-github-de');
    expect(result).toContain('@fake-github-de2');
  });

  it('falls back to base language managers for regional language ids', () => {
    expect(formatManagers('es-ES')).toBe('@fake-github-es');
  });

  it('supports compact locale ids when formatting manager mentions', () => {
    expect(formatManagers('ptPT')).toBe('@fake-github-pt');
  });

  it('falls back to discord handle when github is null', () => {
    expect(formatManagers('ja')).toBe('fake-discord-ja');
  });

  it('returns "—" for a language with no managers', () => {
    expect(formatManagers('aa')).toBe('—');
  });

  it('returns "—" for an unknown language', () => {
    expect(formatManagers('zz')).toBe('—');
  });
});

describe('sortProgressEntries', () => {
  it('sorts by approvalProgress ascending (0% first)', () => {
    const entries = [
      makeEntry({ language: { id: 'de', name: 'German' }, approvalProgress: 100, translationProgress: 100 }),
      makeEntry({ language: { id: 'fr', name: 'French' }, approvalProgress: 0, translationProgress: 50 }),
      makeEntry({ language: { id: 'es', name: 'Spanish' }, approvalProgress: 50, translationProgress: 80 }),
    ];
    const sorted = sortProgressEntries(entries);
    expect(sorted[0].language.id).toBe('fr');
    expect(sorted[1].language.id).toBe('es');
    expect(sorted[2].language.id).toBe('de');
  });

  it('uses translationProgress as a tiebreaker when approvalProgress is equal', () => {
    const entries = [
      makeEntry({ language: { id: 'de' }, approvalProgress: 0, translationProgress: 80 }),
      makeEntry({ language: { id: 'fr' }, approvalProgress: 0, translationProgress: 30 }),
    ];
    const sorted = sortProgressEntries(entries);
    expect(sorted[0].language.id).toBe('fr');
    expect(sorted[1].language.id).toBe('de');
  });

  it('uses language name as a tiebreaker when both percentages are equal', () => {
    const entries = [
      makeEntry({ language: { id: 'de', name: 'German' }, approvalProgress: 50, translationProgress: 50 }),
      makeEntry({ language: { id: 'fr', name: 'French' }, approvalProgress: 50, translationProgress: 50 }),
    ];
    const sorted = sortProgressEntries(entries);
    expect(sorted[0].language.id).toBe('fr'); // French < German alphabetically
  });

  it('does not mutate the original array', () => {
    const entries = [
      makeEntry({ language: { id: 'b' }, approvalProgress: 100 }),
      makeEntry({ language: { id: 'a' }, approvalProgress: 0 }),
    ];
    const original = [...entries];
    sortProgressEntries(entries);
    expect(entries).toEqual(original);
  });

  it('falls back to language id when name is absent for tiebreaker', () => {
    const entries = [
      makeEntry({ language: { id: 'de' }, approvalProgress: 50, translationProgress: 50 }),
      makeEntry({ language: { id: 'fr' }, approvalProgress: 50, translationProgress: 50 }),
    ];
    const sorted = sortProgressEntries(entries);
    expect(sorted[0].language.id).toBe('de');
    expect(sorted[1].language.id).toBe('fr');
  });

  it('falls back to empty string when language is null for tiebreaker', () => {
    const entries = [
      makeEntry({ language: null, approvalProgress: 50, translationProgress: 50 }),
      makeEntry({ language: { id: 'fr', name: 'French' }, approvalProgress: 50, translationProgress: 50 }),
    ];
    const sorted = sortProgressEntries(entries);
    // null language sorts before 'French' because '' < 'F'
    expect(sorted[0].language).toBeNull();
  });

  it('falls back to empty string when language has no id and no name for tiebreaker', () => {
    const entries = [
      makeEntry({ language: {}, approvalProgress: 50, translationProgress: 50 }),
      makeEntry({ language: { id: 'fr', name: 'French' }, approvalProgress: 50, translationProgress: 50 }),
    ];
    const sorted = sortProgressEntries(entries);
    // {} has no name and no id → '' which sorts before 'French'
    expect(sorted[0].language).toEqual({});
  });

  it('sorts two entries that both have no name and no language id', () => {
    const entries = [
      makeEntry({ language: {}, approvalProgress: 50, translationProgress: 50 }),
      makeEntry({ language: {}, approvalProgress: 50, translationProgress: 50 }),
    ];
    // Both hit ?? '' on both sides; result is stable (no throw)
    expect(() => sortProgressEntries(entries)).not.toThrow();
  });
});

describe('buildProjectTable', () => {
  it('includes a header row', () => {
    const table = buildProjectTable(makeProject(), [makeEntry()]);
    expect(table).toContain('| Language |');
    expect(table).toContain('| Code |');
    expect(table).toContain('| Translated |');
    expect(table).toContain('| Approved |');
    expect(table).toContain('| Managers |');
  });

  it('includes a separator row', () => {
    const table = buildProjectTable(makeProject(), [makeEntry()]);
    expect(table).toContain('|----------|');
  });

  it('includes the language code in backticks', () => {
    const table = buildProjectTable(makeProject(), [makeEntry({ language: { id: 'fr', name: 'French' } })]);
    expect(table).toContain('`fr`');
  });

  it('includes the language friendly name when the API provides one', () => {
    const table = buildProjectTable(makeProject(), [makeEntry({ language: { id: 'fr', name: 'French' } })]);
    expect(table).toContain('French');
  });

  it('uses the language code as the name cell when the API provides no name', () => {
    const table = buildProjectTable(makeProject(), [makeEntry({ language: { id: 'xx' } })]);
    const row = table.split('\n').find((l) => l.startsWith('| ') && !l.startsWith('| Language'));
    expect(row).toMatch(/^\| xx \|/);
  });

  it('includes progress bars for translation and approval', () => {
    const entry = makeEntry({ translationProgress: 80, approvalProgress: 40 });
    const table = buildProjectTable(makeProject(), [entry]);
    expect(table).toContain('80%');
    expect(table).toContain('40%');
  });

  it('includes manager @mentions', () => {
    const entry = makeEntry({ language: { id: 'fr', name: 'French' } });
    const table = buildProjectTable(makeProject(), [entry]);
    expect(table).toContain('@fake-github-fr');
  });

  it('shows "—" for manager cell when language has no managers', () => {
    const entry = makeEntry({ language: { id: 'aa', name: 'Afar' } });
    const table = buildProjectTable(makeProject(), [entry]);
    expect(table).toContain('| — |');
  });

  it('sorts entries by approval progress ascending', () => {
    const entries = [
      makeEntry({ language: { id: 'de', name: 'German' }, approvalProgress: 100, translationProgress: 100 }),
      makeEntry({ language: { id: 'fr', name: 'French' }, approvalProgress: 0, translationProgress: 50 }),
    ];
    const table = buildProjectTable(makeProject(), entries);
    const frIndex = table.indexOf('French');
    const deIndex = table.indexOf('German');
    expect(frIndex).toBeLessThan(deIndex);
  });

  it('produces an empty table body when entries array is empty', () => {
    const table = buildProjectTable(makeProject(), []);
    const lines = table.split('\n');
    expect(lines.length).toBe(2);
  });

  it('handles an entry with null language gracefully', () => {
    const entry = makeEntry({ language: null, translationProgress: 50, approvalProgress: 20 });
    const table = buildProjectTable(makeProject(), [entry]);
    expect(table).toContain('`—`');
  });

  it('defaults translationProgress to 0 when absent', () => {
    const entry = makeEntry({ translationProgress: undefined });
    const table = buildProjectTable(makeProject(), [entry]);
    expect(table).toContain('0%');
  });

  it('defaults approvalProgress to 0 when absent', () => {
    const entry = makeEntry({ approvalProgress: undefined });
    const table = buildProjectTable(makeProject(), [entry]);
    // 0% approval bar appears in the approved column
    const rows = table.split('\n').slice(2);
    expect(rows[0]).toContain('░'.repeat(10) + ' 0%');
  });
});

describe('buildPinnedIssueBody', () => {
  it('includes the hidden marker', () => {
    const body = buildPinnedIssueBody([{ project: makeProject(), entries: [] }]);
    expect(body).toContain(PINNED_ISSUE_MARKER);
  });

  it('includes the project name as a heading', () => {
    const body = buildPinnedIssueBody([{ project: makeProject({ name: 'MyProject' }), entries: [] }]);
    expect(body).toContain('MyProject');
  });

  it('links the heading to the Crowdin project URL when identifier is present', () => {
    const body = buildPinnedIssueBody([
      { project: makeProject({ identifier: 'my-project' }), entries: [] },
    ]);
    expect(body).toContain('https://crowdin.com/project/my-project');
  });

  it('renders a plain heading when identifier is absent', () => {
    const body = buildPinnedIssueBody([
      { project: makeProject({ identifier: undefined }), entries: [] },
    ]);
    expect(body).toContain('### TestProject');
    expect(body).not.toContain('http');
  });

  it('includes a last-updated timestamp', () => {
    const body = buildPinnedIssueBody([]);
    expect(body).toMatch(/Last updated:/);
  });

  it('includes sections for multiple projects', () => {
    const body = buildPinnedIssueBody([
      { project: makeProject({ name: 'Alpha' }), entries: [] },
      { project: makeProject({ name: 'Beta' }), entries: [] },
    ]);
    expect(body).toContain('Alpha');
    expect(body).toContain('Beta');
  });

  it('falls back to "Project <id>" when project name is absent', () => {
    const body = buildPinnedIssueBody([
      { project: { id: 99, identifier: undefined }, entries: [] },
    ]);
    expect(body).toContain('Project 99');
  });
});

describe('escapeXml', () => {
  it.each([
    ['escapes ampersand', 'a & b', 'a &amp; b'],
    ['escapes less-than', 'a < b', 'a &lt; b'],
    ['escapes greater-than', 'a > b', 'a &gt; b'],
    ['escapes double quotes', '"hello"', '&quot;hello&quot;'],
    ['escapes single quotes', "it's", 'it&apos;s'],
    ['returns the same string when there is nothing to escape', 'hello world', 'hello world'],
  ])('%s', (_name, input, expected) => {
    expect(escapeXml(input)).toBe(expected);
  });
});

describe('generateProjectSvg', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes an SVG file to the output directory', () => {
    const entries = [makeEntry({ language: { id: 'fr', name: 'French' }, translationProgress: 80, approvalProgress: 50 })];
    generateProjectSvg('MyProject', entries, SVG_TEST_OUT);
    expect(fs.mkdirSync).toHaveBeenCalledWith(SVG_TEST_OUT, { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalled();
    const [filePath, content] = fs.writeFileSync.mock.calls[0];
    expect(filePath).toContain('MyProject_graph.svg');
    expect(content).toContain('<svg');
    expect(content).toContain('</svg>');
  });

  it('replaces spaces in the project name with underscores in the filename', () => {
    generateProjectSvg('My Project Name', [], SVG_TEST_OUT);
    const [filePath] = fs.writeFileSync.mock.calls[0];
    expect(filePath).toContain('My_Project_Name_graph.svg');
  });

  it('uses "name (code)" as the label when the API provides a name', () => {
    const entries = [makeEntry({ language: { id: 'fr', name: 'French' }, translationProgress: 70, approvalProgress: 30 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).toContain('French');
    expect(content).toContain('(fr)');
  });

  it('uses only the code as the label when the API provides no name', () => {
    const entries = [makeEntry({ language: { id: 'xx' }, translationProgress: 50, approvalProgress: 10 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).toContain('>xx<');
    expect(content).not.toContain('(xx)');
  });

  it('scales SVG height by the number of entries', () => {
    const entries = [
      makeEntry({ language: { id: 'fr', name: 'French' } }),
      makeEntry({ language: { id: 'de', name: 'German' } }),
      makeEntry({ language: { id: 'es', name: 'Spanish' } }),
    ];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).toContain(`height="${entries.length * 32}"`);
  });

  it('renders a translation bar (blue) when translationProgress > 0 and approval < 100', () => {
    const entries = [makeEntry({ translationProgress: 60, approvalProgress: 20 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).toContain('#5D89C3');
  });

  it('renders an approval bar (green) when approvalProgress > 0', () => {
    const entries = [makeEntry({ translationProgress: 100, approvalProgress: 50 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).toContain('#71C277');
  });

  it('omits the translation bar when approvalProgress is 100', () => {
    const entries = [makeEntry({ translationProgress: 100, approvalProgress: 100 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).not.toContain('#5D89C3');
  });

  it('omits background track when translationProgress is 100', () => {
    const entries = [makeEntry({ translationProgress: 100, approvalProgress: 50 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).not.toContain('opacity="0.3"');
  });

  it('omits approval bar when approvalProgress is 0', () => {
    const entries = [makeEntry({ translationProgress: 50, approvalProgress: 0 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).not.toContain('#71C277');
  });

  it('generates an empty SVG body when entries is empty', () => {
    generateProjectSvg('Empty', [], SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).toContain('<svg');
    expect(content).toContain('</svg>');
    expect(content).not.toContain('<rect');
  });

  it('returns the path to the written file', () => {
    const result = generateProjectSvg('TestProj', [], SVG_TEST_OUT);
    expect(result).toContain('TestProj_graph.svg');
  });

  it('falls back to "?" when entry language id is absent', () => {
    const entries = [makeEntry({ language: {}, translationProgress: 50, approvalProgress: 10 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).toContain('>?<');
  });

  it('defaults translationProgress to 0 in SVG percentage label when absent', () => {
    const entries = [makeEntry({ translationProgress: undefined, approvalProgress: 0 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).toContain('>0%<');
  });

  it('handles null entry.language in SVG (falls back to empty object)', () => {
    const entries = [makeEntry({ language: null, translationProgress: 40, approvalProgress: 10 })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).toContain('>?<');
  });

  it('defaults approvalProgress to 0 in SVG when absent', () => {
    const entries = [makeEntry({ translationProgress: 50, approvalProgress: undefined })];
    generateProjectSvg('Proj', entries, SVG_TEST_OUT);
    const [, content] = fs.writeFileSync.mock.calls[0];
    expect(content).not.toContain('#71C277');
  });
});

describe('ensureProgressLabel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('calls createLabel with the correct name and color', async () => {
    mockCreateLabel.mockResolvedValue({});
    await ensureProgressLabel();
    expect(mockCreateLabel).toHaveBeenCalledWith(expect.objectContaining({
      name: PROGRESS_LABEL,
      color: PROGRESS_LABEL_COLOR,
    }));
  });

  it('silently ignores 422 (label already exists)', async () => {
    const err = new Error('Unprocessable Entity');
    err.status = 422;
    mockCreateLabel.mockRejectedValue(err);
    await expect(ensureProgressLabel()).resolves.toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('logs a warning for non-422 errors', async () => {
    const err = new Error('Server error');
    err.status = 500;
    mockCreateLabel.mockRejectedValue(err);
    await ensureProgressLabel();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(PROGRESS_LABEL));
  });
});

describe('findPinnedIssue', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the issue that contains the marker', async () => {
    const issue = makeGhIssue();
    mockPaginate.mockResolvedValue([issue]);
    const result = await findPinnedIssue();
    expect(result).toEqual(issue);
  });

  it('returns null when no issue contains the marker', async () => {
    mockPaginate.mockResolvedValue([
      { number: 1, state: 'open', title: 'Other', body: 'no marker here' },
    ]);
    const result = await findPinnedIssue();
    expect(result).toBeNull();
  });

  it('skips pull requests', async () => {
    mockPaginate.mockResolvedValue([
      { number: 2, state: 'open', body: PINNED_ISSUE_MARKER, pull_request: {} },
    ]);
    const result = await findPinnedIssue();
    expect(result).toBeNull();
  });

  it('returns null when there are no issues at all', async () => {
    mockPaginate.mockResolvedValue([]);
    expect(await findPinnedIssue()).toBeNull();
  });
});

describe('createPinnedIssue', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls octokit.rest.issues.create with the correct arguments', async () => {
    mockCreate.mockResolvedValue({ data: { number: 99 } });
    const result = await createPinnedIssue('body text');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: PINNED_ISSUE_TITLE,
      body: 'body text',
      labels: [PROGRESS_LABEL],
    }));
    expect(result.number).toBe(99);
  });
});

describe('updateIssue', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls octokit.rest.issues.update with the correct issue number and patch', async () => {
    mockUpdate.mockResolvedValue({ data: { number: 5 } });
    await updateIssue(5, { body: 'new body' });
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 5,
      body: 'new body',
    }));
  });
});

describe('upsertPinnedIssue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates a new issue when none exists', async () => {
    mockPaginate.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ data: { number: 10 } });
    await upsertPinnedIssue('new body');
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: PINNED_ISSUE_TITLE,
      body: 'new body',
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Created'));
  });

  it('updates body when existing issue has a different body', async () => {
    const existing = makeGhIssue({ body: 'old body\n' + PINNED_ISSUE_MARKER });
    mockPaginate.mockResolvedValue([existing]);
    mockUpdate.mockResolvedValue({ data: existing });
    await upsertPinnedIssue('new body\n' + PINNED_ISSUE_MARKER);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: existing.number,
      body: 'new body\n' + PINNED_ISSUE_MARKER,
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Updated'));
  });

  it('re-opens a closed pinned issue', async () => {
    const existing = makeGhIssue({ state: 'closed' });
    mockPaginate.mockResolvedValue([existing]);
    mockUpdate.mockResolvedValue({ data: { ...existing, state: 'open' } });
    await upsertPinnedIssue(existing.body);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: existing.number,
      state: 'open',
    }));
  });

  it('does nothing when issue is already up to date', async () => {
    const body = `content\n${PINNED_ISSUE_MARKER}`;
    const existing = makeGhIssue({ body });
    mockPaginate.mockResolvedValue([existing]);
    await upsertPinnedIssue(body);
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('up to date'));
  });

  it('updates title when it differs from PINNED_ISSUE_TITLE', async () => {
    const existing = makeGhIssue({ title: 'Old Title' });
    mockPaginate.mockResolvedValue([existing]);
    mockUpdate.mockResolvedValue({ data: existing });
    await upsertPinnedIssue(existing.body);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      title: PINNED_ISSUE_TITLE,
    }));
  });
});

describe('fetchProjects', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns unwrapped project data objects', async () => {
    const project = makeProject();
    mockListProjects.mockResolvedValue({ data: [{ data: project }] });
    const result = await fetchProjects();
    expect(result).toEqual([project]);
  });

  it('returns an empty array when the API returns no data', async () => {
    mockListProjects.mockResolvedValue({ data: [] });
    expect(await fetchProjects()).toEqual([]);
  });

  it('returns an empty array when data is null', async () => {
    mockListProjects.mockResolvedValue({ data: null });
    expect(await fetchProjects()).toEqual([]);
  });
});

describe('fetchProjectProgress', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns unwrapped progress entries', async () => {
    const entry = makeEntry();
    mockGetProjectProgress.mockResolvedValue({ data: [{ data: entry }] });
    const result = await fetchProjectProgress(42);
    expect(result).toEqual([entry]);
  });

  it('returns an empty array when the API returns no data', async () => {
    mockGetProjectProgress.mockResolvedValue({ data: [] });
    expect(await fetchProjectProgress(42)).toEqual([]);
  });

  it('returns an empty array when data is null', async () => {
    mockGetProjectProgress.mockResolvedValue({ data: null });
    expect(await fetchProjectProgress(42)).toEqual([]);
  });
});

describe('fetchAllProjectsProgress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns data for each project ID', async () => {
    const proj = makeProject({ id: 42 });
    mockListProjects.mockResolvedValue({ data: [{ data: proj }] });
    mockGetProjectProgress.mockResolvedValue({ data: [{ data: makeEntry() }] });

    const result = await fetchAllProjectsProgress(['42']);
    expect(result).toHaveLength(1);
    expect(result[0].project).toEqual(proj);
    expect(result[0].entries).toHaveLength(1);
  });

  it('uses a placeholder project when project ID is not in the list response', async () => {
    mockListProjects.mockResolvedValue({ data: [] });
    mockGetProjectProgress.mockResolvedValue({ data: [] });

    const result = await fetchAllProjectsProgress(['99']);
    expect(result[0].project).toMatchObject({ id: '99' });
  });

  it('logs the number of languages found per project', async () => {
    const proj = makeProject({ id: 1 });
    mockListProjects.mockResolvedValue({ data: [{ data: proj }] });
    mockGetProjectProgress.mockResolvedValue({
      data: [{ data: makeEntry() }, { data: makeEntry({ language: { id: 'de' } }) }],
    });

    await fetchAllProjectsProgress(['1']);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 language(s) found'));
  });
});

describe('generateAllSvgs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('calls generateProjectSvg for each project (via writeFileSync)', () => {
    const data = [
      { project: makeProject({ name: 'AlphaProject' }), entries: [] },
      { project: makeProject({ name: 'BetaProject' }), entries: [] },
    ];
    generateAllSvgs(data, SVG_OUT);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
  });

  it('logs the SVG path for each project', () => {
    generateAllSvgs([{ project: makeProject({ name: 'TestProj' }), entries: [] }], SVG_OUT);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('SVG written'));
  });

  it('falls back to "Project_<id>" filename when project name is absent', () => {
    generateAllSvgs([{ project: { id: 7 }, entries: [] }], SVG_OUT);
    const [filePath] = fs.writeFileSync.mock.calls[0];
    expect(filePath).toContain('Project_7_graph.svg');
  });
});

describe('main', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockCreateLabel.mockResolvedValue({});
    mockListProjects.mockResolvedValue({ data: [] });
    mockGetProjectProgress.mockResolvedValue({ data: [] });
    mockPaginate.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ data: { number: 1 } });
  });

  afterEach(() => jest.restoreAllMocks());

  it('completes successfully with no projects configured', async () => {
    await main();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sync complete'));
  });

  it('calls syncProject for each configured project ID', async () => {
    const origIds = process.env.CROWDIN_PROJECT_IDS;
    process.env.CROWDIN_PROJECT_IDS = '111,222';

    let freshMain;
    await jest.isolateModulesAsync(async () => {
      // Make parseCrowdinProjectIds return the expected IDs for this isolated load.
      const common = await import('../src/common.js');
      common.parseCrowdinProjectIds.mockReturnValue(['111', '222']);
      const mod = await import('../src/crowdin-progress.js');
      freshMain = mod.main;
    });

    mockListProjects.mockResolvedValue({ data: [] });
    mockGetProjectProgress.mockResolvedValue({ data: [] });
    mockPaginate.mockResolvedValue([]);
    mockCreate.mockResolvedValue({ data: { number: 1 } });

    await freshMain();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sync complete'));
    const hasProject111 = console.log.mock.calls
      .map((c) => c[0])
      .find((m) => typeof m === 'string' && m.includes('Project') && m.includes('111'));
    const hasProject222 = console.log.mock.calls
      .map((c) => c[0])
      .find((m) => typeof m === 'string' && m.includes('Project') && m.includes('222'));
    expect(Boolean(hasProject111)).toBe(true);
    expect(Boolean(hasProject222)).toBe(true);

    if (origIds === undefined) delete process.env.CROWDIN_PROJECT_IDS;
    else process.env.CROWDIN_PROJECT_IDS = origIds;
  });
});
