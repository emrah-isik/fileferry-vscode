import { ProjectConfig, ProjectServer, ServerType } from '../../models/ProjectConfig';
import { PathMapping } from '../../models/ProjectBinding';
import { AuthMethod, SshCredential } from '../../models/SshCredential';
import { generateId as defaultGenerateId } from '../../utils/uuid';
import { normaliseContext } from './context';
import { parseIgnoreFile, translateIgnorePatterns } from './ignoreTranslator';
import { ParseNotice, SftpJsonEntry } from './parser';

/**
 * vscode-sftp entries → FileFerry config + credentials + report (feature
 * 35b). Pure apart from the two injected prompts (Q13 missing password, Q14
 * relative remotePath) — Esc (undefined) skips, never guesses. Follows the
 * `ConfigMigration` precedent: name de-dup, credentialName fill, explicit
 * defaultServerId. Collisions are additive (Q4): existing servers are never
 * touched, exact duplicates are skipped with a report line, and the default
 * server is only set when none is set.
 */

export interface ImportPrompts {
  /** Q13: returns the password to store, or undefined when the user pressed Esc. */
  askPassword(target: { credentialName: string; username: string; host: string; port: number }): Promise<string | undefined>;
  /** Q14: returns an absolute remote path, or undefined when the user pressed Esc. */
  askRootPath(target: { name: string; relativePath: string }): Promise<string | undefined>;
}

export interface MapperInput {
  entries: SftpJsonEntry[];
  parseNotices: ParseNotice[];
  existingConfig: ProjectConfig | null;
  existingCredentials: SshCredential[];
  /** `ignoreFile` value → file contents, or null when it could not be read. */
  ignoreFiles: Record<string, string | null>;
  generateId?: () => string;
}

export interface CredentialToSave {
  credential: SshCredential;
  password?: string;
  passphrase?: string;
}

export interface ImportedServerSummary {
  serverName: string;
  type: ServerType;
  host: string;
  credentialName: string;
  hopCredentialNames: string[];
  isDefault: boolean;
}

export interface ImportReport {
  imported: ImportedServerSummary[];
  skippedDuplicates: { entry: string; reason: string }[];
  skippedEntries: { entry: string; reason: string }[];
  promptsSkipped: { entry: string; message: string }[];
  untranslatableIgnore: { entry: string; pattern: string; reason: string }[];
  notes: { entry?: string; message: string }[];
  unsupportedOptions: { entry: string; options: string[] }[];
  plaintextPasswordsInSftpJson: boolean;
}

export interface MapResult {
  config: ProjectConfig;
  credentials: CredentialToSave[];
  report: ImportReport;
}

type RawObject = Record<string, unknown>;

const HANDLED_KEYS = new Set([
  'host', 'port', 'username', 'password', 'protocol', 'secure', 'privateKeyPath', 'passphrase', 'agent',
  'interactiveAuth', 'remotePath', 'ignore', 'ignoreFile', 'uploadOnSave', 'remoteTimeOffsetInHours',
  'filePerm', 'dirPerm', 'hop',
]);

const SKIP_REASONS: Record<string, string> = {
  sshConfigPath: "FileFerry's Use SSH config flag reads ~/.ssh/config itself",
  remote: 'remotefs indirection is not supported',
};

const NAME_MIN = 3;
const NAME_MAX = 50;

function isObject(value: unknown): value is RawObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function isAbsoluteRemotePath(value: string): boolean {
  return value.startsWith('/');
}

function isAbsoluteLocalPath(value: string): boolean {
  return /^(\/|\\\\|[A-Za-z]:[\\/])/.test(value.trim());
}

/** Octal permission → decimal 0–511, or undefined when it cannot be read. */
export function parseOctalPermission(value: unknown): number | undefined {
  let digits: string | undefined;
  if (typeof value === 'string') {
    digits = value.trim().replace(/^0o/i, '');
  } else if (typeof value === 'number' && Number.isInteger(value)) {
    const text = String(value);
    if (/^[0-7]{3,4}$/.test(text)) {
      digits = text;
    } else if (value >= 0 && value <= 0o777) {
      return value;
    }
  }
  if (digits === undefined || !/^[0-7]{3,4}$/.test(digits)) { return undefined; }
  const parsed = parseInt(digits, 8);
  return parsed <= 0o777 ? parsed : undefined;
}

/** 3–50 characters, unique (case-insensitive) with `-2`/`-3` suffixes (ConfigMigration precedent). */
class NameRegistry {
  private readonly taken = new Set<string>();

  constructor(initial: Iterable<string>) {
    for (const name of initial) { this.taken.add(name.toLowerCase()); }
  }

  claim(requested: string): string {
    let base = requested.trim();
    if (base.length < NAME_MIN) { base = `${base} server`.trim(); }
    if (base.length > NAME_MAX) { base = base.slice(0, NAME_MAX).trim(); }
    let candidate = base;
    let suffix = 2;
    while (this.taken.has(candidate.toLowerCase())) {
      const tail = `-${suffix++}`;
      candidate = `${base.slice(0, NAME_MAX - tail.length).trim()}${tail}`;
    }
    this.taken.add(candidate.toLowerCase());
    return candidate;
  }
}

interface StageAuth {
  authMethod: AuthMethod;
  privateKeyPath?: string;
  agentSocketPath?: string;
  password?: string;
  passphrase?: string;
  /** vscode-sftp `passphrase: true` — ask at connect time; FileFerry has no equivalent. */
  passphrasePromptOnly: boolean;
  passwordMissing: boolean;
  cannedAnswers: boolean;
}

function resolveAuth(raw: RawObject, sftp: boolean): StageAuth {
  const password = typeof raw.password === 'string' ? raw.password : undefined;
  const privateKeyPath = sftp ? nonEmptyString(raw.privateKeyPath) : undefined;
  const agent = sftp ? nonEmptyString(raw.agent) : undefined;
  if (privateKeyPath) {
    const passphrase = typeof raw.passphrase === 'string' ? raw.passphrase : undefined;
    return { authMethod: 'key', privateKeyPath, passphrase, passphrasePromptOnly: raw.passphrase === true, passwordMissing: false, cannedAnswers: false };
  }
  if (agent) {
    return { authMethod: 'agent', agentSocketPath: agent, passphrasePromptOnly: false, passwordMissing: false, cannedAnswers: false };
  }
  if (sftp && (raw.interactiveAuth === true || Array.isArray(raw.interactiveAuth))) {
    return { authMethod: 'keyboard-interactive', passphrasePromptOnly: false, passwordMissing: false, cannedAnswers: Array.isArray(raw.interactiveAuth) };
  }
  return { authMethod: 'password', password, passphrasePromptOnly: false, passwordMissing: password === undefined, cannedAnswers: false };
}

interface Stage {
  raw: RawObject;
  host: string;
  port: number;
  username: string;
  auth: StageAuth;
  /** 1-based position; the last stage is the target. */
  index: number;
}

function readStage(raw: RawObject, index: number, defaultPort: number, sftp: boolean): Stage | { error: string } {
  const host = nonEmptyString(raw.host);
  if (!host) { return { error: `no "host"` }; }
  const username = nonEmptyString(raw.username);
  if (!username) { return { error: `no "username"` }; }
  const port = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 ? raw.port : defaultPort;
  return { raw, host, port, username, auth: resolveAuth(raw, sftp), index };
}

function credentialKey(stage: Stage): string {
  const { auth } = stage;
  return JSON.stringify([stage.host.toLowerCase(), stage.port, stage.username, auth.authMethod, auth.privateKeyPath, auth.agentSocketPath, auth.password, auth.passphrase]);
}

export async function mapEntries(input: MapperInput, prompts: ImportPrompts): Promise<MapResult> {
  const generateId = input.generateId ?? defaultGenerateId;
  const report: ImportReport = {
    imported: [],
    skippedDuplicates: [],
    skippedEntries: input.parseNotices.map((notice) => ({ entry: notice.entry ?? 'sftp.json', reason: notice.message })),
    promptsSkipped: [],
    untranslatableIgnore: [],
    notes: [],
    unsupportedOptions: [],
    plaintextPasswordsInSftpJson: false,
  };

  const config: ProjectConfig = input.existingConfig
    ? { ...input.existingConfig, servers: { ...input.existingConfig.servers } }
    : { defaultServerId: '', servers: {} };
  const credentials: CredentialToSave[] = [];
  const existingCredentialsById = new Map(input.existingCredentials.map((credential) => [credential.id, credential]));
  const serverNames = new NameRegistry(Object.keys(config.servers));
  const credentialNames = new NameRegistry(input.existingCredentials.map((credential) => credential.name));
  // Hop-less stages with identical connection details share one credential
  // inside the batch (profiles that differ only by remotePath).
  const batchCredentials = new Map<string, SshCredential>();
  const seenWatchers = new Set<RawObject>();
  const note = (entry: string | undefined, message: string): void => { report.notes.push(entry ? { entry, message } : { message }); };

  const identityOf = (server: ProjectServer): string | undefined => {
    const credential = existingCredentialsById.get(server.credentialId)
      ?? credentials.find((saved) => saved.credential.id === server.credentialId)?.credential;
    return credential ? JSON.stringify([credential.host.toLowerCase(), credential.port, credential.username, server.rootPath]) : undefined;
  };

  let defaultCandidate: { serverId: string; uploadOnSave: boolean | undefined } | undefined;
  let firstImported: { serverId: string; uploadOnSave: boolean | undefined } | undefined;

  for (const entry of input.entries) {
    const raw = entry.raw;
    const entryName = entry.name;

    const protocol = nonEmptyString(raw.protocol) ?? 'sftp';
    let type: ServerType;
    if (protocol === 'sftp') {
      type = 'sftp';
    } else if (protocol === 'ftp') {
      type = raw.secure === 'implicit' ? 'ftps-implicit' : (raw.secure === true || raw.secure === 'control') ? 'ftps' : 'ftp';
    } else {
      report.skippedEntries.push({ entry: entryName, reason: `protocol "${protocol}" is not supported (sftp and ftp only)` });
      continue;
    }
    const sftp = type === 'sftp';
    const defaultPort = sftp ? 22 : 21;

    // Stages: the top-level host, then each hop entry; the last stage is the target (feature 18 contract).
    const first = readStage(raw, 1, defaultPort, sftp);
    if ('error' in first) {
      report.skippedEntries.push({ entry: entryName, reason: `${first.error} and was skipped` });
      continue;
    }
    const stages: Stage[] = [first];
    const hopList = Array.isArray(raw.hop) ? raw.hop : isObject(raw.hop) ? [raw.hop] : [];
    if (hopList.length > 0 && !sftp) {
      note(entryName, `hop chain dropped: ${type.toUpperCase()} cannot connect through jump hosts; the server connects to ${first.host} directly`);
    } else {
      let broken: string | undefined;
      hopList.forEach((hop, hopIndex) => {
        if (broken) { return; }
        if (!isObject(hop)) { broken = `hop ${hopIndex + 1} is not an object`; return; }
        const stage = readStage(hop, hopIndex + 2, 22, true);
        if ('error' in stage) { broken = `hop ${hopIndex + 1} has ${stage.error}`; return; }
        stages.push(stage);
      });
      if (broken) {
        report.skippedEntries.push({ entry: entryName, reason: `${broken}; the server was skipped` });
        continue;
      }
    }
    const target = stages[stages.length - 1];
    if (stages.some((stage) => typeof stage.raw.password === 'string')) {
      report.plaintextPasswordsInSftpJson = true;
    }

    // Q14: rootPath must be absolute — prompt, Esc skips this server.
    const remotePathRaw = nonEmptyString(raw.remotePath) ?? './';
    let rootPath: string;
    if (isAbsoluteRemotePath(remotePathRaw)) {
      rootPath = remotePathRaw;
    } else {
      const answer = await prompts.askRootPath({ name: entryName, relativePath: remotePathRaw });
      const trimmed = answer?.trim();
      if (!trimmed || !isAbsoluteRemotePath(trimmed)) {
        report.skippedEntries.push({ entry: entryName, reason: `relative remotePath "${remotePathRaw}" needs an absolute path; none was given` });
        continue;
      }
      rootPath = trimmed;
    }
    rootPath = rootPath.length > 1 ? rootPath.replace(/\/+$/, '') : rootPath;

    // Q4: exact duplicates (host + port + username + remotePath) are skipped.
    const identity = JSON.stringify([target.host.toLowerCase(), target.port, target.username, rootPath]);
    const duplicateOf = Object.entries(config.servers).find(([, server]) => identityOf(server) === identity);
    if (duplicateOf) {
      report.skippedDuplicates.push({ entry: entryName, reason: `already configured as "${duplicateOf[0]}" (same host, port, username, and remote path)` });
      continue;
    }

    const serverName = serverNames.claim(entryName);
    if (serverName !== entryName) {
      note(entryName, `imported as "${serverName}" (the name was taken or out of range)`);
    }

    // Credentials: one per stage; hop-less targets dedupe inside the batch.
    const stageCredentials: SshCredential[] = [];
    const chain = stages.length > 1;
    for (const stage of stages) {
      const isTarget = stage === target;
      const key = credentialKey(stage);
      const shared = !chain ? batchCredentials.get(key) : undefined;
      if (shared) {
        stageCredentials.push(shared);
        continue;
      }
      const credentialName = credentialNames.claim(isTarget ? entryName : `${entryName} hop ${stage.index}`);
      const credential: SshCredential = {
        id: generateId(),
        name: credentialName,
        host: stage.host,
        port: stage.port,
        username: stage.username,
        authMethod: stage.auth.authMethod,
      };
      if (stage.auth.privateKeyPath) { credential.privateKeyPath = stage.auth.privateKeyPath; }
      if (stage.auth.agentSocketPath) { credential.agentSocketPath = stage.auth.agentSocketPath; }
      if (isTarget && chain) { credential.jumpHosts = stageCredentials.map((hop) => hop.id); }

      let password = stage.auth.password;
      if (stage.auth.passwordMissing) {
        password = await prompts.askPassword({ credentialName, username: stage.username, host: stage.host, port: stage.port });
        if (password === undefined) {
          report.promptsSkipped.push({ entry: entryName, message: `no password stored for credential "${credentialName}" (${stage.username}@${stage.host}) — add it in Manage SSH Credentials` });
        }
      }
      if (stage.auth.passphrasePromptOnly) {
        report.promptsSkipped.push({ entry: entryName, message: `credential "${credentialName}": vscode-sftp asked for the key passphrase on every connect (passphrase: true); FileFerry stores it in the keychain instead — add it in Manage SSH Credentials` });
      }
      if (stage.auth.cannedAnswers) {
        note(entryName, `credential "${credentialName}": interactiveAuth canned answers are not carried over; FileFerry prompts for each challenge`);
      }
      if (stage.auth.privateKeyPath) {
        if (stage.index > 1) {
          note(entryName, `credential "${credentialName}" (hop ${stage.index}): vscode-sftp keys on intermediate machines are not supported; the path "${stage.auth.privateKeyPath}" is treated as local`);
        }
        if (!/^[/~]/.test(stage.auth.privateKeyPath)) {
          note(entryName, `credential "${credentialName}": private key path "${stage.auth.privateKeyPath}" does not start with / or ~; the credential panel will ask for an absolute path before it can be edited`);
        }
      }

      credentials.push({ credential, password, passphrase: stage.auth.passphrase });
      if (!chain) { batchCredentials.set(key, credential); }
      stageCredentials.push(credential);
    }
    const targetCredential = stageCredentials[stageCredentials.length - 1];

    // Mapping from context; excludedPaths from ignore + ignoreFile (Q9/Q10).
    const mapping = buildMapping(entry.context, entryName, note);
    const excludedPaths: string[] = [];
    const addPatterns = (patterns: unknown[]): void => {
      const translation = translateIgnorePatterns(patterns, entry.context);
      for (const pattern of translation.excludedPaths) {
        if (!excludedPaths.includes(pattern)) { excludedPaths.push(pattern); }
      }
      for (const untranslatable of translation.untranslatable) {
        report.untranslatableIgnore.push({ entry: entryName, ...untranslatable });
      }
    };
    const unsupported: string[] = [];
    if (raw.ignore !== undefined) {
      if (Array.isArray(raw.ignore)) { addPatterns(raw.ignore); } else { unsupported.push('ignore (not an array)'); }
    }
    const ignoreFile = nonEmptyString(raw.ignoreFile);
    if (ignoreFile) {
      const contents = input.ignoreFiles[ignoreFile];
      if (typeof contents === 'string') {
        addPatterns(parseIgnoreFile(contents));
        note(entryName, `ignoreFile "${ignoreFile}" was inlined into excludedPaths; future edits to that file will not carry over`);
      } else {
        note(entryName, `ignoreFile "${ignoreFile}" could not be read; its patterns were not imported`);
      }
    }

    const server: ProjectServer = {
      id: generateId(),
      type,
      credentialId: targetCredential.id,
      credentialName: targetCredential.name,
      rootPath,
      mappings: [mapping],
      excludedPaths,
    };
    if (typeof raw.uploadOnSave === 'boolean') { server.uploadOnSave = raw.uploadOnSave; }
    if (typeof raw.remoteTimeOffsetInHours === 'number' && Number.isFinite(raw.remoteTimeOffsetInHours)) {
      server.timeOffsetMs = Math.round(raw.remoteTimeOffsetInHours * 3_600_000);
    }
    for (const [key, field] of [['filePerm', 'filePermissions'], ['dirPerm', 'directoryPermissions']] as const) {
      if (raw[key] === undefined) { continue; }
      const parsed = parseOctalPermission(raw[key]);
      if (parsed === undefined) {
        note(entryName, `${key} "${String(raw[key])}" is not an octal mode between 000 and 777; not imported`);
      } else {
        server[field] = parsed;
      }
    }

    // Skip bucket: everything we did not map, named (plus FTP-irrelevant auth keys).
    for (const key of Object.keys(raw).sort()) {
      if (!HANDLED_KEYS.has(key)) {
        unsupported.push(SKIP_REASONS[key] ? `${key} (${SKIP_REASONS[key]})` : key);
      } else if (!sftp && (key === 'privateKeyPath' || key === 'passphrase' || key === 'agent' || key === 'interactiveAuth')) {
        unsupported.push(`${key} (${type.toUpperCase()} uses password authentication)`);
      }
    }
    if (unsupported.length > 0) { report.unsupportedOptions.push({ entry: entryName, options: unsupported.sort() }); }

    // Root-only watcher → the global watch block (once per root; Q16 autoDelete is report-only).
    if (entry.watcher && !seenWatchers.has(entry.watcher)) {
      seenWatchers.add(entry.watcher);
      applyWatcher(entry.watcher, config, entryName, note);
    }

    config.servers[serverName] = server;
    const uploadOnSave = typeof raw.uploadOnSave === 'boolean' ? raw.uploadOnSave : undefined;
    firstImported ??= { serverId: server.id, uploadOnSave };
    if (entry.isDefault && !defaultCandidate) { defaultCandidate = { serverId: server.id, uploadOnSave }; }
    report.imported.push({
      serverName,
      type,
      host: target.host,
      credentialName: targetCredential.name,
      hopCredentialNames: stageCredentials.slice(0, -1).map((hop) => hop.name),
      isDefault: false,
    });
  }

  // Q4/Q11: set the default only when none is set; the effective-default entry then sets the global toggle.
  const chosen = defaultCandidate ?? firstImported;
  if (!config.defaultServerId && chosen) {
    config.defaultServerId = chosen.serverId;
    if (config.uploadOnSave === undefined && chosen.uploadOnSave !== undefined) {
      config.uploadOnSave = chosen.uploadOnSave;
    }
  }
  for (const summary of report.imported) {
    summary.isDefault = config.servers[summary.serverName]?.id === config.defaultServerId;
  }

  return { config, credentials, report };
}

function buildMapping(context: string | undefined, entryName: string, note: (entry: string, message: string) => void): PathMapping {
  if (context && isAbsoluteLocalPath(context)) {
    note(entryName, `absolute context "${context}" cannot be mapped (FileFerry mappings are workspace-relative); mapped to the workspace root instead`);
    return { localPath: '/', remotePath: '' };
  }
  const folder = normaliseContext(context);
  return { localPath: folder ? `/${folder}` : '/', remotePath: '' };
}

function applyWatcher(watcher: RawObject, config: ProjectConfig, entryName: string, note: (entry: string, message: string) => void): void {
  const files = nonEmptyString(watcher.files);
  if (watcher.autoDelete === true) {
    note(entryName, 'watcher.autoDelete is not supported: FileFerry never deletes remote files unattended; use Sync to Remote with delete-extras when you want the server pruned');
  }
  if (!files) {
    note(entryName, 'watcher has no "files" pattern; nothing to watch was imported');
    return;
  }
  if (config.watch) {
    note(entryName, `watcher "${files}" not carried over: the existing watch configuration was kept`);
    return;
  }
  config.watch = { enabled: watcher.autoUpload === true, patterns: [files] };
}
