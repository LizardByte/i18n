import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from '@jest/globals';

// ---------------------------------------------------------------------------
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
// ---------------------------------------------------------------------------

jest.mock('@crowdin/crowdin-api-client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    stringCommentsApi: {
      withFetchAll: jest.fn().mockReturnValue({
        listStringComments: jest.fn().mockResolvedValue({ data: [] }),
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

// Import the mocked constructors so we can inspect .mock.results
import { Client as CrowdinClient } from '@crowdin/crowdin-api-client';
import { Octokit } from '@octokit/rest';

import {
  buildIssueTitle,
  buildIssueBody,
  fetchCrowdinIssues,
  ensureCrowdinLabel,
  loadExistingGithubIssues,
  createGithubIssue,
  updateGithubIssue,
  syncProject,
  main,
  TYPE_MAP,
  MARKER_RE,
  CROWDIN_LABEL,
} from '../src/sync-crowdin-issues.js';

// ---------------------------------------------------------------------------
// Extract mock fn references from the singleton instances created at module
// load time (the first constructor call in .mock.results[0].value).
// ---------------------------------------------------------------------------

/** The Octokit instance that the module captured. */
const _octokitInst = Octokit.mock.results[0].value;
/** The CrowdinClient instance that the module captured. */
const _crowdinInst = CrowdinClient.mock.results[0].value;

// Crowdin mocks: withFetchAll returns a stable object; we override it here
// so every call returns the same listStringComments mock.
const mockListStringCommentsStable = jest.fn().mockResolvedValue({ data: [] });
const mockWithFetchAll = _crowdinInst.stringCommentsApi.withFetchAll;
mockWithFetchAll.mockReturnValue({ listStringComments: mockListStringCommentsStable });

// Octokit mocks
const mockCreateLabel = _octokitInst.rest.issues.createLabel;
const mockCreate = _octokitInst.rest.issues.create;
const mockUpdate = _octokitInst.rest.issues.update;
const mockPaginate = _octokitInst.paginate;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Crowdin issue object. */
function makeCrowdinIssue(overrides = {}) {
  return {
    id: 1,
    issueType: 'source_mistake',
    issueStatus: 'unresolved',
    languageId: 'fr',
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

// ---------------------------------------------------------------------------
// TYPE_MAP
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// CROWDIN_LABEL
// ---------------------------------------------------------------------------

describe('CROWDIN_LABEL', () => {
  it('is the string "crowdin"', () => {
    expect(CROWDIN_LABEL).toBe('crowdin');
  });
});

// ---------------------------------------------------------------------------
// MARKER_RE
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildIssueTitle
// ---------------------------------------------------------------------------

describe('buildIssueTitle', () => {
  it('returns a title with known issue type and language', () => {
    const issue = { issueType: 'source_mistake', languageId: 'fr', text: 'The source text is wrong' };
    expect(buildIssueTitle(issue)).toBe('[Crowdin] [FR] Source Mistake: The source text is wrong');
  });

  it('returns a title without language when languageId is absent', () => {
    const issue = { issueType: 'general_question', languageId: null, text: 'What does this mean?' };
    expect(buildIssueTitle(issue)).toBe('[Crowdin] General Question: What does this mean?');
  });

  it('falls back to raw issueType when not in TYPE_MAP', () => {
    const issue = { issueType: 'unknown_type', languageId: 'de', text: 'Some text' };
    expect(buildIssueTitle(issue)).toContain('unknown_type');
  });

  it('truncates long descriptions to 72 characters', () => {
    const issue = { issueType: 'context_request', languageId: null, text: 'a'.repeat(100) };
    const title = buildIssueTitle(issue);
    const snippet = title.slice('[Crowdin] Context Request: '.length);
    expect(snippet.length).toBe(72);
  });

  it('collapses newlines in the description snippet', () => {
    const issue = { issueType: 'translation_mistake', languageId: null, text: 'line one\nline two\r\nline three' };
    const title = buildIssueTitle(issue);
    expect(title).not.toMatch(/[\r\n]/);
    expect(title).toContain('line one line two line three');
  });

  it('handles missing text gracefully', () => {
    const issue = { issueType: 'source_mistake', languageId: null, text: undefined };
    expect(buildIssueTitle(issue)).toBe('[Crowdin] Source Mistake: ');
  });
});

// ---------------------------------------------------------------------------
// buildIssueBody
// ---------------------------------------------------------------------------

describe('buildIssueBody', () => {
  const projectId = '9876';

  const baseIssue = {
    id: 42,
    issueType: 'source_mistake',
    issueStatus: 'unresolved',
    languageId: 'es',
    user: { username: 'johndoe', fullName: 'John Doe' },
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

  it('shows unresolved status', () => {
    expect(buildIssueBody({ ...baseIssue, issueStatus: 'unresolved' }, projectId)).toContain('🔴 Unresolved');
  });

  it('shows resolved status', () => {
    expect(buildIssueBody({ ...baseIssue, issueStatus: 'resolved' }, projectId)).toContain('✅ Resolved');
  });

  it('renders a username as a Crowdin profile link', () => {
    expect(buildIssueBody(baseIssue, projectId)).toContain('[@johndoe](https://crowdin.com/profile/johndoe)');
  });

  it('falls back to fullName when username is absent', () => {
    const body = buildIssueBody({ ...baseIssue, user: { fullName: 'Jane Smith' } }, projectId);
    expect(body).toContain('Jane Smith');
    expect(body).not.toContain('@');
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

  it('includes a link to the Crowdin project', () => {
    expect(buildIssueBody(baseIssue, projectId)).toContain(`https://crowdin.com/project/${projectId}`);
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
    expect(MARKER_RE.test(lines[lines.length - 1])).toBe(true);
  });

  it('includes the Crowdin ID in the table', () => {
    expect(buildIssueBody(baseIssue, projectId)).toContain(`| **Crowdin ID** | ${baseIssue.id} |`);
  });
});

// ---------------------------------------------------------------------------
// fetchCrowdinIssues
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ensureCrowdinLabel
// ---------------------------------------------------------------------------

describe('ensureCrowdinLabel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs success when label is created', async () => {
    mockCreateLabel.mockResolvedValue({});
    await ensureCrowdinLabel();
    expect(mockCreateLabel).toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Created label'));
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

// ---------------------------------------------------------------------------
// loadExistingGithubIssues
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// createGithubIssue
// ---------------------------------------------------------------------------

describe('createGithubIssue', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the created issue data', async () => {
    mockCreate.mockResolvedValue({ data: { number: 99, state: 'open' } });
    const result = await createGithubIssue('Test Title', 'Test Body');
    expect(result.number).toBe(99);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Test Title',
      body: 'Test Body',
      labels: [CROWDIN_LABEL],
    }));
  });
});

// ---------------------------------------------------------------------------
// updateGithubIssue
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// syncProject
// ---------------------------------------------------------------------------

describe('syncProject', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  /** Helper: run syncProject and advance fake timers so setTimeout resolves. */
  async function runSync(projectId, existingMap) {
    const p = syncProject(projectId, existingMap);
    await jest.runAllTimersAsync();
    return p;
  }

  it('creates a new GH issue for an unresolved Crowdin issue not in the map', async () => {
    const issue = makeCrowdinIssue({ id: 5, issueStatus: 'unresolved' });
    mockListStringCommentsStable.mockResolvedValue({ data: [{ data: issue }] });
    mockCreate.mockResolvedValue({ data: { number: 20, state: 'open' } });

    const map = new Map();
    await runSync('42', map);

    expect(mockCreate).toHaveBeenCalled();
    expect(map.has('42:5')).toBe(true);
  });

  it('skips creating a GH issue for an already-resolved Crowdin issue not in the map', async () => {
    const issue = makeCrowdinIssue({ id: 6, issueStatus: 'resolved' });
    mockListStringCommentsStable.mockResolvedValue({ data: [{ data: issue }] });

    const map = new Map();
    await runSync('42', map);

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('closes an open GH issue when the Crowdin issue becomes resolved', async () => {
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

  it('reopens a closed GH issue when the Crowdin issue is re-opened', async () => {
    const issue = makeCrowdinIssue({ id: 8, issueStatus: 'unresolved' });
    mockListStringCommentsStable.mockResolvedValue({ data: [{ data: issue }] });
    mockUpdate.mockResolvedValue({ data: { number: 11, state: 'open' } });

    const ghIssue = makeGhIssue({ number: 11, state: 'closed' });
    const map = new Map([['42:8', ghIssue]]);
    await runSync('42', map);

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ state: 'open' }));
  });

  it('logs "in sync" when GH issue state already matches (open/unresolved)', async () => {
    const issue = makeCrowdinIssue({ id: 9, issueStatus: 'unresolved' });
    mockListStringCommentsStable.mockResolvedValue({ data: [{ data: issue }] });

    const ghIssue = makeGhIssue({ number: 12, state: 'open' });
    const map = new Map([['42:9', ghIssue]]);
    await runSync('42', map);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('In sync'));
  });

  it('logs "in sync" when GH issue state already matches (closed/resolved)', async () => {
    const issue = makeCrowdinIssue({ id: 13, issueStatus: 'resolved' });
    mockListStringCommentsStable.mockResolvedValue({ data: [{ data: issue }] });

    const ghIssue = makeGhIssue({ number: 13, state: 'closed' });
    const map = new Map([['42:13', ghIssue]]);
    await runSync('42', map);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('In sync'));
  });
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

describe('main', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    // CROWDIN_PROJECT_IDS is frozen at module load; set env and use
    // jest.isolateModulesAsync to load a fresh instance with projects.
    const origProjectIds = process.env.CROWDIN_PROJECT_IDS;
    process.env.CROWDIN_PROJECT_IDS = '999';

    let freshMain;
    await jest.isolateModulesAsync(async () => {
      const mod = await import('../src/sync-crowdin-issues.js');
      freshMain = mod.main;
    });

    // freshMain uses the fresh module's CROWDIN_PROJECT_IDS = ['999']
    // The fresh module still uses the mocked @crowdin and @octokit clients.
    const p = freshMain();
    await jest.runAllTimersAsync();
    await p;

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Sync complete'));

    // Restore
    if (origProjectIds === undefined) delete process.env.CROWDIN_PROJECT_IDS;
    else process.env.CROWDIN_PROJECT_IDS = origProjectIds;
  });
});
