import { DryRunReporter, DryRunPlan } from '../../../services/DryRunReporter';
import type { OutputChannel } from 'vscode';

function makeOutput(): { lines: string[]; shown: boolean; channel: OutputChannel } {
  const lines: string[] = [];
  let shown = false;
  const channel = {
    appendLine: jest.fn((line: string) => { lines.push(line); }),
    show: jest.fn(() => { shown = true; }),
  } as unknown as OutputChannel;
  return { lines, shown: false, channel };
}

const workspaceRoot = '/workspace';

describe('DryRunReporter', () => {
  it('writes upload entries with workspace-relative local paths', () => {
    const { lines, channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    const plan: DryRunPlan = {
      serverName: 'production',
      uploadItems: [
        { localPath: '/workspace/src/index.ts', remotePath: '/var/www/app/index.ts' },
        { localPath: '/workspace/src/utils/helper.ts', remotePath: '/var/www/app/utils/helper.ts' },
      ],
      deleteRemotePaths: [],
      workspaceRoot,
    };
    reporter.report([plan]);
    expect(lines.some(l => l.includes('UPLOAD') && l.includes('src/index.ts') && l.includes('/var/www/app/index.ts'))).toBe(true);
    expect(lines.some(l => l.includes('UPLOAD') && l.includes('src/utils/helper.ts'))).toBe(true);
  });

  it('writes delete entries', () => {
    const { lines, channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    const plan: DryRunPlan = {
      serverName: 'production',
      uploadItems: [],
      deleteRemotePaths: ['/var/www/app/old-file.ts'],
      workspaceRoot,
    };
    reporter.report([plan]);
    expect(lines.some(l => l.includes('DELETE') && l.includes('/var/www/app/old-file.ts'))).toBe(true);
  });

  it('writes both upload and delete sections', () => {
    const { lines, channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    const plan: DryRunPlan = {
      serverName: 'production',
      uploadItems: [{ localPath: '/workspace/src/index.ts', remotePath: '/var/www/index.ts' }],
      deleteRemotePaths: ['/var/www/old.ts'],
      workspaceRoot,
    };
    reporter.report([plan]);
    expect(lines.some(l => l.includes('UPLOAD'))).toBe(true);
    expect(lines.some(l => l.includes('DELETE'))).toBe(true);
  });

  it('writes correct summary counts', () => {
    const { lines, channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    const plan: DryRunPlan = {
      serverName: 'production',
      uploadItems: [
        { localPath: '/workspace/a.ts', remotePath: '/var/www/a.ts' },
        { localPath: '/workspace/b.ts', remotePath: '/var/www/b.ts' },
      ],
      deleteRemotePaths: ['/var/www/old.ts'],
      workspaceRoot,
    };
    reporter.report([plan]);
    expect(lines.some(l => l.includes('2') && l.includes('upload') && l.includes('1') && l.includes('delete'))).toBe(true);
  });

  it('handles empty plan (0 uploads, 0 deletes)', () => {
    const { lines, channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    const plan: DryRunPlan = {
      serverName: 'production',
      uploadItems: [],
      deleteRemotePaths: [],
      workspaceRoot,
    };
    reporter.report([plan]);
    expect(lines.some(l => l.includes('0') && l.includes('upload'))).toBe(true);
  });

  it('writes each server in its own section for multi-server plans', () => {
    const { lines, channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    const plans: DryRunPlan[] = [
      { serverName: 'staging', uploadItems: [{ localPath: '/workspace/a.ts', remotePath: '/srv/a.ts' }], deleteRemotePaths: [], workspaceRoot },
      { serverName: 'production', uploadItems: [{ localPath: '/workspace/b.ts', remotePath: '/var/b.ts' }], deleteRemotePaths: [], workspaceRoot },
    ];
    reporter.report(plans);
    expect(lines.some(l => l.includes('staging'))).toBe(true);
    expect(lines.some(l => l.includes('production'))).toBe(true);
  });

  it('calls output.show(true) to reveal the channel', () => {
    const { channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    reporter.report([{ serverName: 'x', uploadItems: [], deleteRemotePaths: [], workspaceRoot }]);
    expect(channel.show).toHaveBeenCalledWith(true);
  });

  it('strips workspaceRoot prefix from local paths', () => {
    const { lines, channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    reporter.report([{
      serverName: 'production',
      uploadItems: [{ localPath: '/workspace/deep/nested/file.ts', remotePath: '/remote/file.ts' }],
      deleteRemotePaths: [],
      workspaceRoot: '/workspace',
    }]);
    const uploadLine = lines.find(l => l.includes('UPLOAD'));
    expect(uploadLine).toBeDefined();
    expect(uploadLine).not.toContain('/workspace/deep');
    expect(uploadLine).toContain('deep/nested/file.ts');
  });

  it('includes DRY RUN header', () => {
    const { lines, channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    reporter.report([{ serverName: 'x', uploadItems: [], deleteRemotePaths: [], workspaceRoot }]);
    expect(lines.some(l => l.includes('DRY RUN'))).toBe(true);
  });

  it('includes Server name in output', () => {
    const { lines, channel } = makeOutput();
    const reporter = new DryRunReporter(channel);
    reporter.report([{ serverName: 'myserver', uploadItems: [], deleteRemotePaths: [], workspaceRoot }]);
    expect(lines.some(l => l.includes('myserver'))).toBe(true);
  });
});
