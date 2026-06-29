/**
 * Shared markdown heading normalization and category matching.
 */

import { CATEGORY_HEADINGS } from '../refine/constants.js';

export function normalizeHeading(heading: string): string {
  return heading.trim().replace(/[:：]\s*$/g, '');
}

export function matchCategory(heading: string): string | null {
  const normalized = normalizeHeading(heading).toLowerCase();
  for (const [category, labels] of Object.entries(CATEGORY_HEADINGS)) {
    for (const label of labels) {
      if (normalized === label.toLowerCase()) return category;
      // Also match "## Current Focus" style where label might be embedded.
      if (normalized.includes(label.toLowerCase())) return category;
    }
  }
  return null;
}
