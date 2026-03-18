/**
 * Shared utilities used across Crowdin sync scripts.
 */

/**
 * Parses the CROWDIN_PROJECT_IDS environment variable into an array of
 * trimmed, non-empty strings.
 *
 * @returns {string[]}
 */
function parseCrowdinProjectIds() {
  return (process.env.CROWDIN_PROJECT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validates that every listed environment variable is set and that
 * CROWDIN_PROJECT_IDS contains at least one entry.  Exits the process with
 * code 1 on the first failure.
 *
 * Only intended to be called when a script is run directly (i.e. `_isMain`).
 *
 * @param {string[]} requiredEnvVars  Names of environment variables that must be non-empty.
 * @param {string[]} projectIds       Result of {@link parseCrowdinProjectIds}.
 */
function validateEnv(requiredEnvVars, projectIds) {
  for (const name of requiredEnvVars) {
    if (process.env[name]) continue;
    console.error(`ERROR: environment variable ${name} is required.`);
    process.exit(1);
  }

  if (projectIds.length === 0) {
    console.error('ERROR: CROWDIN_PROJECT_IDS environment variable is not set or empty.');
    process.exit(1);
  }
}

export { parseCrowdinProjectIds, validateEnv };
