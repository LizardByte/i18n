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
//
// Strategy: create simple mocks in the factories. After the module under test
// has been imported (so its singletons are initialised), extract the specific
// jest.fn() instances from the constructed objects via the constructor's
// .mock.results.

jest.mock('../src/common.js', () => ({
  parseCrowdinProjectIds: jest.fn().mockReturnValue([]),
  validateEnv: jest.fn(),
}));

jest.mock('@crowdin/crowdin-api-client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    stringCommentsApi: {
      withFetchAll: jest.fn().mockReturnValue({
        listStringComments: jest.fn().mockResolvedValue({ data: [] }),
      }),
    },
    projectsGroupsApi: {
      getProject: jest.fn().mockResolvedValue({ data: { identifier: 'fake-project-slug' } }),
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
        addAssignees: jest.fn().mockResolvedValue({}),
        listForRepo: jest.fn(),
      },
    },
    paginate: jest.fn().mockResolvedValue([]),
  })),
}));

// Mock language-managers.json so tests never depend on real usernames.
jest.mock('../language-managers.json', () => ({
  // Single manager, github same as discord
  'xx': [{ discord: 'fake-discord', crowdin: 'fake-crowdin', github: 'fake-github' }],
  // Multiple managers
  'yy': [
    { discord: 'fake-discord-a', crowdin: 'fake-crowdin-a', github: 'fake-github-a' },
    { discord: 'fake-discord-b', crowdin: 'fake-crowdin-b', github: 'fake-github-b' },
  ],
  // Discord and crowdin differ from github
  'zz': [{ discord: 'fake-discord-c', crowdin: 'fake-crowdin-c', github: 'fake-github-c' }],
  // Manager with null github
  'ngh': [{ discord: 'fake-discord-ngh', crowdin: 'fake-crowdin-ngh', github: null }],
  // Hyphen-normalised variant (pt-BR style)
  'xx-BB': [{ discord: 'fake-discord-d', crowdin: 'fake-crowdin-d', github: 'fake-github-d' }],
  // No managers (Afar — used as the "no managers" test language)
  'aa': [],
}), { virtual: false });

// Import the mocked constructors so we can inspect .mock.results
import { Client as CrowdinClient } from '@crowdin/crowdin-api-client';
import { Octokit } from '@octokit/rest';

import {
  buildIssueTitle,
  buildIssueBody,
  buildIssueLabels,
  fetchCrowdinIssues,
  ensureLabel,
  ensureCrowdinLabel,
  ensureIssueLabels,
  loadExistingGithubIssues,
  createGithubIssue,
  addGithubAssignees,
  updateGithubIssue,
  syncProject,
  syncExistingIssue,
  createNewIssue,
  main,
  TYPE_MAP,
  MARKER_RE,
  CROWDIN_LABEL,
  LANG_LABEL_COLOR,
  TYPE_LABEL_COLOR,
  getLanguageManagers,
  getGithubAssignees,
  getTypeLabel,
  getLanguageLabels,
  fetchProjectSlug,
  projectSlugCache,
} from '../src/sync-crowdin-issues.js';

// Extract mock fn references from the singleton instances created at module
// load time (the first constructor call in .mock.results[0].value).

/** The Octokit instance that the module captured. */
const _octokitInst = Octokit.mock.results[0].value;
/** The CrowdinClient instance that the module captured. */
const _crowdinInst = CrowdinClient.mock.results[0].value;

// Crowdin mocks: withFetchAll returns a stable object; we override it here
// so every call returns the same listStringComments mock.
const mockListStringCommentsStable = jest.fn().mockResolvedValue({ data: [] });
const mockWithFetchAll = _crowdinInst.stringCommentsApi.withFetchAll;
mockWithFetchAll.mockReturnValue({ listStringComments: mockListStringCommentsStable });

const mockGetProject = _crowdinInst.projectsGroupsApi.getProject;

// Octokit mocks
const mockCreateLabel = _octokitInst.rest.issues.createLabel;
const mockCreate = _octokitInst.rest.issues.create;
const mockUpdate = _octokitInst.rest.issues.update;
const mockAddAssignees = _octokitInst.rest.issues.addAssignees;
const mockPaginate = _octokitInst.paginate;

// Helpers

/** Build a minimal Crowdin issue object. */
function makeCrowdinIssue(overrides = {}) {
  return {
    id: 1,
    issueType: 'source_mistake',
    issueStatus: 'unresolved',
    languageId: 'aa',
    text: 'Some issue text',
    user: { username: 'testuser', fullName: 'Test User' },
    createdAt: '2024-06-01T00:00:00Z',
    string: { text: 'Source string' },
    ...overrides,
  };
}

/** Build a minimal GitHub issue object. */
function makeGhIssue(overrides = {}) {
  return {
    number: 10,
    state: 'open',
    body: '<!-- crowdin-issue-id:42:1 -->',
    ...overrides,
  };
}

// TYPE_MAP

describe('TYPE_MAP', () => {
  it('contains expected keys', () => {
    expect(TYPE_MAP).toMatchObject({
      general_question: 'General Question',
      translation_mistake: 'Translation Mistake',
      context_request: 'Context Request',
      source_mistake: 'Source Mistake',
    });
  });
});

// CROWDIN_LABEL

describe('CROWDIN_LABEL', () => {
  it('is the string "crowdin"', () => {
    expect(CROWDIN_LABEL).toBe('crowdin');
  });
});

// MARKER_RE

describe('MARKER_RE', () => {
  it('matches a valid marker and captures project and issue IDs', () => {
    const marker = '<!-- crowdin-issue-id:12345:67890 -->';
    const m = MARKER_RE.exec(marker);
    expect(m).not.toBeNull();
    expect(m[1]).toBe('12345');
    expect(m[2]).toBe('67890');
  });

  it('does not match an invalid marker', () => {
    expect(MARKER_RE.exec('<!-- not-a-marker -->')).toBeNull();
    expect(MARKER_RE.exec('crowdin-issue-id:1:2')).toBeNull();
  });
});

// buildIssueTitle

describe('buildIssueTitle', () => {
  it('returns just the issue text (truncated to 72 chars)', () => {
    const issue = { text: 'Could it be better to use double quotes?' };
    expect(buildIssueTitle(issue)).toBe('Could it be better to use double quotes?');
  });

  it('truncates long text to 72 characters', () => {
    const issue = { text: 'a'.repeat(100) };
    expect(buildIssueTitle(issue).length).toBe(72);
  });

  it('collapses newlines to spaces', () => {
    const issue = { text: 'line one\nline two\r\nline three' };
    const title = buildIssueTitle(issue);
    expect(title).not.toMatch(/[\r\n]/);
    expect(title).toContain('line one line two line three');
  });

  it('returns an empty string when text is absent', () => {
    expect(buildIssueTitle({ text: undefined })).toBe('');
  });
});

// getTypeLabel

describe('getTypeLabel', () => {
  it('returns type:general-question for general_question', () => {
    expect(getTypeLabel('general_question')).toBe('type:general-question');
  });

  it('returns type:source-mistake for source_mistake', () => {
    expect(getTypeLabel('source_mistake')).toBe('type:source-mistake');
  });

  it('returns type:translation-mistake for translation_mistake', () => {
    expect(getTypeLabel('translation_mistake')).toBe('type:translation-mistake');
  });

  it('returns type:context-request for context_request', () => {
    expect(getTypeLabel('context_request')).toBe('type:context-request');
  });

  it('lowercases the type', () => {
    expect(getTypeLabel('SOME_TYPE')).toBe('type:some-type');
  });
});

// getLanguageLabels

describe('getLanguageLabels', () => {
  it('returns a single label for a simple language code', () => {
    expect(getLanguageLabels('fr')).toEqual(['lang:fr']);
  });

  it('returns two labels for a compound language code (hyphen)', () => {
    expect(getLanguageLabels('pt-BR')).toEqual(['lang:pt', 'lang:pt-BR']);
  });

  it('normalises underscore to hyphen and returns two labels', () => {
    expect(getLanguageLabels('pt_BR')).toEqual(['lang:pt', 'lang:pt-BR']);
  });

  it('returns an empty array when languageId is null', () => {
    expect(getLanguageLabels(null)).toEqual([]);
  });

  it('returns an empty array when languageId is undefined', () => {
    expect(getLanguageLabels(undefined)).toEqual([]);
  });
});

// buildIssueLabels

describe('buildIssueLabels', () => {
  it('includes the crowdin base label, type label, and language label', () => {
    const issue = { issueType: 'general_question', languageId: 'fr' };
    expect(buildIssueLabels(issue)).toEqual(['crowdin', 'type:general-question', 'lang:fr']);
  });

  it('includes both base and compound language labels for pt-BR', () => {
    const issue = { issueType: 'source_mistake', languageId: 'pt-BR' };
    expect(buildIssueLabels(issue)).toEqual([
      'crowdin',
      'type:source-mistake',
      'lang:pt',
      'lang:pt-BR',
    ]);
  });

  it('omits language labels when languageId is absent', () => {
    const issue = { issueType: 'context_request', languageId: null };
    expect(buildIssueLabels(issue)).toEqual(['crowdin', 'type:context-request']);
  });
});

// ensureLabel

describe('ensureLabel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('calls createLabel with the correct args and logs on success', async () => {
    mockCreateLabel.mockResolvedValue({});
    await ensureLabel('lang:fr', LANG_LABEL_COLOR, 'Language: fr');
    expect(mockCreateLabel).toHaveBeenCalledWith(expect.objectContaining({
      name: 'lang:fr',
      color: LANG_LABEL_COLOR,
      description: 'Language: fr',
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('lang:fr'));
  });

  it('silently ignores 422 (label already exists)', async () => {
    const err = new Error('Unprocessable Entity');
    err.status = 422;
    mockCreateLabel.mockRejectedValue(err);
    await expect(ensureLabel('lang:fr', LANG_LABEL_COLOR, '')).resolves.toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('logs a warning for non-422 errors', async () => {
    const err = new Error('Server error');
    err.status = 500;
    mockCreateLabel.mockRejectedValue(err);
    await ensureLabel('lang:fr', LANG_LABEL_COLOR, '');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('lang:fr'));
  });
});

// ensureCrowdinLabel

describe('ensureCrowdinLabel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates the crowdin label with the correct name', async () => {
    mockCreateLabel.mockResolvedValue({});
    await ensureCrowdinLabel();
    expect(mockCreateLabel).toHaveBeenCalledWith(expect.objectContaining({
      name: CROWDIN_LABEL,
    }));
  });

  it('silently ignores 422 (label already exists)', async () => {
    const err = new Error('Unprocessable Entity');
    err.status = 422;
    mockCreateLabel.mockRejectedValue(err);
    await expect(ensureCrowdinLabel()).resolves.toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('logs a warning for non-422 errors', async () => {
    const err = new Error('Server error');
    err.status = 500;
    mockCreateLabel.mockRejectedValue(err);
    await ensureCrowdinLabel();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not create label'));
  });
});

// ensureIssueLabels

describe('ensureIssueLabels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockCreateLabel.mockResolvedValue({});
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates the type label and one language label for a simple language', async () => {
    await ensureIssueLabels({ issueType: 'source_mistake', languageId: 'fr' });
    const names = mockCreateLabel.mock.calls.map((c) => c[0].name);
    expect(names).toContain('type:source-mistake');
    expect(names).toContain('lang:fr');
  });

  it('creates two language labels for a compound language (pt-BR)', async () => {
    await ensureIssueLabels({ issueType: 'general_question', languageId: 'pt-BR' });
    const names = mockCreateLabel.mock.calls.map((c) => c[0].name);
    expect(names).toContain('lang:pt');
    expect(names).toContain('lang:pt-BR');
  });

  it('uses TYPE_LABEL_COLOR for the type label', async () => {
    await ensureIssueLabels({ issueType: 'source_mistake', languageId: 'fr' });
    const typeCall = mockCreateLabel.mock.calls.find((c) => c[0].name === 'type:source-mistake');
    expect(typeCall[0].color).toBe(TYPE_LABEL_COLOR);
  });

  it('uses LANG_LABEL_COLOR for language labels', async () => {
    await ensureIssueLabels({ issueType: 'source_mistake', languageId: 'fr' });
    const langCall = mockCreateLabel.mock.calls.find((c) => c[0].name === 'lang:fr');
    expect(langCall[0].color).toBe(LANG_LABEL_COLOR);
  });

  it('skips language label creation when languageId is absent', async () => {
    await ensureIssueLabels({ issueType: 'general_question', languageId: null });
    const names = mockCreateLabel.mock.calls.map((c) => c[0].name);
    expect(names.every((n) => !n.startsWith('lang:'))).toBe(true);
  });

  it('uses the raw issueType as description when not in TYPE_MAP', async () => {
    await ensureIssueLabels({ issueType: 'unknown_type', languageId: null });
    const typeCall = mockCreateLabel.mock.calls.find((c) => c[0].name === 'type:unknown-type');
    expect(typeCall[0].description).toBe('unknown_type');
  });
});

// getLanguageManagers

describe('getLanguageManagers', () => {
  it('returns managers for a known single-manager language', () => {
    const managers = getLanguageManagers('xx');
    expect(managers).toHaveLength(1);
    expect(managers[0]).toMatchObject({ discord: 'fake-discord', crowdin: 'fake-crowdin', github: 'fake-github' });
  });

  it('returns multiple managers for a language with multiple managers', () => {
    const managers = getLanguageManagers('yy');
    expect(managers).toHaveLength(2);
    expect(managers.map((m) => m.discord)).toContain('fake-discord-a');
    expect(managers.map((m) => m.discord)).toContain('fake-discord-b');
  });

  it('returns a manager entry with a null github field', () => {
    const managers = getLanguageManagers('ngh');
    expect(managers).toHaveLength(1);
    expect(managers[0].github).toBeNull();
  });

  it('normalises underscore separators (e.g. xx_BB → xx-BB)', () => {
    const withHyphen = getLanguageManagers('xx-BB');
    const withUnderscore = getLanguageManagers('xx_BB');
    expect(withHyphen).toEqual(withUnderscore);
    expect(withHyphen).toHaveLength(1);
  });

  it('returns an empty array for a language with no managers (Afar)', () => {
    expect(getLanguageManagers('aa')).toEqual([]);
  });

  it('returns an empty array for an unknown language', () => {
    expect(getLanguageManagers('zz-unknown')).toEqual([]);
  });

  it('returns an empty array when languageId is null or undefined', () => {
    expect(getLanguageManagers(null)).toEqual([]);
    expect(getLanguageManagers(undefined)).toEqual([]);
  });
});

// getGithubAssignees

describe('getGithubAssignees', () => {
  it('returns github usernames for managers with non-null github', () => {
    expect(getGithubAssignees('xx')).toEqual(['fake-github']);
  });

  it('returns multiple usernames for a language with multiple managers', () => {
    expect(getGithubAssignees('yy')).toEqual(['fake-github-a', 'fake-github-b']);
  });

  it('omits managers where github is null', () => {
    expect(getGithubAssignees('ngh')).toEqual([]);
  });

  it('returns an empty array for a language with no managers', () => {
    expect(getGithubAssignees('aa')).toEqual([]);
  });

  it('returns an empty array for an unknown language', () => {
    expect(getGithubAssignees('zz-unknown')).toEqual([]);
  });

  it('returns an empty array when languageId is null or undefined', () => {
    expect(getGithubAssignees(null)).toEqual([]);
    expect(getGithubAssignees(undefined)).toEqual([]);
  });
});

// buildIssueBody

describe('buildIssueBody', () => {
  const projectId = '9876';

  // Use 'aa' (Afar — a fake/no-managers test language) as the base so
  // manager-unrelated tests remain isolated from the managers section.
  const baseIssue = {
    id: 42,
    issueType: 'source_mistake',
    issueStatus: 'unresolved',
    languageId: 'aa',
    user: { username: 'testuser', fullName: 'Test User' },
    createdAt: '2024-01-15T10:30:00Z',
    text: 'This source text has a mistake.',
    string: { text: 'Original source string here' },
  };

  it('embeds the deduplication marker', () => {
    const body = buildIssueBody(baseIssue, projectId);
    const m = MARKER_RE.exec(body);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(projectId);
    expect(m[2]).toBe(String(baseIssue.id));
  });

  it('includes issue type label', () => {
    expect(buildIssueBody(baseIssue, projectId)).toContain('Source Mistake');
  });

  it('falls back to raw issueType when not in TYPE_MAP', () => {
    const body = buildIssueBody({ ...baseIssue, issueType: 'unknown_type' }, projectId);
    expect(body).toContain('unknown_type');
  });

  it('does not include a Status field', () => {
    expect(buildIssueBody(baseIssue, projectId)).not.toContain('**Status**');
  });

  it('renders a username as a Crowdin profile link', () => {
    expect(buildIssueBody(baseIssue, projectId)).toContain('[@testuser](https://crowdin.com/profile/testuser)');
  });

  it('falls back to fullName when username is absent', () => {
    const body = buildIssueBody({ ...baseIssue, user: { fullName: 'Test Fullname' } }, projectId);
    expect(body).toContain('Test Fullname');
    // The reporter row should not contain a @ mention (no Crowdin profile link).
    const reporterRow = body.split('\n').find((l) => l.includes('**Reporter**'));
    expect(reporterRow).not.toContain('@');
  });

  it('shows — when user is absent', () => {
    const body = buildIssueBody({ ...baseIssue, user: undefined }, projectId);
    expect(body).toContain('| **Reporter** | — |');
  });

  it('renders the source string in a code fence', () => {
    expect(buildIssueBody(baseIssue, projectId)).toContain('```\nOriginal source string here\n```');
  });

  it('shows unavailable when string.text is absent', () => {
    expect(buildIssueBody({ ...baseIssue, string: undefined }, projectId)).toContain('_(unavailable)_');
  });

  it('omits the View on Crowdin link when no slug is given', () => {
    expect(buildIssueBody(baseIssue, projectId)).not.toContain('View on Crowdin');
  });

  it('links to the project page using the slug when slug is given but string.id is absent', () => {
    const issue = { ...baseIssue, string: undefined };
    const body = buildIssueBody(issue, projectId, 'my-project');
    expect(body).toContain('https://crowdin.com/project/my-project');
  });

  it('links directly to the string in the editor when slug, file.id and string.id are present', () => {
    const issue = { ...baseIssue, languageId: 'fr', string: { text: 'Source', id: 999, fileId: 5842 } };
    const body = buildIssueBody(issue, projectId, 'my-project');
    expect(body).toContain('https://crowdin.com/editor/my-project/5842/en-fr?view=comfortable#999');
  });

  it('links directly to the editor with a compound language code normalized (zh-CN → en-zhcn)', () => {
    const issue = { ...baseIssue, languageId: 'zh-CN', string: { text: 'Source', id: 91860, fileId: 5842 } };
    const body = buildIssueBody(issue, projectId, 'my-project');
    expect(body).toContain('https://crowdin.com/editor/my-project/5842/en-zhcn?view=comfortable#91860');
  });

  it('falls back to project page when fileId is absent', () => {
    const issue = { ...baseIssue, languageId: 'fr', string: { text: 'Source', id: 999 } };
    const body = buildIssueBody(issue, projectId, 'my-project');
    expect(body).toContain('https://crowdin.com/project/my-project');
    expect(body).not.toContain('/editor/');
  });

  it('includes the File row when string.file.path is present', () => {
    const issue = { ...baseIssue, string: { text: 'Source', file: { path: '/src/strings.json' } } };
    expect(buildIssueBody(issue, projectId)).toContain('| **File** | `/src/strings.json` |');
  });

  it('includes the File row from string.filePath when string.file.path is absent', () => {
    const issue = { ...baseIssue, string: { text: 'Source', filePath: '/fallback/path.json' } };
    expect(buildIssueBody(issue, projectId)).toContain('| **File** | `/fallback/path.json` |');
  });

  it('includes the String ID row when string.identifier is present', () => {
    const issue = { ...baseIssue, string: { text: 'Source', identifier: 'menu.title' } };
    expect(buildIssueBody(issue, projectId)).toContain('| **String ID** | `menu.title` |');
  });

  it('omits the File row when file info is absent', () => {
    expect(buildIssueBody(baseIssue, projectId)).not.toContain('**File**');
  });

  it('omits the String ID row when identifier is absent', () => {
    expect(buildIssueBody(baseIssue, projectId)).not.toContain('**String ID**');
  });

  it('renders the issue description', () => {
    expect(buildIssueBody(baseIssue, projectId)).toContain('This source text has a mistake.');
  });

  it('shows default description when text is missing', () => {
    expect(buildIssueBody({ ...baseIssue, text: undefined }, projectId)).toContain('_(no description provided)_');
  });

  it('shows — for created date when createdAt is absent', () => {
    expect(buildIssueBody({ ...baseIssue, createdAt: undefined }, projectId)).toContain('| **Created** | — |');
  });

  it('shows — for language when languageId is absent', () => {
    expect(buildIssueBody({ ...baseIssue, languageId: undefined }, projectId)).toContain('| **Language** | — |');
  });

  it('places the marker as the last line', () => {
    const body = buildIssueBody(baseIssue, projectId);
    const lines = body.split('\n');
    expect(MARKER_RE.test(lines.at(-1))).toBe(true);
  });

  it('includes the Crowdin ID in the table', () => {
    expect(buildIssueBody(baseIssue, projectId)).toContain(`| **Crowdin ID** | ${baseIssue.id} |`);
  });

  it('includes a Language Managers section with GitHub mention when managers exist', () => {
    const body = buildIssueBody({ ...baseIssue, languageId: 'xx' }, projectId);
    expect(body).toContain('### Language Managers');
    expect(body).toContain('@fake-github');
    expect(body).toContain('https://crowdin.com/profile/fake-crowdin');
    // Marker must still be the last line even when the managers section is present
    expect(MARKER_RE.test(body.split('\n').at(-1))).toBe(true);
  });

  it('includes multiple GitHub mentions for a language with multiple managers', () => {
    const body = buildIssueBody({ ...baseIssue, languageId: 'yy' }, projectId);
    expect(body).toContain('@fake-github-a');
    expect(body).toContain('@fake-github-b');
  });

  it('shows discord name instead of @ mention when github is null', () => {
    const body = buildIssueBody({ ...baseIssue, languageId: 'ngh' }, projectId);
    expect(body).toContain('### Language Managers');
    // Should show the discord name, not @null
    expect(body).toContain('fake-discord-ngh');
    expect(body).not.toContain('@null');
  });

  it('omits Language Managers section when language has no managers', () => {
    const body = buildIssueBody({ ...baseIssue, languageId: 'aa' }, projectId);
    expect(body).not.toContain('### Language Managers');
  });

  it('omits Language Managers section when languageId is absent', () => {
    const body = buildIssueBody({ ...baseIssue, languageId: undefined }, projectId);
    expect(body).not.toContain('### Language Managers');
  });
});

// fetchProjectSlug

describe('fetchProjectSlug', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    projectSlugCache.clear();
  });

  it('calls getProject with the project ID and returns the identifier', async () => {
    mockGetProject.mockResolvedValue({ data: { identifier: 'my-project' } });
    const slug = await fetchProjectSlug('123');
    expect(slug).toBe('my-project');
    expect(mockGetProject).toHaveBeenCalledWith('123');
  });

  it('caches the result and only calls getProject once per project', async () => {
    mockGetProject.mockResolvedValue({ data: { identifier: 'cached-project' } });
    await fetchProjectSlug('42');
    await fetchProjectSlug('42');
    expect(mockGetProject).toHaveBeenCalledTimes(1);
  });

  it('fetches independently for different project IDs', async () => {
    mockGetProject
      .mockResolvedValueOnce({ data: { identifier: 'project-a' } })
      .mockResolvedValueOnce({ data: { identifier: 'project-b' } });
    const a = await fetchProjectSlug('1');
    const b = await fetchProjectSlug('2');
    expect(a).toBe('project-a');
    expect(b).toBe('project-b');
    expect(mockGetProject).toHaveBeenCalledTimes(2);
  });
});

// fetchCrowdinIssues

describe('fetchCrowdinIssues', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns unwrapped issue data objects', async () => {
    const raw = [
      { data: makeCrowdinIssue({ id: 1 }) },
      { data: makeCrowdinIssue({ id: 2 }) },
    ];
    mockListStringCommentsStable.mockResolvedValue({ data: raw });

    const result = await fetchCrowdinIssues('123');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[1].id).toBe(2);
  });

  it('returns an empty array when response.data is null/undefined', async () => {
    mockListStringCommentsStable.mockResolvedValue({});
    const result = await fetchCrowdinIssues('999');
    expect(result).toEqual([]);
  });

  it('calls withFetchAll and listStringComments with correct args', async () => {
    mockListStringCommentsStable.mockResolvedValue({ data: [] });
    await fetchCrowdinIssues('777');
    expect(mockWithFetchAll).toHaveBeenCalled();
    expect(mockListStringCommentsStable).toHaveBeenCalledWith('777', { type: 'issue' });
  });
});

// createGithubIssue

describe('createGithubIssue', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the created issue data', async () => {
    mockCreate.mockResolvedValue({ data: { number: 99, state: 'open' } });
    const labels = ['crowdin', 'type:source-mistake', 'lang:fr'];
    const result = await createGithubIssue('Test Title', 'Test Body', labels);
    expect(result.number).toBe(99);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Test Title',
      body: 'Test Body',
      labels,
    }));
  });

  it('does not pass assignees in the create call', async () => {
    mockCreate.mockResolvedValue({ data: { number: 99, state: 'open' } });
    await createGithubIssue('Title', 'Body', [CROWDIN_LABEL]);
    const call = mockCreate.mock.calls[0][0];
    expect(call).not.toHaveProperty('assignees');
  });
});

describe('loadExistingGithubIssues', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns an empty map when no issues exist', async () => {
    mockPaginate.mockResolvedValue([]);
    const map = await loadExistingGithubIssues();
    expect(map.size).toBe(0);
  });

  it('populates the map from matching issues', async () => {
    mockPaginate.mockResolvedValue([
      makeGhIssue({ body: '<!-- crowdin-issue-id:42:10 -->' }),
      makeGhIssue({ number: 11, body: '<!-- crowdin-issue-id:42:20 -->' }),
    ]);
    const map = await loadExistingGithubIssues();
    expect(map.size).toBe(2);
    expect(map.has('42:10')).toBe(true);
    expect(map.has('42:20')).toBe(true);
  });

  it('skips issues without a matching marker', async () => {
    mockPaginate.mockResolvedValue([makeGhIssue({ body: 'no marker here' })]);
    const map = await loadExistingGithubIssues();
    expect(map.size).toBe(0);
  });

  it('skips pull requests', async () => {
    mockPaginate.mockResolvedValue([
      makeGhIssue({ body: '<!-- crowdin-issue-id:1:2 -->', pull_request: {} }),
    ]);
    const map = await loadExistingGithubIssues();
    expect(map.size).toBe(0);
  });

  it('skips issues with a null body', async () => {
    mockPaginate.mockResolvedValue([makeGhIssue({ body: null })]);
    const map = await loadExistingGithubIssues();
    expect(map.size).toBe(0);
  });
});

// addGithubAssignees

describe('addGithubAssignees', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls addAssignees with the provided usernames', async () => {
    await addGithubAssignees(10, ['user-a', 'user-b']);
    expect(mockAddAssignees).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 10,
      assignees: ['user-a', 'user-b'],
    }));
  });

  it('does not call addAssignees when the list is empty', async () => {
    await addGithubAssignees(10, []);
    expect(mockAddAssignees).not.toHaveBeenCalled();
  });
});

// syncExistingIssue

describe('syncExistingIssue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    projectSlugCache.clear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const SLUG = 'fake-slug';

  /** Build a GH issue that is fully in sync with the given Crowdin issue. */
  function makeInSyncGhIssue(crowdinIssue, projectId, overrides = {}) {
    return makeGhIssue({
      title: buildIssueTitle(crowdinIssue),
      body: buildIssueBody(crowdinIssue, projectId, SLUG),
      labels: buildIssueLabels(crowdinIssue).map((name) => ({ name })),
      ...overrides,
    });
  }

  it('closes an open GH issue when Crowdin issue is resolved', async () => {
    const issue = makeCrowdinIssue({ id: 1, issueStatus: 'resolved' });
    const ghIssue = makeInSyncGhIssue(issue, '42', { state: 'open' });
    mockUpdate.mockResolvedValue({ data: {} });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      state: 'closed',
      state_reason: 'completed',
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Closed'));
  });

  it('reopens a closed GH issue when Crowdin issue is re-opened', async () => {
    const issue = makeCrowdinIssue({ id: 2, issueStatus: 'unresolved' });
    const ghIssue = makeInSyncGhIssue(issue, '42', { state: 'closed' });
    mockUpdate.mockResolvedValue({ data: {} });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ state: 'open' }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Reopened'));
  });

  it('updates when body is stale', async () => {
    const issue = makeCrowdinIssue({ id: 3, issueStatus: 'unresolved' });
    const ghIssue = makeInSyncGhIssue(issue, '42', { body: 'stale body' });
    mockUpdate.mockResolvedValue({ data: {} });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      body: buildIssueBody(issue, '42', SLUG),
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Updated'));
  });

  it('updates when title is stale', async () => {
    const issue = makeCrowdinIssue({ id: 4, issueStatus: 'unresolved' });
    const ghIssue = makeInSyncGhIssue(issue, '42', { title: 'Old title' });
    mockUpdate.mockResolvedValue({ data: {} });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      title: buildIssueTitle(issue),
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Updated'));
  });

  it('updates when labels are stale', async () => {
    const issue = makeCrowdinIssue({ id: 5, issueStatus: 'unresolved' });
    const ghIssue = makeInSyncGhIssue(issue, '42', { labels: [{ name: 'crowdin' }] });
    mockUpdate.mockResolvedValue({ data: {} });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      labels: buildIssueLabels(issue),
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Updated'));
  });

  it('includes stale title+body+labels in the close call', async () => {
    const issue = makeCrowdinIssue({ id: 6, issueStatus: 'resolved' });
    const ghIssue = makeGhIssue({ number: 13, state: 'open', title: 'Old', body: 'stale', labels: [] });
    mockUpdate.mockResolvedValue({ data: {} });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      state: 'closed',
      title: buildIssueTitle(issue),
      body: buildIssueBody(issue, '42', SLUG),
      labels: buildIssueLabels(issue),
    }));
  });

  it('includes stale fields in the reopen call', async () => {
    const issue = makeCrowdinIssue({ id: 7, issueStatus: 'unresolved' });
    const ghIssue = makeGhIssue({ number: 14, state: 'closed', title: 'Old', body: 'stale', labels: [] });
    mockUpdate.mockResolvedValue({ data: {} });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      state: 'open',
      title: buildIssueTitle(issue),
      body: buildIssueBody(issue, '42', SLUG),
    }));
  });

  it('logs "in sync" and makes no API call when title, body, and labels all match', async () => {
    const issue = makeCrowdinIssue({ id: 8, issueStatus: 'unresolved' });
    const ghIssue = makeInSyncGhIssue(issue, '42', { state: 'open' });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('In sync'));
  });

  it('logs "in sync" and makes no API call when GH is closed and Crowdin is resolved', async () => {
    const issue = makeCrowdinIssue({ id: 9, issueStatus: 'resolved' });
    const ghIssue = makeInSyncGhIssue(issue, '42', { state: 'closed' });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('In sync'));
  });

  it('recognises labels supplied as plain strings (not objects)', async () => {
    const issue = makeCrowdinIssue({ id: 11, issueStatus: 'unresolved' });
    const ghIssue = makeInSyncGhIssue(issue, '42', {
      state: 'open',
      labels: buildIssueLabels(issue), // plain strings
    });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('In sync'));
  });

  it('skips even stale body when GH is already closed and Crowdin is resolved', async () => {
    const issue = makeCrowdinIssue({ id: 10, issueStatus: 'resolved' });
    const ghIssue = makeGhIssue({ number: 17, state: 'closed', body: 'stale body' });

    await syncExistingIssue(ghIssue, issue, '42', SLUG);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('In sync'));
  });
});

// createNewIssue

describe('createNewIssue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    projectSlugCache.clear();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const SLUG = 'fake-slug';

  it('creates a GH issue with correct labels and adds it to the map', async () => {
    const issue = makeCrowdinIssue({ id: 1, issueStatus: 'unresolved' });
    mockCreate.mockResolvedValue({ data: { number: 50, state: 'open' } });

    const map = new Map();
    await createNewIssue(issue, '42', SLUG, map, '42:1');

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      labels: buildIssueLabels(issue),
    }));
    expect(map.has('42:1')).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Created'));
  });

  it('passes assignees via addAssignees after creation', async () => {
    const issue = makeCrowdinIssue({ id: 2, issueStatus: 'unresolved', languageId: 'xx' });
    mockCreate.mockResolvedValue({ data: { number: 51, state: 'open' } });

    await createNewIssue(issue, '42', SLUG, new Map(), '42:2');

    expect(mockAddAssignees).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 51,
      assignees: ['fake-github'],
    }));
    expect(mockCreate).not.toHaveBeenCalledWith(expect.objectContaining({ assignees: expect.anything() }));
  });

  it('does not call addAssignees when no managers have a github username', async () => {
    const issue = makeCrowdinIssue({ id: 3, issueStatus: 'unresolved', languageId: 'ngh' });
    mockCreate.mockResolvedValue({ data: { number: 52, state: 'open' } });

    await createNewIssue(issue, '42', SLUG, new Map(), '42:3');

    expect(mockAddAssignees).not.toHaveBeenCalled();
  });

  it('immediately closes the issue when the Crowdin issue is already resolved', async () => {
    const issue = makeCrowdinIssue({ id: 4, issueStatus: 'resolved' });
    mockCreate.mockResolvedValue({ data: { number: 53, state: 'open' } });
    mockUpdate.mockResolvedValue({ data: { number: 53, state: 'closed' } });

    await createNewIssue(issue, '42', SLUG, new Map(), '42:4');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 53,
      state: 'closed',
      state_reason: 'completed',
    }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('resolved (on create)'));
  });

  it('does not close the issue when the Crowdin issue is unresolved', async () => {
    const issue = makeCrowdinIssue({ id: 5, issueStatus: 'unresolved' });
    mockCreate.mockResolvedValue({ data: { number: 54, state: 'open' } });

    await createNewIssue(issue, '42', SLUG, new Map(), '42:5');

    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// syncProject

/** Helper: run syncProject and advance fake timers so setTimeout resolves. */
async function runSync(projectId, existingMap) {
  const p = syncProject(projectId, existingMap);
  await jest.runAllTimersAsync();
  return p;
}

describe('syncProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    projectSlugCache.clear();
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });


  it('creates a new GH issue for an unresolved Crowdin issue not in the map', async () => {
    const issue = makeCrowdinIssue({ id: 5, issueStatus: 'unresolved' });
    mockListStringCommentsStable.mockResolvedValue({ data: [{ data: issue }] });
    mockCreate.mockResolvedValue({ data: { number: 20, state: 'open' } });

    const map = new Map();
    await runSync('42', map);

    expect(mockCreate).toHaveBeenCalled();
    expect(map.has('42:5')).toBe(true);
  });

  it('creates and immediately closes a GH issue for an already-resolved Crowdin issue', async () => {
    const issue = makeCrowdinIssue({ id: 6, issueStatus: 'resolved' });
    mockListStringCommentsStable.mockResolvedValue({ data: [{ data: issue }] });
    mockCreate.mockResolvedValue({ data: { number: 21, state: 'open' } });
    mockUpdate.mockResolvedValue({ data: { number: 21, state: 'closed' } });

    const map = new Map();
    await runSync('42', map);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      state: 'closed',
      state_reason: 'completed',
    }));
    expect(map.has('42:6')).toBe(true);
  });

  it('delegates to syncExistingIssue for an issue already in the map', async () => {
    const issue = makeCrowdinIssue({ id: 7, issueStatus: 'resolved' });
    mockListStringCommentsStable.mockResolvedValue({ data: [{ data: issue }] });
    mockUpdate.mockResolvedValue({ data: { number: 10, state: 'closed' } });

    const ghIssue = makeGhIssue({ number: 10, state: 'open' });
    const map = new Map([['42:7', ghIssue]]);
    await runSync('42', map);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      state: 'closed',
      state_reason: 'completed',
    }));
  });
});

// updateGithubIssue

describe('updateGithubIssue', () => {
  beforeEach(() => jest.clearAllMocks());

  it('calls octokit update with the correct args and returns data', async () => {
    mockUpdate.mockResolvedValue({ data: { number: 5, state: 'closed' } });
    const result = await updateGithubIssue(5, { state: 'closed' });
    expect(result.state).toBe('closed');
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 5,
      state: 'closed',
    }));
  });
});

// main

describe('main', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    projectSlugCache.clear();
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('completes successfully with no projects configured', async () => {
    mockCreateLabel.mockResolvedValue({});
    mockPaginate.mockResolvedValue([]);

    const p = main();
    await jest.runAllTimersAsync();
    await p;

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sync complete'));
  });

  it('calls syncProject for each project ID when projects are configured', async () => {
    const origProjectIds = process.env.CROWDIN_PROJECT_IDS;
    process.env.CROWDIN_PROJECT_IDS = '999';

    let freshMain;
    await jest.isolateModulesAsync(async () => {
      const common = await import('../src/common.js');
      common.parseCrowdinProjectIds.mockReturnValue(['999']);
      const mod = await import('../src/sync-crowdin-issues.js');
      freshMain = mod.main;
    });

    const p = freshMain();
    await jest.runAllTimersAsync();
    await p;

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sync complete'));

    if (origProjectIds === undefined) delete process.env.CROWDIN_PROJECT_IDS;
    else process.env.CROWDIN_PROJECT_IDS = origProjectIds;
  });
});
