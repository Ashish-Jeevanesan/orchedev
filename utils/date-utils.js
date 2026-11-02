/**
 * @fileoverview Date utility functions for date formatting, validation, and retrieval.
 */

/**
 * Checks whether the supplied value is a valid Date instance or parseable date.
 *
 * @param {*} dateInput - The value to inspect.
 * @returns {boolean} True if the input is a valid date, false otherwise.
 */
export function isValidDate(dateInput) {
  if (dateInput === null || dateInput === undefined || dateInput === '' || typeof dateInput === 'boolean') {
    return false;
  }
  if (dateInput instanceof Date) {
    return !Number.isNaN(dateInput.getTime());
  }
  if (typeof dateInput === 'string' || typeof dateInput === 'number') {
    const candidateDate = new Date(dateInput);
    return !Number.isNaN(candidateDate.getTime());
  }
  return false;
}

/**
 * Returns the current date in YYYY-MM-DD format.
 *
 * @returns {string} The formatted current date string (YYYY-MM-DD).
 */
export function getCurrentDate() {
  const currentDate = new Date();
  const strYear = String(currentDate.getFullYear());
  const strMonth = String(currentDate.getMonth() + 1).padStart(2, '0');
  const strDay = String(currentDate.getDate()).padStart(2, '0');
  const strResult = `${strYear}-${strMonth}-${strDay}`;
  return strResult;
}

/**
 * Formats a valid date as DD-MM-YYYY.
 *
 * @param {Date|string|number} dateInput - The valid date to format.
 * @returns {string} The formatted date string (DD-MM-YYYY).
 * @throws {TypeError} If the input is not a valid date.
 */
export function formatDate(dateInput) {
  if (!isValidDate(dateInput)) {
    throw new TypeError('Invalid date provided');
  }

  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    const partsArray = dateInput.split('-');
    const strYear = partsArray[0];
    const strMonth = partsArray[1];
    const strDay = partsArray[2];
    const strFormatted = `${strDay}-${strMonth}-${strYear}`;
    return strFormatted;
  }

  const targetDate = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const strYear = String(targetDate.getFullYear());
  const strMonth = String(targetDate.getMonth() + 1).padStart(2, '0');
  const strDay = String(targetDate.getDate()).padStart(2, '0');
  const strResult = `${strDay}-${strMonth}-${strYear}`;
  return strResult;
}
