import { resolveAgentSocket } from '../../../ssh/agentResolver';
import * as fs from 'fs';
import * as os from 'os';

jest.mock('fs');
jest.mock('os');

describe('resolveAgentSocket', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SSH_AUTH_SOCK;
    (os.homedir as jest.Mock).mockReturnValue('/home/testuser');
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns custom socket path when provided', () => {
    const result = resolveAgentSocket('/custom/agent.sock');
    expect(result).toBe('/custom/agent.sock');
  });

  it('returns SSH_AUTH_SOCK when set', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-abc/agent.123';
    const result = resolveAgentSocket();
    expect(result).toBe('/tmp/ssh-abc/agent.123');
  });

  it('discovers 1Password agent socket when SSH_AUTH_SOCK is not set', () => {
    (fs.existsSync as jest.Mock).mockImplementation((p: string) =>
      p === '/home/testuser/.1password/agent.sock'
    );
    const result = resolveAgentSocket();
    expect(result).toBe('/home/testuser/.1password/agent.sock');
  });

  it('returns pageant on Windows when no socket found', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const result = resolveAgentSocket();
    expect(result).toBe('pageant');
  });

  it('returns undefined on non-Windows when no socket found', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const result = resolveAgentSocket();
    expect(result).toBeUndefined();
  });

  it('prefers custom path over SSH_AUTH_SOCK', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-abc/agent.123';
    const result = resolveAgentSocket('/custom/agent.sock');
    expect(result).toBe('/custom/agent.sock');
  });

  it('prefers SSH_AUTH_SOCK over 1Password discovery', () => {
    process.env.SSH_AUTH_SOCK = '/tmp/ssh-abc/agent.123';
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const result = resolveAgentSocket();
    expect(result).toBe('/tmp/ssh-abc/agent.123');
  });
});
