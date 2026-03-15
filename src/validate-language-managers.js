#!/usr/bin/env node
/**
 * Validates language-managers.json against schemas/language-managers.schema.json.
 *
 * Exits with code 1 and prints errors if validation fails.
 * Exits with code 0 if the file is valid.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv from 'ajv';

const _require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Determine whether this module is being run directly.
const _isMain = process.argv[1] === fileURLToPath(import.meta.url);

/**
 * Validates a language-managers data object against the schema.
 *
 * @param {object} data    Parsed contents of language-managers.json.
 * @param {object} schema  Parsed contents of language-managers.schema.json.
 * @returns {{ valid: boolean, errors: import('ajv').ErrorObject[] }}
 */
function validateLanguageManagers(data, schema) {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);
  const valid = validate(data);
  return { valid, errors: validate.errors ?? [] };
}

/* istanbul ignore next */
if (_isMain) {
  const schema = _require(path.join(root, 'schemas', 'language-managers.schema.json'));
  const data = _require(path.join(root, 'language-managers.json'));

  const { valid, errors } = validateLanguageManagers(data, schema);

  if (!valid) {
    console.error('language-managers.json failed schema validation:');
    for (const err of errors) {
      console.error(`  ${err.instancePath || '(root)'} ${err.message}`);
    }
    process.exit(1);
  }

  console.log('language-managers.json is valid.');
}

export { validateLanguageManagers };
