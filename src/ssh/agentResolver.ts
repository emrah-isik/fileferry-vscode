import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Resolves the SSH agent socket path with the following priority:
 * 1. Explicit custom path (user-configured)
 * 2. SSH_AUTH_SOCK environment variable
 * 3. 1Password agent socket (~/.1password/agent.sock)
 * 4. Pageant on Windows, undefined on other platforms
 */
export function resolveAgentSocket(customPath?: string): string | undefined {
  if (customPath) {
    return customPath;
  }

  if (process.env.SSH_AUTH_SOCK) {
    return process.env.SSH_AUTH_SOCK;
  }

  // 1Password SSH agent
  const onePasswordSocket = path.join(os.homedir(), '.1password', 'agent.sock');
  if (fs.existsSync(onePasswordSocket)) {
    return onePasswordSocket;
  }

  // Windows fallback to Pageant
  if (process.platform === 'win32') {
    return 'pageant';
  }

  return undefined;
}
