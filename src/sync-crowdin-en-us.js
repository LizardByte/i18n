#!/usr/bin/env node
/**
 * Ensures that en_US translations in Crowdin exactly mirror the source strings,
 * and approves them automatically.
 *
 * The script is fully idempotent – each run will:
 *   • Fetch all source strings for each configured project.
 *   • Fetch all existing en_US approvals and translations for the project
 *     upfront (two API calls) and skip strings that are already fully approved,
 *     significantly reducing per-string API usage.
 *   • For strings that need attention: check whether the en_US translation
 *     already exists and matches the source text (including plurals).
 *   • If the translation is missing, add it.
 *   • If the translation exists but is stale, delete it and add the correct one.
 *   • Approve the en_US translation if it is not already approved.
 *
 * Usage:
 *   node src/sync-crowdin-en-us.js
 *
 * Environment variables:
 *   CROWDIN_TOKEN        – Crowdin personal access token
 *   CROWDIN_PROJECT_IDS  – Comma-separated list of Crowdin project IDs
 */

import { fileURLToPath } from 'node:url';
import { Client as CrowdinClient } from '@crowdin/crowdin-api-client';

// Determine whether this module is being run directly.
const _isMain = process.argv[1] === fileURLToPath(import.meta.url);

// Configuration – only validated when run directly.

const CROWDIN_TOKEN = process.env.CROWDIN_TOKEN;

const CROWDIN_PROJECT_IDS = (process.env.CROWDIN_PROJECT_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/* istanbul ignore next */
if (_isMain) {
  if (!CROWDIN_TOKEN) {
    console.error('ERROR: environment variable CROWDIN_TOKEN is required.');
    process.exit(1);
  }

  if (CROWDIN_PROJECT_IDS.length === 0) {
    console.error('ERROR: CROWDIN_PROJECT_IDS environment variable is not set or empty.');
    process.exit(1);
  }
}

/** The Crowdin language ID for American English (the source-mirror language). */
const EN_US = 'en-US';

// Initialize API client
const crowdin = new CrowdinClient({ token: CROWDIN_TOKEN });

// Crowdin helpers

/**
 * Fetches all source strings for a project using the SDK's built-in
 * auto-pagination helper.
 *
 * @param {string|number} projectId
 * @returns {Promise<object[]>}  Unwrapped SourceStrings data objects.
 */
async function fetchSourceStrings(projectId) {
  const response = await crowdin.sourceStringsApi
    .withFetchAll()
    .listProjectStrings(projectId);
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Fetches all existing en_US translations for a specific source string.
 *
 * @param {string|number} projectId
 * @param {number}        stringId
 * @returns {Promise<object[]>}  Unwrapped StringTranslation data objects.
 */
async function fetchTranslations(projectId, stringId) {
  const response = await crowdin.stringTranslationsApi
    .withFetchAll()
    .listStringTranslations(projectId, stringId, EN_US);
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Fetches all existing en_US approvals for a specific source string.
 *
 * @param {string|number} projectId
 * @param {number}        stringId
 * @returns {Promise<object[]>}  Unwrapped Approval data objects.
 */
async function fetchApprovals(projectId, stringId) {
  const response = await crowdin.stringTranslationsApi
    .withFetchAll()
    .listTranslationApprovals(projectId, { stringId, languageId: EN_US });
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Fetches all existing en_US approvals for an entire project in one call.
 *
 * @param {string|number} projectId
 * @returns {Promise<object[]>}  Unwrapped Approval data objects.
 */
async function fetchProjectApprovals(projectId) {
  const response = await crowdin.stringTranslationsApi
    .withFetchAll()
    .listTranslationApprovals(projectId, { languageId: EN_US });
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Fetches all existing en_US translations for an entire project in one call.
 *
 * @param {string|number} projectId
 * @returns {Promise<object[]>}  Unwrapped translation data objects.
 */
async function fetchProjectTranslations(projectId) {
  const response = await crowdin.stringTranslationsApi
    .withFetchAll()
    .listLanguageTranslations(projectId, EN_US);
  return (response.data ?? []).map((item) => item.data);
}

/**
 * Adds a translation for a source string in en_US.
 *
 * @param {string|number} projectId
 * @param {number}        stringId
 * @param {string}        text
 * @param {string|null}   [pluralCategoryName]
 * @returns {Promise<object>}  Created translation data.
 */
async function addTranslation(projectId, stringId, text, pluralCategoryName = null) {
  const request = { stringId, languageId: EN_US, text };
  if (pluralCategoryName) request.pluralCategoryName = pluralCategoryName;
  const { data } = await crowdin.stringTranslationsApi.addTranslation(projectId, request);
  return data;
}

/**
 * Deletes a translation by its ID.
 *
 * @param {string|number} projectId
 * @param {number}        translationId
 * @returns {Promise<void>}
 */
async function deleteTranslation(projectId, translationId) {
  await crowdin.stringTranslationsApi.deleteTranslation(projectId, translationId);
}

/**
 * Approves a translation by adding an approval record.
 *
 * @param {string|number} projectId
 * @param {number}        translationId
 * @returns {Promise<object>}  Created approval data.
 */
async function approveTranslation(projectId, translationId) {
  const { data } = await crowdin.stringTranslationsApi.addApproval(projectId, {
    translationId,
  });
  return data;
}

/**
 * Normalizes source string text to a flat array of {pluralCategoryName, text}
 * entries.  For plain (non-plural) strings a single entry with
 * pluralCategoryName === null is returned.
 *
 * @param {string | object} text  The `text` field from a Crowdin source string.
 * @returns {Array<{pluralCategoryName: string|null, text: string}>}
 */
function normalisedTextEntries(text) {
  if (typeof text === 'string') {
    return [{ pluralCategoryName: null, text }];
  }
  // Plural: text is a plain object like { one: '...', other: '...' }
  return Object.entries(text).map(([category, value]) => ({
    pluralCategoryName: category,
    text: value,
  }));
}

/**
 * Returns a log prefix for a string and optional plural category.
 *
 * @param {number}      stringId
 * @param {string|null} pluralCategoryName
 * @returns {string}
 */
function stringLogPrefix(stringId, pluralCategoryName) {
  const suffix = pluralCategoryName ? ` [${pluralCategoryName}]` : '';
  return `String ${stringId}${suffix}`;
}

/**
 * Ensures the correct en_US translation exists for one plural form (or the
 * plain string) and returns its translation ID.
 *
 * @param {string|number} projectId
 * @param {number}        stringId
 * @param {string}        expectedText
 * @param {string|null}   pluralCategoryName
 * @param {object|null}   existing            Existing translation or null.
 * @returns {Promise<number>}  The translation ID to approve.
 */
async function ensureTranslation(projectId, stringId, expectedText, pluralCategoryName, existing) {
  const prefix = stringLogPrefix(stringId, pluralCategoryName);

  if (existing?.text === expectedText) {
    console.log(`  ✔  ${prefix}: translation matches`);
    return existing.id;
  }

  if (existing) {
    await deleteTranslation(projectId, existing.id);
    const created = await addTranslation(projectId, stringId, expectedText, pluralCategoryName);
    console.log(`  ✎  ${prefix}: translation updated`);
    return created.id;
  }

  const created = await addTranslation(projectId, stringId, expectedText, pluralCategoryName);
  console.log(`  ✚  ${prefix}: translation added`);
  return created.id;
}

/**
 * Determines whether all plural forms (or the single plain form) of a source
 * string already have an approved en_US translation.
 *
 * @param {object}         sourceString
 * @param {Set<number>}    approvedTranslationIds
 * @param {Map<number, Array<{translationId: number, pluralCategoryName: string|null}>>} stringTranslationMap
 *   Maps stringId → array of {translationId, pluralCategoryName} entries for
 *   that string's en_US translations.
 * @returns {boolean}
 */
function isFullyApproved(sourceString, approvedTranslationIds, stringTranslationMap) {
  const expectedEntries = normalisedTextEntries(sourceString.text);
  const translations = stringTranslationMap.get(sourceString.id) ?? [];
  const approvedCategories = new Set(
    translations
      .filter((t) => approvedTranslationIds.has(t.translationId))
      .map((t) => t.pluralCategoryName),
  );
  return expectedEntries.every(({ pluralCategoryName }) =>
    approvedCategories.has(pluralCategoryName),
  );
}

/**
 * Syncs en_US translations for a single source string.
 * Ensures that for every plural form (or the plain text), an exact-match
 * translation exists and is approved.
 *
 * @param {string|number} projectId
 * @param {object}        sourceString  Crowdin source string data object.
 * @returns {Promise<void>}
 */
async function syncStringTranslation(projectId, sourceString) {
  const { id: stringId, text: sourceText } = sourceString;
  const expectedEntries = normalisedTextEntries(sourceText);

  // Fetch existing translations and approvals in parallel.
  const [existingTranslations, existingApprovals] = await Promise.all([
    fetchTranslations(projectId, stringId),
    fetchApprovals(projectId, stringId),
  ]);

  const approvedTranslationIds = new Set(existingApprovals.map((a) => a.translationId));

  // Build a map: pluralCategoryName (or null) → existing translation object.
  const existingByCategory = new Map();
  for (const t of existingTranslations) {
    existingByCategory.set(t.pluralCategoryName ?? null, t);
  }

  for (const { pluralCategoryName, text: expectedText } of expectedEntries) {
    const existing = existingByCategory.get(pluralCategoryName) ?? null;
    const translationId = await ensureTranslation(
      projectId, stringId, expectedText, pluralCategoryName, existing,
    );

    const prefix = stringLogPrefix(stringId, pluralCategoryName);
    if (approvedTranslationIds.has(translationId)) {
      console.log(`  ✔  ${prefix}: already approved`);
    } else {
      await approveTranslation(projectId, translationId);
      console.log(`  ✔  ${prefix}: approved`);
    }
  }
}

/**
 * Syncs all en_US translations for a single Crowdin project.
 * Fetches all approvals and translations upfront to skip already-approved
 * strings without making per-string API calls.
 *
 * @param {string|number} projectId
 * @returns {Promise<void>}
 */
async function syncProject(projectId) {
  console.log(`\n── Project ${projectId} ──`);

  // Fetch source strings and all en_US approvals/translations in parallel.
  const [strings, projectApprovals, projectTranslations] = await Promise.all([
    fetchSourceStrings(projectId),
    fetchProjectApprovals(projectId),
    fetchProjectTranslations(projectId),
  ]);
  console.log(`  ${strings.length} source string(s) found.`);

  // Build a set of approved translation IDs.
  const approvedTranslationIds = new Set(projectApprovals.map((a) => a.translationId));

  // Build a map: stringId → [{translationId, pluralCategoryName}] for all
  // en_US translations in the project, so isFullyApproved can check coverage
  // per-string without cross-string contamination.
  const stringTranslationMap = new Map();
  for (const t of projectTranslations) {
    const sid = t.stringId;
    if (!stringTranslationMap.has(sid)) stringTranslationMap.set(sid, []);
    stringTranslationMap.get(sid).push({
      translationId: t.translationId,
      pluralCategoryName: t.pluralCategoryName ?? null,
    });
  }

  let skipped = 0;
  for (const string of strings) {
    if (isFullyApproved(string, approvedTranslationIds, stringTranslationMap)) {
      skipped++;
      continue;
    }
    await syncStringTranslation(projectId, string);
  }

  if (skipped > 0) {
    console.log(`  ${skipped} string(s) skipped (already fully approved).`);
  }
}

// Entry point

async function main() {
  console.log('=== Crowdin en_US Translation Sync ===');
  console.log(`Projects : ${CROWDIN_PROJECT_IDS.join(', ')}`);

  for (const projectId of CROWDIN_PROJECT_IDS) {
    await syncProject(projectId);
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
  EN_US,
  fetchSourceStrings,
  fetchProjectApprovals,
  fetchProjectTranslations,
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
};
