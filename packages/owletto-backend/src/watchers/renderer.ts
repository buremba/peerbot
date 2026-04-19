/**
 * Template validation for watchers
 */

import Handlebars from 'handlebars';

/**
 * Validates a Handlebars template by attempting to compile it.
 * @param template Template string to validate
 * @returns Validation error message or null if valid
 */
export function validateTemplate(template: string): string | null {
  if (!template || typeof template !== 'string') {
    return 'Template is required';
  }

  if (template.trim().length === 0) {
    return 'Template cannot be empty';
  }

  try {
    Handlebars.precompile(template);
  } catch (e: any) {
    return `Invalid template: ${e.message}`;
  }

  return null;
}
