import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseArguments,
  deriveTrackerPaths,
  repositoryRootFromModuleDirectory,
  main,
} from '../../../tools/manualTestTracker/cli';
import { buildPlan } from './syntheticPlan';

describe('parseArguments', () => {
  it('accepts a plain feature token', () => {
    expect(parseArguments(['33'])).toEqual({ featureToken: '33' });
    expect(parseArguments(['27b'])).toEqual({ featureToken: '27b' });
  });

  it('rejects a missing token with the usage line', () => {
    expect(() => parseArguments([])).toThrow(/usage: npm run tracker/);
  });

  it('rejects extra arguments', () => {
    expect(() => parseArguments(['33', '--serve'])).toThrow(/usage: npm run tracker/);
  });

  it('rejects a token with path characters', () => {
    expect(() => parseArguments(['../evil'])).toThrow(/feature token/);
  });
});

describe('deriveTrackerPaths', () => {
  it('derives the hardcoded repo-relative plan, template, and tracker paths', () => {
    // Expectations built with the same path.join the source uses, so the
    // assertions hold on Windows separators too (CI matrix lesson).
    const paths = deriveTrackerPaths('/repo', '33a');
    expect(paths.planPath).toBe(
      path.join('/repo', 'docs/plans/manual_tests', 'feature_33a_manual_test_plan.md')
    );
    expect(paths.templatePath).toBe(path.join('/repo', 'src/tools/manualTestTracker/template.html'));
    expect(paths.trackerPath).toBe(
      path.join('/repo', 'docs/plans/manual_tests/trackers', 'feature_33a_manual_test_tracker.html')
    );
  });
});

describe('repositoryRootFromModuleDirectory', () => {
  it('walks three levels up (out/tools/manualTestTracker → repo root)', () => {
    expect(repositoryRootFromModuleDirectory(path.join('/repo', 'out/tools/manualTestTracker'))).toBe(
      path.resolve('/repo')
    );
  });
});

describe('main', () => {
  let temporaryRoot: string;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-cli-'));
    fs.mkdirSync(path.join(temporaryRoot, 'docs/plans/manual_tests/trackers'), { recursive: true });
    fs.mkdirSync(path.join(temporaryRoot, 'src/tools/manualTestTracker'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '../../../tools/manualTestTracker/template.html'),
      path.join(temporaryRoot, 'src/tools/manualTestTracker/template.html')
    );
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('generates the tracker next to the other trackers and reports what it wrote', () => {
    fs.writeFileSync(
      path.join(temporaryRoot, 'docs/plans/manual_tests/feature_77_manual_test_plan.md'),
      buildPlan()
    );
    const exitCode = main(['77'], temporaryRoot);
    expect(exitCode).toBe(0);
    const trackerPath = path.join(
      temporaryRoot,
      'docs/plans/manual_tests/trackers/feature_77_manual_test_tracker.html'
    );
    const html = fs.readFileSync(trackerPath, 'utf8');
    expect(html).toContain('"token":"77"');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('feature_77_manual_test_tracker.html');
  });

  it('fails with a clear message when the plan file is missing', () => {
    const exitCode = main(['77'], temporaryRoot);
    expect(exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('feature_77_manual_test_plan.md');
  });

  it('reports parse failures as <path>: line <n>: <reason>', () => {
    fs.writeFileSync(
      path.join(temporaryRoot, 'docs/plans/manual_tests/feature_77_manual_test_plan.md'),
      'not a plan\n'
    );
    const exitCode = main(['77'], temporaryRoot);
    expect(exitCode).toBe(1);
    const message = errorSpy.mock.calls.flat().join('\n');
    expect(message).toContain('feature_77_manual_test_plan.md: line 1:');
  });

  it('fails with the usage line on bad arguments', () => {
    expect(main([], temporaryRoot)).toBe(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('usage: npm run tracker');
  });
});
