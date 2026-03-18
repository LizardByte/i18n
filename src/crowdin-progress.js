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

const CROWDIN_PROJECT_IDS = parseCrowdinProjectIds();

/* istanbul ignore next */
if (_isMain) {
  validateEnv(['CROWDIN_TOKEN', 'GH_BOT_TOKEN', 'GITHUB_REPOSITORY'], CROWDIN_PROJECT_IDS);
}

const [GH_OWNER, GH_REPO] = (GITHUB_REPOSITORY ?? '/').split('/');

/** Hidden marker used to identify the single pinned progress issue. */
const PINNED_ISSUE_MARKER = '<!-- crowdin-progress-pinned-issue -->';

/** Title for the pinned issue. */
const PINNED_ISSUE_TITLE = 'Crowdin Translation Progress';

/** Label applied to the pinned progress issue. */
const PROGRESS_LABEL = 'crowdin-progress';

/** Color for the progress label. */
const PROGRESS_LABEL_COLOR = '0e8a16';

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
    const sorted = sortProgressEntries(entries);
    const filePath = generateProjectSvg(name, sorted, outputDir);
    console.log(`  SVG written: ${filePath}`);
  }
}

async function main() {
  console.log('=== Crowdin Progress Sync ===');
  console.log(`Repository : ${GITHUB_REPOSITORY}`);
  console.log(`Projects   : ${CROWDIN_PROJECT_IDS.join(', ')}`);
  console.log(`SVG output : ${SVG_OUTPUT_DIR}`);

  console.log('\nEnsuring progress label exists...');
  await ensureProgressLabel();

  console.log('\nFetching project progress from Crowdin...');
  const projectsData = await fetchAllProjectsProgress(CROWDIN_PROJECT_IDS);

  console.log('\nGenerating SVG graphs...');
  generateAllSvgs(projectsData, SVG_OUTPUT_DIR);

  console.log('\nBuilding pinned issue body...');
  const body = buildPinnedIssueBody(projectsData);

  console.log('\nUpserting pinned GitHub issue...');
  await upsertPinnedIssue(body);

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
  main,
};
