#!/usr/bin/env node
/**
 * Syncs source-string issues from the Crowdin API to this repository's GitHub Issues.
 *
 * The script is fully idempotent – each run will:
 *   • Create a new GitHub issue for every Crowdin issue that has no
 *     corresponding GitHub issue yet (including already-resolved ones, which
 *     are created and immediately closed).
 *   • Close a GitHub issue when the matching Crowdin issue has been resolved.
 *   • Re-open a GitHub issue when a previously-resolved Crowdin issue is
 *     re-opened.
 *   • Refresh the body of any GitHub issue whose content is stale.
 *   • Assign the GitHub issue to the language managers on creation.
 *
 * Deduplication is achieved by embedding a hidden HTML comment in every
 * GitHub issue body:
 *
 *   <!-- crowdin-issue-id:PROJECT_ID:ISSUE_ID -->
 *
 * On startup the script fetches all GitHub issues carrying the "crowdin"
 * label (open and closed) and builds an in-memory map keyed by that marker.
 * This avoids GitHub Search API calls (which have stricter rate limits)
 * during the main processing loop.
 *
 * Usage:
 *   node src/sync-crowdin-issues.js
 *
 * Environment variables:
 *   CROWDIN_TOKEN        – Crowdin personal access token
 *   CROWDIN_PROJECT_IDS  – Comma-separated list of Crowdin project IDs
 *   GH_BOT_TOKEN         – GitHub PAT with issues write permission
 *   GITHUB_REPOSITORY    – "owner/repo" (populated automatically in Actions)
 */

import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Client as CrowdinClient } from '@crowdin/crowdin-api-client';
import { Octokit } from '@octokit/rest';

const _require = createRequire(import.meta.url);
/** @type {Record<string, Array<{discord: string, crowdin: string, github: string|null}>>} */
const languageManagers = _require('../language-managers.json');

// Determine whether this module is being run directly.
const _isMain = process.argv[1] === fileURLToPath(import.meta.url);

// Configuration – only validated when run directly.

const CROWDIN_TOKEN = process.env.CROWDIN_TOKEN;
const GH_BOT_TOKEN = process.env.GH_BOT_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY; // "owner/repo"

const CROWDIN_PROJECT_IDS = (process.env.CROWDIN_PROJECT_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/* istanbul ignore next */
if (_isMain) {
  for (const [name, val] of Object.entries({ CROWDIN_TOKEN, GH_BOT_TOKEN, GITHUB_REPOSITORY })) {
    if (val) continue;
    console.error(`ERROR: environment variable ${name} is required.`);
    process.exit(1);
  }

  if (CROWDIN_PROJECT_IDS.length === 0) {
    console.error('ERROR: CROWDIN_PROJECT_IDS environment variable is not set or empty.');
    process.exit(1);
  }
}

const [GH_OWNER, GH_REPO] = (GITHUB_REPOSITORY ?? '/').split('/');

/** Label applied to every GitHub issue managed by this script. */
const CROWDIN_LABEL = 'crowdin';

/** Color used for language labels (lang:xx). */
const LANG_LABEL_COLOR = 'bfd4f2';

/** Color used for issue-type labels (type:xx). */
const TYPE_LABEL_COLOR = '0075ca';

/** RegExp that matches the hidden deduplication marker embedded in issue bodies. */
const MARKER_RE = /<!-- crowdin-issue-id:(\d+):(\d+) -->/;

// Initialize API clients

const crowdin = new CrowdinClient({ token: CROWDIN_TOKEN });

const octokit = new Octokit({
  auth: GH_BOT_TOKEN,
  userAgent: 'crowdin-issues-sync',
});

// Crowdin helpers

/** Cache of projectId → project identifier (slug), populated on first use. */
const projectSlugCache = new Map();

/**
 * Returns the Crowdin project identifier (URL slug) for the given project ID.
 * Results are cached for the lifetime of the process.
 *
 * @param {string|number} projectId
 * @returns {Promise<string>}
 */
async function fetchProjectSlug(projectId) {
  if (projectSlugCache.has(String(projectId))) {
    return projectSlugCache.get(String(projectId));
  }
  const { data } = await crowdin.projectsGroupsApi.getProject(projectId);
  const slug = data.identifier;
  projectSlugCache.set(String(projectId), slug);
  return slug;
}

/**
 * Fetches *all* source-string issues for a project using the SDK's built-in
 * auto-pagination helper so no manual offset tracking is required.
 * Filtering to type='issue' excludes ordinary string comments.
 *
 * @param {string|number} projectId
 * @returns {Promise<object[]>}  Unwrapped StringComment data objects.
 */
async function fetchCrowdinIssues(projectId) {
  const response = await crowdin.stringCommentsApi
    .withFetchAll()
    .listStringComments(projectId, { type: 'issue' });
  return (response.data ?? []).map((item) => item.data);
}

// GitHub helpers

/**
 * Creates a label in the repository if it doesn't already exist.
 * A 422 response means the label already exists and is silently ignored.
 *
 * @param {string} name
 * @param {string} color        Hex color without the leading `#`.
 * @param {string} description
 */
async function ensureLabel(name, color, description) {
  try {
    await octokit.rest.issues.createLabel({
      owner: GH_OWNER,
      repo: GH_REPO,
      name,
      color,
      description,
    });
    console.log(`  Created label "${name}".`);
  } catch (e) {
    if (e.status === 422) return; // already exists – fine
    console.warn(`  WARN: Could not create label "${name}": ${e.message}`);
  }
}

/**
 * Ensures the base "crowdin" label exists.
 */
async function ensureCrowdinLabel() {
  await ensureLabel(CROWDIN_LABEL, '1f883d', 'Synced automatically from Crowdin');
}

/**
 * Fetches ALL GitHub issues (open and closed) that carry the crowdin label
 * and returns a Map keyed by "projectId:issueId" derived from each issue's
 * deduplication marker.
 *
 * @returns {Promise<Map<string, object>>}
 */
async function loadExistingGithubIssues() {
  const map = new Map();

  const items = await octokit.paginate(octokit.rest.issues.listForRepo, {
    owner: GH_OWNER,
    repo: GH_REPO,
    labels: CROWDIN_LABEL,
    state: 'all',
    per_page: 100,
  });

  for (const item of items) {
    if (item.pull_request) continue; // the /issues endpoint also returns PRs
    const m = item.body && MARKER_RE.exec(item.body);
    if (m) {
      map.set(`${m[1]}:${m[2]}`, item); // key: "projectId:issueId"
    }
  }

  return map;
}

/**
 * Creates a new GitHub issue with the given labels.
 *
 * @param {string}   title
 * @param {string}   body
 * @param {string[]} labels  Label names to apply (must already exist).
 * @returns {Promise<object>}  Created issue object.
 */
async function createGithubIssue(title, body, labels) {
  const { data } = await octokit.rest.issues.create({
    owner: GH_OWNER,
    repo: GH_REPO,
    title,
    body,
    labels,
  });
  return data;
}

/**
 * Adds assignees to an existing GitHub issue.
 * Must be called after the issue body has been posted so that GitHub
 * recognizes the @mentions and permits the assignment.
 *
 * @param {number}   issueNumber
 * @param {string[]} assignees    GitHub usernames to assign (may be empty).
 * @returns {Promise<void>}
 */
async function addGithubAssignees(issueNumber, assignees) {
  if (assignees.length === 0) return;
  await octokit.rest.issues.addAssignees({
    owner: GH_OWNER,
    repo: GH_REPO,
    issue_number: issueNumber,
    assignees,
  });
}

/**
 * Applies a partial update (PATCH) to an existing GitHub issue.
 *
 * @param {number} issueNumber  GitHub issue number.
 * @param {object} patch        Fields to update.
 * @returns {Promise<object>}   Updated issue object.
 */
async function updateGithubIssue(issueNumber, patch) {
  const { data } = await octokit.rest.issues.update({
    owner: GH_OWNER,
    repo: GH_REPO,
    issue_number: issueNumber,
    ...patch,
  });
  return data;
}

// Issue body formatting

const TYPE_MAP = {
  general_question: 'General Question',
  translation_mistake: 'Translation Mistake',
  context_request: 'Context Request',
  source_mistake: 'Source Mistake',
};

/**
 * Returns the language managers for a given Crowdin language ID.
 * Crowdin may use either hyphens (e.g. "pt-BR") or underscores ("pt_BR");
 * both are normalized to hyphens when looking up the managers map.
 *
 * @param {string|null|undefined} languageId  Crowdin language ID.
 * @returns {Array<{discord: string, crowdin: string, github: string|null}>}
 */
function getLanguageManagers(languageId) {
  if (!languageId) return [];
  // Normalize separator: Crowdin sometimes returns "pt_BR"; the JSON uses "pt-BR".
  const normalised = languageId.replace('_', '-');
  return languageManagers[normalised] ?? languageManagers[languageId] ?? [];
}

/**
 * Returns the GitHub usernames of all managers for a language that have a
 * non-null github field. Used to populate issue assignees.
 *
 * @param {string|null|undefined} languageId
 * @returns {string[]}
 */
function getGithubAssignees(languageId) {
  return getLanguageManagers(languageId)
    .map((m) => m.github)
    .filter(Boolean);
}

/**
 * Returns the label name for a Crowdin issue type.
 * Format: "type:<slug>" where slug replaces underscores/spaces with hyphens.
 *
 * @param {string} issueType  Raw Crowdin issue type string.
 * @returns {string}
 */
function getTypeLabel(issueType) {
  return `type:${issueType.toLowerCase().replaceAll('_', '-')}`;
}

/**
 * Returns the language label name(s) for a Crowdin language ID.
 * A compound language like "pt-BR" produces two labels: ["lang:pt", "lang:pt-BR"].
 * A simple language like "fr" produces one label: ["lang:fr"].
 *
 * @param {string|null|undefined} languageId
 * @returns {string[]}
 */
function getLanguageLabels(languageId) {
  if (!languageId) return [];
  const normalised = languageId.replace('_', '-');
  const parts = normalised.split('-');
  const labels = [`lang:${parts[0]}`];
  if (parts.length > 1) labels.push(`lang:${normalised}`);
  return labels;
}

/**
 * Returns the full sorted list of GitHub label names for a Crowdin issue.
 * Always includes the base "crowdin" label plus type and language labels.
 *
 * @param {object} crowdinIssue
 * @returns {string[]}
 */
function buildIssueLabels(crowdinIssue) {
  return [
    CROWDIN_LABEL,
    getTypeLabel(crowdinIssue.issueType),
    ...getLanguageLabels(crowdinIssue.languageId),
  ];
}

/**
 * Ensures all labels required for a Crowdin issue exist in the repository.
 *
 * @param {object} crowdinIssue
 * @returns {Promise<void>}
 */
async function ensureIssueLabels(crowdinIssue) {
  const typeLabel = getTypeLabel(crowdinIssue.issueType);
  const typeName = TYPE_MAP[crowdinIssue.issueType] ?? crowdinIssue.issueType;
  await ensureLabel(typeLabel, TYPE_LABEL_COLOR, typeName);

  for (const langLabel of getLanguageLabels(crowdinIssue.languageId)) {
    await ensureLabel(langLabel, LANG_LABEL_COLOR, `Language: ${langLabel.slice(5)}`);
  }
}

/**
 * Builds the GitHub issue title from a Crowdin issue object.
 * The title is just the (truncated) issue description — type and language
 * are expressed as labels instead.
 *
 * @param {object} crowdinIssue
 * @returns {string}
 */
function buildIssueTitle(crowdinIssue) {
  return (crowdinIssue.text ?? '')
    .replaceAll(/[\r\n]+/g, ' ')
    .slice(0, 72);
}

/**
 * Builds the GitHub issue body from a Crowdin issue object.
 * The hidden marker at the bottom is required for deduplication – do not
 * remove it.
 *
 * @param {object}        crowdinIssue
 * @param {string|number} projectId    Numeric project ID (used in the marker).
 * @param {string}        projectSlug  Crowdin project identifier (URL slug).
 * @returns {string}
 */
function buildIssueBody(crowdinIssue, projectId, projectSlug) {
  const type = TYPE_MAP[crowdinIssue.issueType] ?? crowdinIssue.issueType;
  const lang = crowdinIssue.languageId ?? '—';

  const reporter = crowdinIssue.user?.username
    ? `[@${crowdinIssue.user.username}](https://crowdin.com/profile/${crowdinIssue.user.username})`
    : (crowdinIssue.user?.fullName ?? '—');

  const created = crowdinIssue.createdAt
    ? new Date(crowdinIssue.createdAt).toUTCString()
    : '—';

  // Extra string-level metadata when available.
  const filePath = crowdinIssue.string?.file?.path ?? crowdinIssue.string?.filePath ?? null;
  const stringIdentifier = crowdinIssue.string?.identifier ?? null;

  // Render the source string if available.
  let sourceString;
  if (crowdinIssue.string?.text) {
    sourceString = `\`\`\`\n${crowdinIssue.string.text}\n\`\`\``;
  } else {
    sourceString = '_(unavailable)_';
  }

  // Build the deep-link URL. If we have the slug, link straight to the string
  // in the Crowdin editor for that language; otherwise fall back to the project page.
  // The numeric project ID is never used in URLs as it does not resolve on crowdin.com.
  const stringId = crowdinIssue.string?.id;
  let crowdinUrl;
  if (projectSlug && crowdinIssue.languageId && stringId) {
    crowdinUrl = `https://crowdin.com/editor/${projectSlug}/${crowdinIssue.languageId}#${stringId}`;
  } else if (projectSlug) {
    crowdinUrl = `https://crowdin.com/project/${projectSlug}`;
  } else {
    crowdinUrl = null;
  }

  // Build the language managers section.
  const managers = getLanguageManagers(crowdinIssue.languageId);
  let managersSection = '';
  if (managers.length > 0) {
    const managerLines = managers.map((m) => {
      const crowdinLink = `[${m.crowdin}](https://crowdin.com/profile/${m.crowdin})`;
      const githubMention = m.github ? `@${m.github}` : m.discord;
      return `- ${githubMention} (Crowdin: ${crowdinLink})`;
    });
    managersSection = ['### Language Managers', '', ...managerLines, ''].join('\n');
  }

  // Hidden deduplication marker – must remain the last line of the body.
  const marker = `<!-- crowdin-issue-id:${projectId}:${crowdinIssue.id} -->`;

  // Build the table rows, only including optional rows when data is available.
  const tableRows = [
    `| **Type** | ${type} |`,
    `| **Language** | ${lang} |`,
    `| **Reporter** | ${reporter} |`,
    `| **Created** | ${created} |`,
    `| **Crowdin ID** | ${crowdinIssue.id} |`,
  ];
  if (filePath) tableRows.push(`| **File** | \`${filePath}\` |`);
  if (stringIdentifier) tableRows.push(`| **String ID** | \`${stringIdentifier}\` |`);

  return [
    '## Crowdin Issue',
    '',
    '| Field | Value |',
    '|-------|-------|',
    ...tableRows,
    '',
    '### Source String',
    '',
    sourceString,
    '',
    '### Issue Description',
    '',
    crowdinIssue.text ?? '_(no description provided)_',
    '',
    '---',
    '',
    ...(managersSection ? [managersSection] : []),
    ...(crowdinUrl ? [`🔗 [View on Crowdin](${crowdinUrl})`, ''] : []),
    marker,
  ].join('\n');
}

// Sync logic

/**
 * Syncs an existing GitHub issue against the current Crowdin issue state.
 * Updates the body if stale, and opens/closes the issue to match Crowdin.
 *
 * @param {object}        ghIssue       Existing GitHub issue object from the map.
 * @param {object}        crowdinIssue  Current Crowdin issue data.
 * @param {string|number} projectId     Numeric project ID.
 * @param {string}        projectSlug   Crowdin project identifier (URL slug).
 */
async function syncExistingIssue(ghIssue, crowdinIssue, projectId, projectSlug) {
  const ghOpen = ghIssue.state === 'open';
  const isResolved = crowdinIssue.issueStatus === 'resolved';

  // Both already in the desired final state — nothing to do.
  if (!ghOpen && isResolved) {
    console.log(`  ✔  In sync  GH #${ghIssue.number} ← Crowdin #${crowdinIssue.id}`);
    return;
  }

  const expectedTitle = buildIssueTitle(crowdinIssue);
  const expectedBody = buildIssueBody(crowdinIssue, projectId, projectSlug);
  const expectedLabels = buildIssueLabels(crowdinIssue);

  // Build a patch containing only changed fields.
  const patch = {};
  if (ghIssue.title !== expectedTitle) patch.title = expectedTitle;
  if (ghIssue.body !== expectedBody) patch.body = expectedBody;

  // Compare label sets (order-independent).
  const currentLabels = (ghIssue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).sort();
  const desiredLabels = [...expectedLabels].sort();
  if (JSON.stringify(currentLabels) !== JSON.stringify(desiredLabels)) {
    patch.labels = expectedLabels;
    // Ensure any new labels exist before applying them.
    await ensureIssueLabels(crowdinIssue);
  }

  if (isResolved && ghOpen) {
    await updateGithubIssue(ghIssue.number, { state: 'closed', state_reason: 'completed', ...patch });
    console.log(`  ✖  Closed   GH #${ghIssue.number} ← Crowdin #${crowdinIssue.id} resolved`);
  } else if (!isResolved && !ghOpen) {
    await updateGithubIssue(ghIssue.number, { state: 'open', ...patch });
    console.log(`  ↺  Reopened GH #${ghIssue.number} ← Crowdin #${crowdinIssue.id} re-opened`);
  } else if (Object.keys(patch).length > 0) {
    await updateGithubIssue(ghIssue.number, patch);
    console.log(`  ✎  Updated  GH #${ghIssue.number} ← Crowdin #${crowdinIssue.id} refreshed`);
  } else {
    console.log(`  ✔  In sync  GH #${ghIssue.number} ← Crowdin #${crowdinIssue.id}`);
  }
}

/**
 * Creates a new GitHub issue for a Crowdin issue, assigns it to language
 * managers, and immediately closes it if already resolved on Crowdin.
 *
 * @param {object}              crowdinIssue
 * @param {string|number}       projectId    Numeric project ID.
 * @param {string}              projectSlug  Crowdin project identifier (URL slug).
 * @param {Map<string, object>} existingMap  Mutated in-place with the new issue.
 * @param {string}              key          Map key for this issue.
 */
async function createNewIssue(crowdinIssue, projectId, projectSlug, existingMap, key) {
  const assignees = getGithubAssignees(crowdinIssue.languageId);
  await ensureIssueLabels(crowdinIssue);
  const gh = await createGithubIssue(
    buildIssueTitle(crowdinIssue),
    buildIssueBody(crowdinIssue, projectId, projectSlug),
    buildIssueLabels(crowdinIssue),
  );
  existingMap.set(key, gh);
  console.log(`  ✚  Created  GH #${gh.number} ← Crowdin #${crowdinIssue.id}`);

  // Assign after creation so GitHub can resolve the @mentions in the body
  // before the assignment request is made.
  await addGithubAssignees(gh.number, assignees);

  if (crowdinIssue.issueStatus === 'resolved') {
    await updateGithubIssue(gh.number, { state: 'closed', state_reason: 'completed' });
    console.log(`  ✖  Closed   GH #${gh.number} ← Crowdin #${crowdinIssue.id} resolved (on create)`);
  }
}

/**
 * Syncs all issues for a single Crowdin project against the pre-loaded map
 * of existing GitHub issues.
 *
 * @param {string|number} projectId
 * @param {Map<string, object>} existingMap  Mutated in-place as issues are created.
 */
async function syncProject(projectId, existingMap) {
  console.log(`\n── Project ${projectId} ──`);

  const [issues, projectSlug] = await Promise.all([
    fetchCrowdinIssues(projectId),
    fetchProjectSlug(projectId),
  ]);
  console.log(`  ${issues.length} issue(s) found in Crowdin.`);

  for (const issue of issues) {
    const key = `${projectId}:${issue.id}`;
    const ghIssue = existingMap.get(key);

    if (ghIssue) {
      await syncExistingIssue(ghIssue, issue, projectId, projectSlug);
    } else {
      await createNewIssue(issue, projectId, projectSlug, existingMap, key);
    }

    // Brief pause to stay well within GitHub's secondary rate limits.
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Entry point

async function main() {
  console.log('=== Crowdin → GitHub Issues Sync ===');
  console.log(`Repository : ${GITHUB_REPOSITORY}`);
  console.log(`Projects   : ${CROWDIN_PROJECT_IDS.join(', ')}`);

  console.log('\nEnsuring label exists...');
  await ensureCrowdinLabel();

  console.log('\nLoading existing GitHub issues with crowdin label...');
  const existingMap = await loadExistingGithubIssues();
  console.log(`  ${existingMap.size} issue(s) already tracked.`);

  for (const projectId of CROWDIN_PROJECT_IDS) {
    await syncProject(projectId, existingMap);
  }

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
  buildIssueTitle,
  buildIssueBody,
  buildIssueLabels,
  fetchCrowdinIssues,
  fetchProjectSlug,
  projectSlugCache,
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
};
