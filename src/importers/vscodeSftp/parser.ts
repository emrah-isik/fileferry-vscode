/**
 * vscode-sftp `sftp.json` parser (feature 35b, Q1/Q12).
 *
 * The file comes in three shapes — a single object, an array of entries
 * (one per `context`), or one object with `profiles` — and this module
 * flattens all of them into one `SftpJsonEntry` per future FileFerry server.
 * It is pure (string in, entries + notices out) and never guesses: anything
 * it has to drop becomes a notice for the import report.
 */

export interface SftpJsonEntry {
  /** Candidate server name: entry `name`, the profile key, or the host. */
  name: string;
  /** The profile key when the entry came out of `profiles`. */
  profile?: string;
  /** vscode-sftp's active entry: `defaultProfile`, or the first array entry. */
  isDefault: boolean;
  /** Root-only `context` (workspace-relative folder the entry deploys). */
  context?: string;
  /** Root-only `watcher` block, shared by every profile of the entry. */
  watcher?: Record<string, unknown>;
  /** The merged option object (profile onto root), root-only keys removed. */
  raw: Record<string, unknown>;
}

export interface ParseNotice {
  entry?: string;
  message: string;
}

export interface ParseResult {
  entries: SftpJsonEntry[];
  notices: ParseNotice[];
}

export class SftpJsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SftpJsonParseError';
  }
}

// Keys vscode-sftp only honours at the root of an entry — a profile that sets
// them is ignored there, so we drop them with a notice rather than merge.
const ROOT_ONLY_KEYS = ['name', 'context', 'watcher', 'defaultProfile', 'profiles'] as const;

type RawObject = Record<string, unknown>;

function isObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * VS Code opens `.vscode/*.json` as JSONC, so a hand-edited sftp.json may
 * carry comments and trailing commas that `JSON.parse` rejects. Strip them
 * outside string literals only.
 */
export function stripJsonComments(text: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const character = text[index];
    const next = text[index + 1];
    if (inString) {
      output += character;
      if (character === '\\' && index + 1 < text.length) {
        output += next;
        index += 2;
        continue;
      }
      if (character === '"') { inString = false; }
      index++;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index++;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    output += character;
    index++;
  }
  // Trailing commas before a closing bracket/brace.
  return output.replace(/,(\s*[}\]])/g, '$1');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripJsonComments(text));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SftpJsonParseError(`sftp.json is not valid JSON: ${message}`);
    }
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function displayName(entry: RawObject): string | undefined {
  return stringOrUndefined(entry.name) ?? stringOrUndefined(entry.host);
}

function withoutKeys(object: RawObject, keys: readonly string[]): RawObject {
  const copy: RawObject = {};
  for (const [key, value] of Object.entries(object)) {
    if (!keys.includes(key)) { copy[key] = value; }
  }
  return copy;
}

/** Expands one root entry (single object or array element) into its profiles. */
function expandEntry(
  root: RawObject,
  options: { name: string; isDefault: boolean; profileNamePrefix: string | undefined },
  notices: ParseNotice[]
): SftpJsonEntry[] {
  const context = stringOrUndefined(root.context);
  const watcher = isObject(root.watcher) ? root.watcher : undefined;
  const base = withoutKeys(root, ROOT_ONLY_KEYS);

  const profiles = isObject(root.profiles) && Object.keys(root.profiles).length > 0 ? root.profiles : undefined;
  if (!profiles) {
    return [{ name: options.name, isDefault: options.isDefault, context, watcher, raw: base }];
  }

  const defaultProfile = stringOrUndefined(root.defaultProfile);
  if (defaultProfile !== undefined && !(defaultProfile in profiles)) {
    notices.push({ entry: options.name, message: `defaultProfile "${defaultProfile}" names no profile; no profile marked as the default` });
  }

  const entries: SftpJsonEntry[] = [];
  for (const [profileKey, profile] of Object.entries(profiles)) {
    const entryName = options.profileNamePrefix ? `${options.profileNamePrefix} ${profileKey}` : profileKey;
    if (!isObject(profile)) {
      notices.push({ entry: entryName, message: `profile "${profileKey}" is not an object and was skipped` });
      continue;
    }
    const rootOnlyInProfile = Object.keys(profile).filter((key) => (ROOT_ONLY_KEYS as readonly string[]).includes(key)).sort();
    if (rootOnlyInProfile.length > 0) {
      notices.push({
        entry: entryName,
        message: `profile "${profileKey}": ${rootOnlyInProfile.join(', ')} ignored (root-only in vscode-sftp, not applied per profile)`,
      });
    }
    entries.push({
      name: entryName,
      profile: profileKey,
      isDefault: defaultProfile === profileKey,
      context,
      watcher,
      raw: { ...base, ...withoutKeys(profile, ROOT_ONLY_KEYS) },
    });
  }
  return entries;
}

export function parseSftpJson(text: string): ParseResult {
  const parsed = parseJson(text);
  const notices: ParseNotice[] = [];
  const entries: SftpJsonEntry[] = [];

  if (Array.isArray(parsed)) {
    let firstValid = true;
    parsed.forEach((element, index) => {
      if (!isObject(element)) {
        notices.push({ message: `entry ${index + 1} is not an object and was skipped` });
        return;
      }
      const name = displayName(element);
      if (name === undefined) {
        notices.push({ message: `entry ${index + 1} has no "name" and no "host" and was skipped` });
        return;
      }
      if (stringOrUndefined(element.name) === undefined) {
        notices.push({ entry: name, message: `entry ${index + 1} has no "name"; the host "${name}" is used as its name` });
      }
      entries.push(...expandEntry(element, { name, isDefault: firstValid, profileNamePrefix: name }, notices));
      firstValid = false;
    });
    return { entries, notices };
  }

  if (!isObject(parsed)) {
    throw new SftpJsonParseError('sftp.json must be an object or an array of objects');
  }

  const name = displayName(parsed);
  if (name === undefined) {
    throw new SftpJsonParseError('sftp.json has neither "name" nor "host" — nothing to import');
  }
  entries.push(...expandEntry(parsed, { name, isDefault: true, profileNamePrefix: undefined }, notices));
  return { entries, notices };
}
