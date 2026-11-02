/**
 * @fileoverview Unit tests for utils/date-utils.js using node:test and node:assert.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentDate, formatDate, isValidDate } from './date-utils.js';

test('getCurrentDate returns current date in YYYY-MM-DD format', () => {
  const strCurrentDate = getCurrentDate();
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  assert.match(strCurrentDate, dateRegex, 'Should match YYYY-MM-DD format');

  const parsedDate = new Date(strCurrentDate);
  assert.equal(isValidDate(parsedDate), true, 'Current date string should be valid');
});

test('isValidDate verifies valid dates correctly', () => {
  assert.equal(isValidDate(new Date()), true, 'new Date() should be valid');
  assert.equal(isValidDate(new Date('2026-11-01T12:00:00Z')), true, 'ISO Date should be valid');
  assert.equal(isValidDate('2026-11-01'), true, 'Valid date string should be valid');
  assert.equal(isValidDate(1793552238497), true, 'Valid timestamp number should be valid');
});

test('isValidDate handles invalid dates correctly', () => {
  assert.equal(isValidDate(new Date('invalid-date')), false, 'Invalid Date object should return false');
  assert.equal(isValidDate('not-a-date'), false, 'Non-date string should return false');
  assert.equal(isValidDate(NaN), false, 'NaN should return false');
  assert.equal(isValidDate({}), false, 'Empty object should return false');
  assert.equal(isValidDate([]), false, 'Empty array should return false');
  assert.equal(isValidDate(true), false, 'Boolean should return false');
});

test('isValidDate handles empty inputs correctly', () => {
  assert.equal(isValidDate(null), false, 'null should return false');
  assert.equal(isValidDate(undefined), false, 'undefined should return false');
  assert.equal(isValidDate(''), false, 'Empty string should return false');
});

test('formatDate formats valid Date instances and strings to DD-MM-YYYY', () => {
  const testDate = new Date(2026, 10, 1);
  const strFormattedFromDate = formatDate(testDate);
  assert.equal(strFormattedFromDate, '01-11-2026', 'Date instance should format to 01-11-2026');

  const strFormattedFromString = formatDate('2026-11-01');
  assert.equal(strFormattedFromString, '01-11-2026', 'YYYY-MM-DD string should format to 01-11-2026');
});

test('formatDate throws TypeError on invalid dates and empty inputs', () => {
  assert.throws(
    () => formatDate(null),
    { name: 'TypeError', message: 'Invalid date provided' },
    'Should throw TypeError for null'
  );
  assert.throws(
    () => formatDate(undefined),
    { name: 'TypeError', message: 'Invalid date provided' },
    'Should throw TypeError for undefined'
  );
  assert.throws(
    () => formatDate(''),
    { name: 'TypeError', message: 'Invalid date provided' },
    'Should throw TypeError for empty string'
  );
  assert.throws(
    () => formatDate('not-a-date'),
    { name: 'TypeError', message: 'Invalid date provided' },
    'Should throw TypeError for invalid string'
  );
  assert.throws(
    () => formatDate(new Date('invalid')),
    { name: 'TypeError', message: 'Invalid date provided' },
    'Should throw TypeError for invalid Date instance'
  );
});
