import { normaliseContext } from './context';

/**
 * vscode-sftp `ignore` / `ignoreFile` → FileFerry `excludedPaths` (feature
 * 35b, Q9/Q10). The source dialect is gitignore-like and relative to the
 * entry's `context`; the target is minimatch over workspace-relative paths,
 * upload-only. Only the subset with the same meaning on both sides is
 * translated (plain names, simple globs, inner-slash paths); everything else
 * is reported by name with a reason — never guessed (PR #1 bug class).
 */

export interface UntranslatablePattern {
  pattern: string;
  reason: string;
}

export interface IgnoreTranslation {
  excludedPaths: string[];
  untranslatable: UntranslatablePattern[];
}

export function parseIgnoreFile(text: string): string[] {
  return text.split(/\r?\n/);
}

export function translateIgnorePatterns(patterns: unknown[], context?: string): IgnoreTranslation {
  const prefix = normaliseContext(context);
  const excludedPaths: string[] = [];
  const untranslatable: UntranslatablePattern[] = [];

  for (const rawPattern of patterns) {
    if (typeof rawPattern !== 'string') {
      untranslatable.push({ pattern: String(rawPattern), reason: 'not a string' });
      continue;
    }
    const pattern = rawPattern.trim();
    if (pattern === '' || pattern.startsWith('#')) {
      continue;
    }
    if (pattern.startsWith('!')) {
      untranslatable.push({ pattern, reason: 'negations (!) are not supported by excludedPaths' });
      continue;
    }
    if (pattern.startsWith('/')) {
      untranslatable.push({ pattern, reason: 'anchored patterns (leading /) have no excludedPaths equivalent; FileFerry matches names at any depth' });
      continue;
    }
    if (pattern.endsWith('/')) {
      untranslatable.push({ pattern, reason: 'directory-only rules (trailing /) have no excludedPaths equivalent; add the bare name to exclude the folder' });
      continue;
    }

    const hasInnerSlash = pattern.includes('/');
    const translated = hasInnerSlash && prefix !== '' && !pattern.startsWith('**/')
      ? `${prefix}/${pattern}`
      : pattern;
    if (!excludedPaths.includes(translated)) {
      excludedPaths.push(translated);
    }
  }

  return { excludedPaths, untranslatable };
}
