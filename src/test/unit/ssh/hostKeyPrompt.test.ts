import * as vscode from 'vscode';
import { showHostKeyPrompt } from '../../../ssh/hostKeyPrompt';

describe('showHostKeyPrompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('unknown host', () => {
    it('shows warning with fingerprint and returns true when user accepts', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Trust');
      const result = await showHostKeyPrompt('example.com', 22, 'SHA256:abc123', 'unknown');
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('example.com'),
        expect.objectContaining({ modal: true }),
        'Trust'
      );
      expect(result).toBe(true);
    });

    it('returns false when user rejects unknown host', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
      const result = await showHostKeyPrompt('example.com', 22, 'SHA256:abc123', 'unknown');
      expect(result).toBe(false);
    });
  });

  describe('changed host key', () => {
    it('shows critical warning and returns true when user accepts', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Trust Anyway');
      const result = await showHostKeyPrompt('example.com', 22, 'SHA256:abc123', 'changed');
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('WARNING'),
        expect.objectContaining({ modal: true }),
        'Trust Anyway'
      );
      expect(result).toBe(true);
    });

    it('returns false when user rejects changed host key', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);
      const result = await showHostKeyPrompt('example.com', 22, 'SHA256:abc123', 'changed');
      expect(result).toBe(false);
    });
  });
});
