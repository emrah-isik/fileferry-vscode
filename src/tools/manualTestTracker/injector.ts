// Injects a parsed plan into the static tracker template. Pure: strings in,
// string out. The template stays valid JavaScript while unpopulated because
// the marker reads as `/*__DATA__*/null`.
import { TrackerData } from './parser';

export const DATA_MARKER = '/*__DATA__*/null';

export function injectTrackerData(templateHtml: string, data: TrackerData): string {
  const occurrences = templateHtml.split(DATA_MARKER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly one ${DATA_MARKER} marker in the template, found ${occurrences}`
    );
  }
  // Escape < (and the JS line separators) so plan text can never terminate the
  // <script> block or break the inline source.
  const json = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return templateHtml.replace(DATA_MARKER, json);
}
