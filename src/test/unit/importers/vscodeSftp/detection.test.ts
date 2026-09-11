import { decideDetection, detectVscodeSftp, DetectionDependencies, VSCODE_SFTP_DISMISSED_KEY, VSCODE_SFTP_DETECTED_CONTEXT, ToastAnswer } from '../../../../importers/vscodeSftp/detection';

// Feature 35b, Q3: one-time toast when sftp.json exists and fileferry.json
// does not; "Not now" persists in workspaceState; welcome hint via context key.

describe('decideDetection', () => {
  it.each([
    [{ sftpJsonExists: true, fileferryJsonExists: false, dismissed: false }, { showToast: true, showHint: true }],
    [{ sftpJsonExists: true, fileferryJsonExists: true, dismissed: false }, { showToast: false, showHint: true }],
    [{ sftpJsonExists: true, fileferryJsonExists: false, dismissed: true }, { showToast: false, showHint: true }],
    [{ sftpJsonExists: false, fileferryJsonExists: false, dismissed: false }, { showToast: false, showHint: false }],
  ])('%p → %p', (state, expected) => {
    expect(decideDetection(state)).toEqual(expected);
  });
});

describe('detectVscodeSftp', () => {
  let files: Set<string>;
  let state: Map<string, unknown>;
  let contexts: Record<string, boolean>;
  let toastShown: number;
  let importRuns: number;
  let answer: ToastAnswer;

  function dependencies(): DetectionDependencies {
    return {
      workspaceRoot: '/work',
      fileExists: async (absolutePath) => files.has(absolutePath),
      workspaceState: {
        get: <T>(key: string) => state.get(key) as T | undefined,
        update: async (key, value) => { state.set(key, value); },
      },
      setContext: async (key, value) => { contexts[key] = value; },
      showToast: async () => { toastShown++; return answer; },
      runImport: async () => { importRuns++; },
      joinPath: (...segments) => segments.join('/'),
    };
  }

  beforeEach(() => {
    files = new Set(['/work/.vscode/sftp.json']);
    state = new Map();
    contexts = {};
    toastShown = 0;
    importRuns = 0;
    answer = undefined;
  });

  it('shows the toast and sets the hint context when sftp.json exists without fileferry.json', async () => {
    await detectVscodeSftp(dependencies());
    expect(toastShown).toBe(1);
    expect(contexts[VSCODE_SFTP_DETECTED_CONTEXT]).toBe(true);
  });

  it('"Import" runs the import and remembers the answer', async () => {
    answer = 'Import';
    await detectVscodeSftp(dependencies());
    expect(importRuns).toBe(1);
    expect(state.get(VSCODE_SFTP_DISMISSED_KEY)).toBe(true);
  });

  it('"Not now" persists and the toast never repeats for that workspace', async () => {
    answer = 'Not now';
    await detectVscodeSftp(dependencies());
    expect(state.get(VSCODE_SFTP_DISMISSED_KEY)).toBe(true);
    expect(importRuns).toBe(0);
    await detectVscodeSftp(dependencies());
    expect(toastShown).toBe(1);
    expect(contexts[VSCODE_SFTP_DETECTED_CONTEXT]).toBe(true);
  });

  it('closing the toast without an answer persists nothing', async () => {
    await detectVscodeSftp(dependencies());
    expect(state.has(VSCODE_SFTP_DISMISSED_KEY)).toBe(false);
  });

  it('stays quiet when fileferry.json already exists, but keeps the hint', async () => {
    files.add('/work/.vscode/fileferry.json');
    await detectVscodeSftp(dependencies());
    expect(toastShown).toBe(0);
    expect(contexts[VSCODE_SFTP_DETECTED_CONTEXT]).toBe(true);
  });

  it('does nothing without sftp.json', async () => {
    files.clear();
    await detectVscodeSftp(dependencies());
    expect(toastShown).toBe(0);
    expect(contexts[VSCODE_SFTP_DETECTED_CONTEXT]).toBe(false);
  });

  it('does nothing without a workspace', async () => {
    const result = await detectVscodeSftp({ ...dependencies(), workspaceRoot: undefined });
    expect(result).toEqual({ showToast: false, showHint: false });
    expect(contexts).toEqual({});
  });
});
