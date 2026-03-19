#!/usr/bin/env node
/**
 * Fetches translation/approval progress for every Crowdin project and:
 *   1. Generates an SVG progress graph per project and writes them to an
 *      output directory (to be committed to a dedicated branch).
 *   2. Upserts a single pinned GitHub issue whose body contains a Markdown
 *      table per project showing per-language progress sorted by lowest
 *      approval percentage first.
 *
 * The pinned issue is identified by the hidden marker comment:
 *
 *   <!-- crowdin-progress-pinned-issue -->
 *
 * Usage:
 *   node src/crowdin-progress.js
 *
 * Environment variables:
 *   CROWDIN_TOKEN        – Crowdin personal access token
 *   CROWDIN_PROJECT_IDS  – Comma-separated list of Crowdin project IDs
 *   GH_BOT_TOKEN         – GitHub PAT with issues write permission
 *   GITHUB_REPOSITORY    – "owner/repo" (populated automatically in Actions)
 *   SVG_OUTPUT_DIR       – Directory to write SVG files into (default: /tmp/crowdin-progress)
 */

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { Client as CrowdinClient } from '@crowdin/crowdin-api-client';
import { Octokit } from '@octokit/rest';
import { parseCrowdinProjectIds, validateEnv } from './common.js';

const _require = createRequire(import.meta.url);
/** @type {Record<string, Array<{discord: string, crowdin: string, github: string|null}>>} */
const languageManagers = _require('../language-managers.json');

// Determine whether this module is being run directly.
const _isMain = process.argv[1] === fileURLToPath(import.meta.url);

// Configuration – only validated when run directly.

const CROWDIN_TOKEN = process.env.CROWDIN_TOKEN;
const GH_BOT_TOKEN = process.env.GH_BOT_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // "owner/repo"

const SVG_OUTPUT_DIR = process.env.SVG_OUTPUT_DIR ?? '/tmp/crowdin-progress'; // NOSONAR(javascript:S5443)

/**
 * When `true`, only SVG graphs are generated.  The GitHub label, pinned issue,
 * and all Octokit calls are completely skipped.  Useful for local development
 * where GitHub credentials may not be available.
 *
 * Set via the environment variable `SVG_ONLY=true`.
 */
const SVG_ONLY = (process.env.SVG_ONLY ?? '').toLowerCase() === 'true';

const CROWDIN_PROJECT_IDS = parseCrowdinProjectIds();

/* istanbul ignore next */
if (_isMain) {
  const requiredVars = ['CROWDIN_TOKEN'];
  if (!SVG_ONLY) requiredVars.push('GH_BOT_TOKEN', 'GITHUB_REPOSITORY');
  validateEnv(requiredVars, CROWDIN_PROJECT_IDS);
}

const [GH_OWNER, GH_REPO] = (GITHUB_REPOSITORY ?? '/').split('/');

/** Hidden marker used to identify the single pinned progress issue. */
const PINNED_ISSUE_MARKER = '<!-- crowdin-progress-pinned-issue -->';

/**
 * Regex that matches Crowdin branch names created by the GitHub integration.
 * Example: "[LizardByte.sunshine] master"  →  captures "sunshine"
 */
const BRANCH_REPO_PATTERN = /^\[LizardByte\.(.+?)\]\s*master$/;

/** Title for the pinned issue. */
const PINNED_ISSUE_TITLE = 'Crowdin Translation Progress';

/** Label applied to the pinned progress issue. */
const PROGRESS_LABEL = 'crowdin-progress';

/** Color for the progress label. */
const PROGRESS_LABEL_COLOR = '0e8a16';

/** Guidance shown at the top of the pinned issue for language managers. */
const PINNED_ISSUE_APPROVAL_NOTE = [
  '> [!NOTE]',
  '> Language managers: approve translations in Crowdin via the Online Editor Proofreading workflow:',
  '> https://support.crowdin.com/online-editor/#proofreading',
].join('\n');

// Initialize API clients
const crowdin = new CrowdinClient({ token: CROWDIN_TOKEN });

const octokit = new Octokit({
  auth: GH_BOT_TOKEN,
  userAgent: 'crowdin-progress-sync',
});

/**
 * Fetches all projects the token has access to.
 *
 * @returns {Promise<object[]>}  Unwrapped project data objects.
 */
async function fetchProjects() {
  const response = await crowdin.projectsGroupsApi
    .withFetchAll()
    .listProjects({});
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Fetches the translation progress for every language in a project.
 *
 * @param {string|number} projectId
 * @returns {Promise<object[]>}  Unwrapped LanguageProgress data objects.
 */
async function fetchProjectProgress(projectId) {
  const response = await crowdin.translationStatusApi
    .withFetchAll()
    .getProjectProgress(projectId, {});
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Resolves manager entries for a language key using exact match first,
 * then a case-insensitive key comparison.
 *
 * @param {string} key
 * @returns {Array<{discord: string, crowdin: string, github: string|null}>|undefined}
 */
function resolveManagersForKey(key) {
  if (Object.hasOwn(languageManagers, key)) {
    return languageManagers[key];
  }

  const lowerKey = key.toLowerCase();
  const matchedKey = Object.keys(languageManagers).find((candidate) => candidate.toLowerCase() === lowerKey);
  return matchedKey ? languageManagers[matchedKey] : undefined;
}

/**
 * Expands compact locale strings like "esES" to "es-ES".
 *
 * @param {string} languageId
 * @returns {string|null}
 */
function expandCompactLocale(languageId) {
  if (languageId.includes('-')) return null;

  const match = /^([A-Za-z]{2,3})([A-Za-z]{2})$/.exec(languageId);
  if (!match) return null;

  return `${match[1].toLowerCase()}-${match[2].toUpperCase()}`;
}

/**
 * Returns progressively less specific fallback language keys.
 * Example: "zh-Hant-TW" -> ["zh-Hant", "zh"].
 *
 * @param {string} languageId
 * @returns {string[]}
 */
function getFallbackLanguageKeys(languageId) {
  const parts = languageId.split('-');
  const keys = [];

  while (parts.length > 1) {
    parts.pop();
    keys.push(parts.join('-'));
  }

  return keys;
}

/**
 * Builds ordered unique lookup candidates for manager resolution.
 *
 * @param {string} languageId
 * @returns {string[]}
 */
function buildManagerLookupCandidates(languageId) {
  const normalised = languageId.replaceAll('_', '-');
  const expandedCompactLocale = expandCompactLocale(normalised);
  const baseCandidates = [languageId, normalised, expandedCompactLocale].filter(Boolean);

  const seen = new Set();
  const orderedCandidates = [];

  for (const candidate of baseCandidates) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      orderedCandidates.push(candidate);
    }

    for (const fallbackKey of getFallbackLanguageKeys(candidate)) {
      if (seen.has(fallbackKey)) continue;
      seen.add(fallbackKey);
      orderedCandidates.push(fallbackKey);
    }
  }

  return orderedCandidates;
}

/**
 * Returns the language managers for a given Crowdin language ID.
 * Normalizes separators (underscore → hyphen), supports compact locale IDs
 * (e.g. "esES"), and falls back from region variants to base language.
 *
 * @param {string|null|undefined} languageId
 * @returns {Array<{discord: string, crowdin: string, github: string|null}>}
 */
function getLanguageManagers(languageId) {
  if (!languageId) return [];

  const candidates = buildManagerLookupCandidates(languageId);
  for (const candidate of candidates) {
    const managers = resolveManagersForKey(candidate);
    if (managers !== undefined) return managers;
  }

  return [];
}

/**
 * Returns a formatted string of manager mentions for a language, for use in
 * a Markdown table cell.  GitHub usernames are linked as @mentions; managers
 * without a GitHub account fall back to their Discord handle.
 *
 * @param {string|null|undefined} languageId
 * @returns {string}
 */
function formatManagers(languageId) {
  const managers = getLanguageManagers(languageId);
  if (managers.length === 0) return '—';
  return managers
    .map((m) => (m.github ? `@${m.github}` : m.discord))
    .join(', ');
}

/** Total number of filled/empty segments in the Unicode progress bar. */
const BAR_LENGTH = 10;

/**
 * Builds a Unicode block-character progress bar string followed by the
 * percentage value.
 *
 * Example: `████████░░ 80%`
 *
 * @param {number} percent  0–100 integer.
 * @returns {string}
 */
function buildProgressBar(percent) {
  const filled = Math.round((percent / 100) * BAR_LENGTH);
  const empty = BAR_LENGTH - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return `${bar} ${percent}%`;
}

/**
 * Returns the friendly display name for a language as returned by the Crowdin
 * API, or undefined if the API did not supply one.
 *
 * @param {object|null|undefined} languageObj  The `language` object from a progress entry.
 * @returns {string|undefined}
 */
function getLanguageName(languageObj) {
  return languageObj?.name ?? undefined;
}

/**
 * Sorts progress entries: ascending by approvalProgress, then by
 * translationProgress, then alphabetically by language name / code.
 * (0% approved → top; 100% approved → bottom.)
 *
 * @param {object[]} entries
 * @returns {object[]}  New sorted array.
 */
function sortProgressEntries(entries) {
  return [...entries].sort((a, b) => {
    const approvalDiff = a.approvalProgress - b.approvalProgress;
    if (approvalDiff !== 0) return approvalDiff;
    const translationDiff = a.translationProgress - b.translationProgress;
    if (translationDiff !== 0) return translationDiff;
    const nameA = getLanguageName(a.language) ?? a.language?.id ?? '';
    const nameB = getLanguageName(b.language) ?? b.language?.id ?? '';
    return nameA.localeCompare(nameB);
  });
}

/**
 * Builds the Markdown table for a single project's progress data.
 *
 * @param {object}   project   Crowdin project data object.
 * @param {object[]} entries   Progress entries for the project.
 * @returns {string}  Markdown string (table only, no heading).
 */
function buildProjectTable(project, entries) {
  const sorted = sortProgressEntries(entries);

  const header = [
    '| Language | Code | Translated | Approved | Managers |',
    '|----------|------|------------|----------|----------|',
  ];

  const rows = sorted.map((entry) => {
    const lang = entry.language ?? {};
    const name = getLanguageName(lang);
    const code = lang.id ?? '—';
    const translated = buildProgressBar(entry.translationProgress ?? 0);
    const approved = buildProgressBar(entry.approvalProgress ?? 0);
    const managers = formatManagers(code);

    // Use the friendly name when the API provides one, otherwise just the code.
    const nameCell = name ?? code;
    return `| ${nameCell} | \`${code}\` | ${translated} | ${approved} | ${managers} |`;
  });

  return [...header, ...rows].join('\n');
}

/**
 * Builds the full body of the pinned GitHub issue, including tables for
 * every project.
 *
 * @param {Array<{project: object, entries: object[]}>} projectsData
 * @returns {string}
 */
function buildPinnedIssueBody(projectsData) {
  const updatedAt = new Date().toUTCString();

  const sections = projectsData.map(({ project, entries }) => {
    const name = project.name ?? `Project ${project.id}`;
    const url = project.identifier
      ? `https://crowdin.com/project/${project.identifier}`
      : null;
    const heading = url ? `### [${name}](${url})` : `### ${name}`;
    const table = buildProjectTable(project, entries);
    return [heading, '', table].join('\n');
  });

  return [
    PINNED_ISSUE_APPROVAL_NOTE,
    '',
    `_Last updated: ${updatedAt}_`,
    '',
    ...sections.flatMap((s) => [s, '']),
    '---',
    '',
    PINNED_ISSUE_MARKER,
  ].join('\n');
}

/** SVG viewport / layout constants. */
const SVG_LINE_HEIGHT = 32;
const SVG_BAR_HEIGHT = 16;
const SVG_WIDTH = 500;
const SVG_LABEL_WIDTH = 200;
const SVG_PROGRESS_WIDTH = 160;
const SVG_INSERT_X = 12;

/**
 * Generates an SVG progress graph for a project's translation data and writes
 * it to `<outputDir>/<safeName>_graph.svg`.
 *
 * @param {string}   projectName  Human-readable project name.
 * @param {object[]} entries      Sorted progress entries.
 * @param {string}   outputDir    Absolute path to the output directory.
 * @returns {string}  Path to the written SVG file.
 */
function generateProjectSvg(projectName, entries, outputDir) {
  const totalHeight = entries.length * SVG_LINE_HEIGHT;

  const svgLines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${totalHeight}">`,
    '<defs>',
    '<style>',
    '@import url(https://fonts.googleapis.com/css?family=Open+Sans);',
    '.svg-font { font-family: "Open Sans", sans-serif; font-size: 12px; fill: #999; }',
    '</style>',
    '</defs>',
  ];

  entries.forEach((entry, index) => {
    const lang = entry.language ?? {};
    const name = getLanguageName(lang);
    const code = lang.id ?? '?';
    // Use the API-provided name when available, otherwise fall back to the code.
    const label = name ? `${name} (${code})` : code;

    const translationRatio = (entry.translationProgress ?? 0) / 100;
    const approvalRatio = (entry.approvalProgress ?? 0) / 100;

    const yOffset = index * SVG_LINE_HEIGHT;
    const barX = SVG_LABEL_WIDTH + SVG_INSERT_X;
    const barY = yOffset + 6;
    const textY = yOffset + 18;

    // Background track (only when not 100% translated)
    const backgroundRect = translationRatio < 1
      ? `<rect x="${barX}" y="${barY}" width="${SVG_PROGRESS_WIDTH}" height="${SVG_BAR_HEIGHT}" fill="#999" opacity="0.3"/>`
      : '';

    // Translation bar (blue, shown only when > 0% and not fully approved)
    const translationRect = translationRatio > 0 && approvalRatio < 1
      ? `<rect x="${barX}" y="${barY}" width="${translationRatio * SVG_PROGRESS_WIDTH}" height="${SVG_BAR_HEIGHT}" fill="#5D89C3"/>`
      : '';

    // Approval bar (green, shown only when > 0%)
    const approvalRect = approvalRatio > 0
      ? `<rect x="${barX}" y="${barY}" width="${approvalRatio * SVG_PROGRESS_WIDTH}" height="${SVG_BAR_HEIGHT}" fill="#71C277"/>`
      : '';

    const percentX = barX + SVG_PROGRESS_WIDTH + SVG_INSERT_X;

    svgLines.push(
      `<g class="svg-font">`,
      `<text x="${SVG_LABEL_WIDTH}" y="${textY}" text-anchor="end">${escapeXml(label)}</text>`,
      ...([backgroundRect, translationRect, approvalRect].filter(Boolean)),
      `<text x="${percentX}" y="${textY}">${entry.translationProgress ?? 0}%</text>`,
      '</g>',
    );
  });

  svgLines.push('</svg>');

  const svg = svgLines.join('\n');
  const safeName = projectName.replaceAll(/\s+/g, '_');
  const filePath = path.join(outputDir, `${safeName}_graph.svg`);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, svg, 'utf8');

  return filePath;
}

/**
 * Escapes characters that are special in XML/SVG text nodes.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str) {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/**
 * Ensures the progress label exists in the repository.
 *
 * @returns {Promise<void>}
 */
async function ensureProgressLabel() {
  try {
    await octokit.rest.issues.createLabel({
      owner: GH_OWNER,
      repo: GH_REPO,
      name: PROGRESS_LABEL,
      color: PROGRESS_LABEL_COLOR,
      description: 'Crowdin translation progress tracker',
    });
    console.log(`  Created label "${PROGRESS_LABEL}".`);
  } catch (e) {
    if (e.status === 422) return; // already exists
    console.warn(`  WARN: Could not create label "${PROGRESS_LABEL}": ${e.message}`);
  }
}

/**
 * Searches all open + closed issues for the hidden pinned-issue marker and
 * returns the first match, or null if none exists.
 *
 * @returns {Promise<object|null>}
 */
async function findPinnedIssue() {
  const items = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner: GH_OWNER,
    repo: GH_REPO,
    labels: PROGRESS_LABEL,
    state: 'all',
    per_page: 100,
  });

  for (const item of items) {
    if (item.pull_request) continue;
    if (item.body?.includes(PINNED_ISSUE_MARKER)) {
      return item;
    }
  }
  return null;
}

/**
 * Creates the pinned progress issue.
 *
 * @param {string} body
 * @returns {Promise<object>}  Created issue data.
 */
async function createPinnedIssue(body) {
  const { data } = await octokit.rest.issues.create({
    owner: GH_OWNER,
    repo: GH_REPO,
    title: PINNED_ISSUE_TITLE,
    body,
    labels: [PROGRESS_LABEL],
  });
  return data;
}

/**
 * Updates an existing issue's title and/or body.
 *
 * @param {number} issueNumber
 * @param {object} patch
 * @returns {Promise<object>}
 */
async function updateIssue(issueNumber, patch) {
  const { data } = await octokit.rest.issues.update({
    owner: GH_OWNER,
    repo: GH_REPO,
    issue_number: issueNumber,
    ...patch,
  });
  return data;
}

/**
 * Creates or updates the single pinned progress issue.
 * The issue is left open so it can be pinned permanently.
 *
 * @param {string} body
 * @returns {Promise<void>}
 */
async function upsertPinnedIssue(body) {
  const existing = await findPinnedIssue();

  if (existing) {
    const patch = {};
    if (existing.title !== PINNED_ISSUE_TITLE) patch.title = PINNED_ISSUE_TITLE;
    if (existing.body !== body) patch.body = body;
    // Re-open if it was accidentally closed.
    if (existing.state !== 'open') patch.state = 'open';

    if (Object.keys(patch).length > 0) {
      await updateIssue(existing.number, patch);
      console.log(`  Updated pinned issue #${existing.number}.`);
    } else {
      console.log(`  Pinned issue #${existing.number} is already up to date.`);
    }
  } else {
    const created = await createPinnedIssue(body);
    console.log(`  Created pinned issue #${created.number}.`);
  }
}

/**
 * Fetches progress for a set of project IDs and returns structured data.
 *
 * @param {string[]} projectIds
 * @returns {Promise<Array<{project: object, entries: object[]}>>}
 */
async function fetchAllProjectsProgress(projectIds) {
  // First fetch all projects to get their metadata (name, identifier/slug).
  const allProjects = await fetchProjects();
  const projectMap = new Map(allProjects.map((p) => [String(p.id), p]));

  const results = [];
  for (const id of projectIds) {
    const project = projectMap.get(String(id)) ?? { id, name: `Project ${id}` };
    console.log(`\nProject ${id} (${project.name})`);

    const entries = await fetchProjectProgress(id);
    console.log(`  ${entries.length} language(s) found.`);

    results.push({ project, entries });
  }
  return results;
}

/**
 * Generates SVG graphs for all projects and writes them to the output dir.
 *
 * @param {Array<{project: object, entries: object[]}>} projectsData
 * @param {string} outputDir
 */
function generateAllSvgs(projectsData, outputDir) {
  for (const { project, entries } of projectsData) {
    const name = project.name ?? `Project_${project.id}`;
    // Sort ascending then reverse so best-approved languages appear at the top.
    const sorted = [...sortProgressEntries(entries)].reverse();
    const filePath = generateProjectSvg(name, sorted, outputDir);
    console.log(`  SVG written: ${filePath}`);
  }
}

/**
 * Fetches all branches for a project.
 *
 * @param {string|number} projectId
 * @returns {Promise<object[]>}  Unwrapped Branch data objects.
 */
async function fetchProjectBranches(projectId) {
  const response = await crowdin.sourceFilesApi
    .withFetchAll()
    .listProjectBranches(projectId, {});
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Fetches per-language translation progress for a specific branch.
 *
 * @param {string|number} projectId
 * @param {number} branchId
 * @returns {Promise<object[]>}  Unwrapped LanguageProgress data objects.
 */
async function fetchBranchProgress(projectId, branchId) {
  const response = await crowdin.translationStatusApi
    .withFetchAll()
    .getBranchProgress(projectId, branchId, {});
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Fetches all directories for a project.
 *
 * @param {string|number} projectId
 * @returns {Promise<object[]>}  Unwrapped Directory data objects.
 */
async function fetchProjectDirectories(projectId) {
  const response = await crowdin.sourceFilesApi
    .withFetchAll()
    .listProjectDirectories(projectId, {});
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Fetches per-language translation progress for a specific directory.
 *
 * @param {string|number} projectId
 * @param {number} directoryId
 * @returns {Promise<object[]>}  Unwrapped LanguageProgress data objects.
 */
async function fetchDirectoryProgress(projectId, directoryId) {
  const response = await crowdin.translationStatusApi
    .withFetchAll()
    .getDirectoryProgress(projectId, directoryId, {});
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Extracts a short GitHub repo name from a Crowdin branch name.
 *
 * Matches the GitHub integration pattern "[LizardByte.<repo>] master" and
 * returns only `<repo>`.  For any other branch name the full name is returned
 * as-is (e.g. "app.lizardbyte.dev" stays "app.lizardbyte.dev").
 *
 * @param {string} branchName
 * @returns {string}
 */
function extractRepoNameFromBranch(branchName) {
  const match = BRANCH_REPO_PATTERN.exec(branchName);
  return match ? match[1] : branchName;
}

/**
 * Merges multiple LanguageProgress arrays (from different directories/files)
 * into one array by aggregating word counts per language, then recomputing
 * percentages.
 *
 * @param {object[]} entries  One or more LanguageProgress entries, possibly
 *   spanning several directories.
 * @returns {object[]}  One entry per unique language with combined progress.
 */
function aggregateLanguageProgress(entries) {
  /** @type {Map<string, {language: object, wordsTotal: number, wordsTranslated: number, wordsApproved: number}>} */
  const byLanguage = new Map();

  for (const entry of entries) {
    const langId = entry.language?.id ?? entry.languageId;
    if (!langId) continue;

    if (!byLanguage.has(langId)) {
      byLanguage.set(langId, {
        language: entry.language ?? null,
        wordsTotal: 0,
        wordsTranslated: 0,
        wordsApproved: 0,
      });
    }

    const acc = byLanguage.get(langId);
    acc.wordsTotal += entry.words?.total ?? 0;
    acc.wordsTranslated += entry.words?.translated ?? 0;
    acc.wordsApproved += entry.words?.approved ?? 0;
  }

  return [...byLanguage.values()].map((acc) => ({
    language: acc.language,
    translationProgress: acc.wordsTotal > 0
      ? Math.round((acc.wordsTranslated / acc.wordsTotal) * 100)
      : 0,
    approvalProgress: acc.wordsTotal > 0
      ? Math.round((acc.wordsApproved / acc.wordsTotal) * 100)
      : 0,
  }));
}

/**
 * Fetches all source files for a project.
 *
 * @param {string|number} projectId
 * @returns {Promise<object[]>}  Unwrapped File data objects.
 */
async function fetchProjectFiles(projectId) {
  const response = await crowdin.sourceFilesApi
    .withFetchAll()
    .listProjectFiles(projectId, {});
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Fetches per-language translation progress for a specific source file.
 *
 * @param {string|number} projectId
 * @param {number} fileId
 * @returns {Promise<object[]>}  Unwrapped LanguageProgress data objects.
 */
async function fetchFileProgress(projectId, fileId) {
  const response = await crowdin.translationStatusApi
    .withFetchAll()
    .getFileProgress(projectId, fileId, {});
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Extracts the GitHub repo name from a Crowdin source file path.
 *
 * Files whose path starts with `/projects/<name>/` are attributed to the
 * `<name>` repository.  All other files (root-level content, etc.) belong
 * to the `.github` repository.
 *
 * Examples:
 *   `/projects/sunshine/en.json`        → `"sunshine"`
 *   `/projects/moonlight/deep/path.yml` → `"moonlight"`
 *   `/contributing.md`                  → `".github"`
 *   (empty / null)                      → `".github"`
 *
 * @param {string|null|undefined} filePath  The `path` field from a Crowdin File object.
 * @returns {string}
 */
function extractRepoNameFromFilePath(filePath) {
  if (!filePath) return '.github';
  const match = /^\/projects\/([^/]+)(?:\/|$)/.exec(filePath);
  return match ? match[1] : '.github';
}

/**
 * Extracts the GitHub repo name from a Crowdin source file object.
 *
 * Two naming conventions are supported:
 *
 * **1. Slash-separated** (GitHub-integration file-based projects):
 * The repo name is read from the `path` field which follows the Crowdin
 * project directory structure:
 *   `file.path = "/projects/sunshine/"` → `"sunshine"`
 *
 * **2. Underscore-separated** (website-translator projects):
 * Crowdin's website translator flattens the page URL into the file *name*
 * using underscores and a `root_` prefix.  A page at `…/projects/sunshine/page`
 * produces a file named `root_projects_sunshine_page.json`.  The repo name is
 * the path component that directly follows `root_projects_`:
 *   `file.name = "root_projects_sunshine_page.json"` → `"sunshine"`
 *
 * Falls back to `".github"` when neither pattern matches (i.e. the file does
 * not belong to any `/projects/<name>/…` path).
 *
 * @param {object} file  A Crowdin File data object (`path` and `name` fields).
 * @param {string} [fallback='.github']  Value to return when neither pattern matches.
 * @returns {string}
 */
function extractRepoNameFromFile(file, fallback = '.github') {
  // 1. Slash-separated: concatenate path + name so both directory and filename
  //    can contribute to the match (e.g. path="/projects/sunshine/", name="en.json").
  const fullPath = `${file.path ?? ''}${file.name ?? ''}`;
  const slashMatch = /\/projects\/([^/]+)(?:\/|$)/.exec(fullPath);
  if (slashMatch) return slashMatch[1];

  // 2. Underscore-separated (website-translator): file name like
  //    "root_projects_<name>_<rest>.json".
  const underscoreMatch = /^root_projects_([^_]+)(?:_|$)/.exec(file.name ?? '');
  if (underscoreMatch) return underscoreMatch[1];

  return fallback;
}

/**
 * For projects whose source files are organized by website URL path
 * (e.g. the LizardByte-docs website-translator project), groups all source
 * files by their inferred GitHub repository origin and generates one SVG
 * progress graph per repository.
 *
 * Per-file progress is fetched and aggregated across all files that share
 * the same repo before the SVG is written.
 *
 * @param {object}   project    Crowdin project data object.
 * @param {object[]} files      All source files returned by the Crowdin API.
 * @param {string}   outputDir  Absolute path to the output directory.
 * @returns {Promise<void>}
 */
async function generateRepoFilesSvgs(project, files, outputDir) {
  const projectId = project.id;
  const projectName = project.name ?? `Project_${projectId}`;
  // Files that don't belong to any /projects/<name>/ sub-tree are attributed to
  // the project's own identifier (e.g. "app.lizardbyte.dev" for the website
  // project) rather than the generic ".github" fallback.
  const defaultRepo = project.identifier ?? '.github';

  if (files.length === 0) {
    console.log('  No source files found.');
    return;
  }

  /** @type {Map<string, object[]>} */
  const filesByRepo = new Map();
  for (const file of files) {
    const repo = extractRepoNameFromFile(file, defaultRepo);
    if (!filesByRepo.has(repo)) filesByRepo.set(repo, []);
    filesByRepo.get(repo).push(file);
  }

  console.log(`  Found files in ${filesByRepo.size} repo(s): ${[...filesByRepo.keys()].join(', ')}`);

  for (const [repo, repoFiles] of filesByRepo) {
    console.log(`  Fetching progress for ${repoFiles.length} file(s) in "${repo}"...`);
    const allEntries = [];
    for (const file of repoFiles) {
      const entries = await fetchFileProgress(projectId, file.id);
      allEntries.push(...entries);
    }

    if (allEntries.length > 0) {
      const aggregated = aggregateLanguageProgress(allEntries);
      const sorted = [...sortProgressEntries(aggregated)].reverse();
      const svgName = `${projectName}_${repo}`;
      const filePath = generateProjectSvg(svgName, sorted, outputDir);
      console.log(`  SVG written: ${filePath}`);
    }
  }
}

/**
 * Regex that matches directory names that look like a hostname / domain
 * (e.g. `"app.lizardbyte.dev"`).  Used to identify website-translator
 * directories that live alongside GitHub-integration branches inside the
 * same Crowdin project.
 */
const DOMAIN_DIR_PATTERN = /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/;

/**
 * For projects that use Crowdin branches to mirror GitHub repositories,
 * generates one SVG progress graph per matching branch and writes them to
 * `outputDir`.
 *
 * Only branches whose names match `BRANCH_REPO_PATTERN`
 * (`[LizardByte.<repo>] master`) are included.
 *
 * @param {object}   project    Crowdin project data object.
 * @param {object[]} branches   All branches returned by the Crowdin API.
 * @param {string}   outputDir  Absolute path to the output directory.
 * @returns {Promise<void>}
 */
async function generateRepoBranchSvgs(project, branches, outputDir) {
  const projectId = project.id;
  const projectName = project.name ?? `Project_${projectId}`;

  const repoBranches = branches.filter(
    (b) => BRANCH_REPO_PATTERN.test(b.name),
  );

  if (repoBranches.length === 0) {
    console.log('  No matching repo branches found.');
    return;
  }

  console.log(`  Found ${repoBranches.length} repo branch(es).`);

  for (const branch of repoBranches) {
    const repoName = extractRepoNameFromBranch(branch.name);
    console.log(`  Fetching progress for branch "${branch.name}"...`);
    const entries = await fetchBranchProgress(projectId, branch.id);
    const sorted = [...sortProgressEntries(entries)].reverse();
    const svgName = `${projectName}_${repoName}`;
    const filePath = generateProjectSvg(svgName, sorted, outputDir);
    console.log(`  SVG written: ${filePath}`);
  }
}

/**
 * For projects that contain both GitHub-integration branches **and**
 * website-translator content organised as a root-level directory
 * (e.g. `app.lizardbyte.dev`), generates one SVG progress graph per
 * matching directory.
 *
 * Only directories whose names look like a hostname (contain at least one
 * dot) are considered.
 *
 * @param {object} project    Crowdin project data object.
 * @param {string} outputDir  Absolute path to the output directory.
 * @returns {Promise<void>}
 */
async function generateRepoDirSvgs(project, outputDir) {
  const projectId = project.id;
  const projectName = project.name ?? `Project_${projectId}`;

  const directories = await fetchProjectDirectories(projectId);
  const domainDirs = directories.filter((d) => DOMAIN_DIR_PATTERN.test(d.name));

  if (domainDirs.length === 0) {
    console.log('  No domain directories found.');
    return;
  }

  console.log(`  Found ${domainDirs.length} domain director${domainDirs.length === 1 ? 'y' : 'ies'}: ${domainDirs.map((d) => d.name).join(', ')}`);

  for (const dir of domainDirs) {
    console.log(`  Fetching progress for directory "${dir.name}"...`);
    const entries = await fetchDirectoryProgress(projectId, dir.id);
    if (entries.length > 0) {
      const sorted = [...sortProgressEntries(entries)].reverse();
      const svgName = `${projectName}_${dir.name}`;
      const filePath = generateProjectSvg(svgName, sorted, outputDir);
      console.log(`  SVG written: ${filePath}`);
    }
  }
}

/**
 * Generates per-repository SVG graphs for every project in `projectsData`.
 *
 * For projects that expose GitHub-integration branches the branch-based
 * approach is used (`generateRepoBranchSvgs`).  For all other projects
 * (e.g. website-translator docs projects) the source file path–based
 * approach is used (`generateRepoFilesSvgs`), which groups files by the
 * repo inferred from each file's `/projects/<name>/…` path.
 *
 * @param {Array<{project: object, entries: object[]}>} projectsData
 * @param {string} outputDir
 * @returns {Promise<void>}
 */
async function generateAllRepoSvgs(projectsData, outputDir) {
  for (const { project } of projectsData) {
    const projectId = project.id;
    console.log(`\n  Checking repo sources for project ${projectId} (${project.name ?? ''})...`);

    const branches = await fetchProjectBranches(projectId);
    const repoBranches = branches.filter(
      (b) => BRANCH_REPO_PATTERN.test(b.name),
    );

    if (repoBranches.length > 0) {
      await generateRepoBranchSvgs(project, branches, outputDir);
      await generateRepoDirSvgs(project, outputDir);
    } else {
      console.log('  No repo branches; using file path–based approach.');
      const files = await fetchProjectFiles(projectId);
      await generateRepoFilesSvgs(project, files, outputDir);
    }
  }
}

async function main() {
  const svgOnly = (process.env.SVG_ONLY ?? '').toLowerCase() === 'true';

  console.log('=== Crowdin Progress Sync ===');
  if (svgOnly) console.log('  Mode: SVG-only (GitHub issue update skipped)');
  console.log(`Repository : ${GITHUB_REPOSITORY}`);
  console.log(`Projects   : ${CROWDIN_PROJECT_IDS.join(', ')}`);
  console.log(`SVG output : ${SVG_OUTPUT_DIR}`);

  if (!svgOnly) {
    console.log('\nEnsuring progress label exists...');
    await ensureProgressLabel();
  }

  console.log('\nFetching project progress from Crowdin...');
  const projectsData = await fetchAllProjectsProgress(CROWDIN_PROJECT_IDS);

  console.log('\nGenerating SVG graphs...');
  generateAllSvgs(projectsData, SVG_OUTPUT_DIR);

  if (!svgOnly) {
    console.log('\nBuilding pinned issue body...');
    const body = buildPinnedIssueBody(projectsData);

    console.log('\nUpserting pinned GitHub issue...');
    await upsertPinnedIssue(body);
  }

  console.log('\nGenerating per-repository SVG graphs...');
  await generateAllRepoSvgs(projectsData, SVG_OUTPUT_DIR);

  console.log('\n=== Sync complete ===');
}

/* istanbul ignore next */
if (_isMain) {
  void main().catch((err) => { // NOSONAR(javascript:7785)
    console.error(err.message);
    process.exit(1);
  });
}

// Exports for unit testing
export {
  PINNED_ISSUE_MARKER,
  PINNED_ISSUE_TITLE,
  PROGRESS_LABEL,
  PROGRESS_LABEL_COLOR,
  SVG_ONLY,
  BAR_LENGTH,
  SVG_LINE_HEIGHT,
  SVG_BAR_HEIGHT,
  SVG_WIDTH,
  SVG_LABEL_WIDTH,
  SVG_PROGRESS_WIDTH,
  SVG_INSERT_X,
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
  fetchProjectBranches,
  fetchBranchProgress,
  fetchProjectDirectories,
  fetchDirectoryProgress,
  fetchProjectFiles,
  fetchFileProgress,
  extractRepoNameFromBranch,
  extractRepoNameFromFilePath,
  extractRepoNameFromFile,
  aggregateLanguageProgress,
  generateRepoBranchSvgs,
  generateRepoFilesSvgs,
  generateRepoDirSvgs,
  generateAllRepoSvgs,
  main,
};
