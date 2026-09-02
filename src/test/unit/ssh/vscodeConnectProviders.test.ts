import * as vscode from 'vscode';
import { VscodeHostKeyProvider, VscodeKeyboardInteractiveProvider } from '../../../ssh/vscodeConnectProviders';
import { HostKeyManager } from '../../../ssh/HostKeyManager';
import * as hostKeyPrompt from '../../../ssh/hostKeyPrompt';
import { driveSsh2HostVerifier } from '../../helpers/driveSsh2HostVerifier';

jest.mock('../../../ssh/HostKeyManager');
jest.mock('../../../ssh/hostKeyPrompt');

const mockHostKeyManager = {
  check: jest.fn(),
  trust: jest.fn(),
  getFingerprint: jest.fn(),
};
(HostKeyManager as jest.Mock).mockImplementation(() => mockHostKeyManager);

const target = { host: 'example.com', port: 22 };
const flushMicrotasks = async () => { for (let i = 0; i < 10; i++) { await Promise.resolve(); } };

describe('VscodeKeyboardInteractiveProvider', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('marks the prompt as opened before showing input boxes and returns the answers', async () => {
    const context = { promptOpened: jest.fn() };
    (vscode.window.showInputBox as jest.Mock).mockImplementation(async () => {
      expect(context.promptOpened).toHaveBeenCalled();
      return '123456';
    });
    const provider = new VscodeKeyboardInteractiveProvider();

    const answers = await provider.prompt({
      target: { username: 'u', ...target }, round: 1, name: '', instructions: '',
      prompts: [{ prompt: 'Verification code: ', echo: false }],
    }, context);

    expect(answers).toEqual(['123456']);
    expect(vscode.window.showInputBox).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Verification code: ', password: true }));
  });

  it('titles the input boxes with the asking identity — a chain prompts for hops AND the target (18a-2a)', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue('mfapass');
    const provider = new VscodeKeyboardInteractiveProvider();

    await provider.prompt({
      target: { username: 'mfauser', host: '127.0.0.1', port: 2222 }, round: 1, name: '', instructions: '',
      prompts: [{ prompt: 'Password: ', echo: false }],
    }, { promptOpened: jest.fn() });

    expect(vscode.window.showInputBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'SSH login: mfauser@127.0.0.1:2222',
    }));
  });

  it('returns null when the user dismisses an input box', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);
    const provider = new VscodeKeyboardInteractiveProvider();

    const answers = await provider.prompt({
      target: { username: 'u', ...target }, round: 1, name: '', instructions: '',
      prompts: [{ prompt: 'Code: ', echo: false }],
    }, { promptOpened: jest.fn() });

    expect(answers).toBeNull();
  });
});

describe('VscodeHostKeyProvider — driven the way ssh2 drives it', () => {
  let provider: VscodeHostKeyProvider;
  let log: jest.Mock;
  let context: { promptOpened: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockHostKeyManager.getFingerprint.mockReturnValue('SHA256:abc');
    mockHostKeyManager.trust.mockResolvedValue(undefined);
    log = jest.fn();
    context = { promptOpened: jest.fn() };
    provider = new VscodeHostKeyProvider(new HostKeyManager('/storage'), log);
  });

  const verify = (key: Buffer) =>
    driveSsh2HostVerifier((k, verdict) => provider.verify(target, k, context, verdict), key);

  it('ACCEPTS a trusted key silently — no prompt, timer untouched', async () => {
    mockHostKeyManager.check.mockResolvedValue('trusted');
    expect(await verify(Buffer.from('k'))).toBe(true);
    expect(hostKeyPrompt.showHostKeyPrompt).not.toHaveBeenCalled();
    expect(context.promptOpened).not.toHaveBeenCalled();
  });

  it('prompts for an unknown key, cancels the pre-prompt timer, trusts on accept', async () => {
    mockHostKeyManager.check.mockResolvedValue('unknown');
    (hostKeyPrompt.showHostKeyPrompt as jest.Mock).mockResolvedValue(true);
    expect(await verify(Buffer.from('newkey'))).toBe(true);
    expect(context.promptOpened).toHaveBeenCalled();
    expect(hostKeyPrompt.showHostKeyPrompt).toHaveBeenCalledWith('example.com', 22, 'SHA256:abc', 'unknown');
    expect(mockHostKeyManager.trust).toHaveBeenCalledWith('example.com', 22, Buffer.from('newkey').toString('base64'));
  });

  it('REJECTS an unknown key the user declines and stores nothing', async () => {
    mockHostKeyManager.check.mockResolvedValue('unknown');
    (hostKeyPrompt.showHostKeyPrompt as jest.Mock).mockResolvedValue(false);
    expect(await verify(Buffer.from('newkey'))).toBe(false);
    expect(mockHostKeyManager.trust).not.toHaveBeenCalled();
  });

  it('REJECTS a changed key the user declines', async () => {
    mockHostKeyManager.check.mockResolvedValue('changed');
    (hostKeyPrompt.showHostKeyPrompt as jest.Mock).mockResolvedValue(false);
    expect(await verify(Buffer.from('changed'))).toBe(false);
    expect(hostKeyPrompt.showHostKeyPrompt).toHaveBeenCalledWith('example.com', 22, 'SHA256:abc', 'changed');
  });

  it('returns undefined and delivers no verdict while the prompt is open (an async verifier would auto-accept)', async () => {
    mockHostKeyManager.check.mockResolvedValue('unknown');
    let resolvePrompt!: (accepted: boolean) => void;
    (hostKeyPrompt.showHostKeyPrompt as jest.Mock).mockReturnValue(new Promise<boolean>((r) => { resolvePrompt = r; }));
    const verdict = jest.fn();

    const ret = provider.verify(target, Buffer.from('newkey'), context, verdict);
    await flushMicrotasks();

    expect(ret).toBeUndefined();
    expect(verdict).not.toHaveBeenCalled();
    resolvePrompt(true);
    await flushMicrotasks();
    expect(verdict).toHaveBeenCalledWith(true);
  });

  it('fails closed and logs when the check throws', async () => {
    mockHostKeyManager.check.mockRejectedValue(new Error('disk on fire'));
    expect(await verify(Buffer.from('k'))).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk on fire'));
  });

  describe('checkStored — the non-interactive path (18a-1b)', () => {
    it('returns the store verdict without prompting and without writing', async () => {
      mockHostKeyManager.check.mockResolvedValue('trusted');

      const status = await provider.checkStored(target, Buffer.from('k'));

      expect(status).toBe('trusted');
      expect(mockHostKeyManager.check).toHaveBeenCalledWith('example.com', 22, Buffer.from('k').toString('base64'));
      expect(hostKeyPrompt.showHostKeyPrompt).not.toHaveBeenCalled();
      expect(mockHostKeyManager.trust).not.toHaveBeenCalled();
    });

    it.each(['unknown', 'changed'] as const)('passes "%s" through untouched — the caller fails closed', async (verdict) => {
      mockHostKeyManager.check.mockResolvedValue(verdict);
      expect(await provider.checkStored(target, Buffer.from('k'))).toBe(verdict);
      expect(hostKeyPrompt.showHostKeyPrompt).not.toHaveBeenCalled();
    });
  });
});
