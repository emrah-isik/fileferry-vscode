// Pure helpers for resolving ${secret:NAME} references in hook commands (#27b).
// Resolution is the LAST step before a command runs — everything shown to the
// user (dialogs, logs, dry-run) keeps the unresolved token. The two dispatch
// paths differ deliberately:
//   local  → the value goes into the spawn environment and the token is
//            rewritten to a shell variable reference, so the value never
//            enters the command string;
//   remote → the value is substituted inline (most sshd configs reject
//            client-set env vars via AcceptEnv), briefly visible in the
//            server's `ps` — documented, never logged.

const SECRET_TOKEN_PATTERN = /\$\{secret:([^}]*)\}/g;
const VALID_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SecretReferenceScan {
  // Valid names, unique, in order of first appearance.
  names: string[];
  // Token names that cannot be an environment variable name (e.g. "BAD-NAME").
  invalidNames: string[];
}

export function findSecretReferences(command: string): SecretReferenceScan {
  const names: string[] = [];
  const invalidNames: string[] = [];
  for (const match of command.matchAll(SECRET_TOKEN_PATTERN)) {
    const name = match[1];
    const target = VALID_NAME_PATTERN.test(name) ? names : invalidNames;
    if (!target.includes(name)) {
      target.push(name);
    }
  }
  return { names, invalidNames };
}

// How the user's shell spells "expand this environment variable". The shell
// argument mirrors HookRunner's spawn option: a path from vscode.env.shell, or
// `true` for Node's platform default (cmd.exe on Windows, /bin/sh elsewhere).
export function shellVariableReference(
  name: string,
  shell: string | boolean,
  platform: NodeJS.Platform = process.platform
): string {
  if (typeof shell === 'string') {
    const executable = shell.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
    if (executable === 'pwsh' || executable.includes('powershell')) {
      return `$env:${name}`;
    }
    if (executable === 'cmd') {
      return `%${name}%`;
    }
    return `$${name}`;
  }
  return platform === 'win32' ? `%${name}%` : `$${name}`;
}

// Local hooks: each ${secret:NAME} becomes a shell variable reference and the
// value rides in an environment overlay for spawn — never in the string.
export function resolveLocalCommand(
  command: string,
  values: ReadonlyMap<string, string>,
  shell: string | boolean,
  platform: NodeJS.Platform = process.platform
): { command: string; environmentOverlay: Record<string, string> } {
  const environmentOverlay: Record<string, string> = {};
  const rewritten = command.replace(SECRET_TOKEN_PATTERN, (token, name: string) => {
    const value = values.get(name);
    if (value === undefined) {
      return token;
    }
    environmentOverlay[name] = value;
    return shellVariableReference(name, shell, platform);
  });
  return { command: rewritten, environmentOverlay };
}

// Remote hooks: inline substitution at exec time. The caller must never log
// the returned string.
export function resolveRemoteCommand(
  command: string,
  values: ReadonlyMap<string, string>
): string {
  return command.replace(SECRET_TOKEN_PATTERN, (token, name: string) => {
    const value = values.get(name);
    return value === undefined ? token : value;
  });
}
