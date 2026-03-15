import { describe, expect, it } from '@jest/globals';
import { createRequire } from 'node:module';
import { validateLanguageManagers } from '../src/validate-language-managers.js';

const _require = createRequire(import.meta.url);
const schema = _require('../schemas/language-managers.schema.json');

// Helpers

/** A valid data object that satisfies the schema. */
const VALID_DATA = {
  'aa': [],
  'xx': [
    { discord: 'fake-discord', crowdin: 'fake-crowdin', github: 'fake-github' },
  ],
  'yy': [
    { discord: 'fake-discord-a', crowdin: 'fake-crowdin-a', github: 'fake-github-a' },
    { discord: 'fake-discord-b', crowdin: 'fake-crowdin-b', github: 'fake-github-b' },
  ],
  'zz-AA': [
    { discord: 'fake-discord-c', crowdin: 'fake-crowdin-c', github: null },
  ],
};

// validateLanguageManagers

describe('validateLanguageManagers', () => {
  it('returns valid=true for a well-formed data object', () => {
    const { valid, errors } = validateLanguageManagers(VALID_DATA, schema);
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('returns valid=true for a language with an empty managers array', () => {
    const { valid } = validateLanguageManagers({ 'aa': [] }, schema);
    expect(valid).toBe(true);
  });

  it('returns valid=true when github is null', () => {
    const data = { 'xx': [{ discord: 'a', crowdin: 'b', github: null }] };
    const { valid } = validateLanguageManagers(data, schema);
    expect(valid).toBe(true);
  });

  it('returns valid=false when a required field (discord) is missing', () => {
    const data = { 'xx': [{ crowdin: 'fake-crowdin', github: 'fake-github' }] };
    const { valid, errors } = validateLanguageManagers(data, schema);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns valid=false when a required field (crowdin) is missing', () => {
    const data = { 'xx': [{ discord: 'fake-discord', github: 'fake-github' }] };
    const { valid, errors } = validateLanguageManagers(data, schema);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns valid=false when a required field (github) is missing', () => {
    const data = { 'xx': [{ discord: 'fake-discord', crowdin: 'fake-crowdin' }] };
    const { valid, errors } = validateLanguageManagers(data, schema);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns valid=false when a string field is empty', () => {
    const data = { 'xx': [{ discord: '', crowdin: 'fake-crowdin', github: 'fake-github' }] };
    const { valid, errors } = validateLanguageManagers(data, schema);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns valid=false when an extra property is present on a manager entry', () => {
    const data = { 'xx': [{ discord: 'a', crowdin: 'b', github: 'c', extra: 'oops' }] };
    const { valid, errors } = validateLanguageManagers(data, schema);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns valid=false when a language entry is not an array', () => {
    const data = { 'xx': { discord: 'a', crowdin: 'b', github: 'c' } };
    const { valid, errors } = validateLanguageManagers(data, schema);
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('returns all errors when allErrors=true (multiple violations)', () => {
    // Missing all three required fields on two manager entries.
    const data = { 'xx': [{}, {}] };
    const { valid, errors } = validateLanguageManagers(data, schema);
    expect(valid).toBe(false);
    // Each empty object is missing discord, crowdin, and github → ≥6 errors.
    expect(errors.length).toBeGreaterThanOrEqual(6);
  });
});
