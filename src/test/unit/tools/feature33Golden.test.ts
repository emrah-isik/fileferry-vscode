// Golden test against the REAL feature-33 plan. docs/plans/ is a gitignored,
// machine-local symlink, so this suite auto-skips wherever it is absent
// (CI, other checkouts) and runs the real-input acceptance on this machine:
// same case ids, state key ff33-testrun-v1, and the recorded
// feature_33_results.json loading cleanly into the regenerated tracker.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePlan, TrackerData } from '../../../tools/manualTestTracker/parser';
import { injectTrackerData } from '../../../tools/manualTestTracker/injector';
import { runTrackerHeadless } from './headlessTracker';

const repositoryRoot = path.resolve(__dirname, '../../../..');
const planPath = path.join(
  repositoryRoot,
  'docs/plans/manual_tests/feature_33_manual_test_plan.md'
);
const resultsPath = path.join(
  repositoryRoot,
  'docs/plans/manual_tests/trackers/feature_33_results.json'
);
const templatePath = path.join(repositoryRoot, 'src/tools/manualTestTracker/template.html');

const describeGolden = fs.existsSync(planPath) ? describe : describe.skip;

const EXPECTED_CASE_IDS = [
  ...['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9', 'R10', 'R11'],
  ...['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9'],
  ...['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10'],
  ...['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'],
  ...['U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8', 'U9', 'U10'],
  ...['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'],
  ...['Z1', 'Z2', 'Z3'],
];

describeGolden('feature-33 golden regeneration', () => {
  let data: TrackerData;

  beforeAll(() => {
    data = parsePlan(fs.readFileSync(planPath, 'utf8'), '33');
  });

  it('parses the finalized plan into the known shape', () => {
    expect(data.lanes).toEqual(['SFTP', 'FTP']);
    expect(data.sections.map((section) => section.key)).toEqual([
      '0',
      'R',
      'D',
      'M',
      'P',
      'U',
      'G',
      'Z',
    ]);
    const caseIds = data.sections.flatMap((section) =>
      section.cases.map((testCase) => testCase.id)
    );
    expect(caseIds).toEqual(EXPECTED_CASE_IDS);
    const supersededIds = data.sections
      .flatMap((section) => section.cases)
      .filter((testCase) => testCase.superseded)
      .map((testCase) => testCase.id);
    expect(supersededIds).toEqual(['D7']);
  });

  it('keeps the seed blocks attached to their sections (setup ×2, G, Z wrap-up)', () => {
    const seedsBySection = new Map(
      data.sections.map((section) => [
        section.key,
        section.blocks.filter((block) => block.kind === 'seed'),
      ])
    );
    // §0 carries two sh fences: the docker-start one-liner and the ops seed.
    expect(seedsBySection.get('0')).toHaveLength(2);
    expect(seedsBySection.get('G')).toHaveLength(1);
    expect(seedsBySection.get('Z')).toHaveLength(1);
  });

  it('every recorded cell in feature_33_results.json maps onto a generated case and lane', () => {
    const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    const activeCaseIds = new Set(
      data.sections
        .flatMap((section) => section.cases)
        .filter((testCase) => !testCase.superseded)
        .map((testCase) => testCase.id)
    );
    const cellKeys = Object.keys(results.cells);
    expect(cellKeys.length).toBe(activeCaseIds.size * data.lanes.length); // the recorded 116/116 pass
    for (const cellKey of cellKeys) {
      const separatorIndex = cellKey.lastIndexOf('.');
      const caseId = cellKey.slice(0, separatorIndex);
      const lane = cellKey.slice(separatorIndex + 1);
      expect(activeCaseIds.has(caseId)).toBe(true);
      expect(data.lanes).toContain(lane);
    }
    expect(Object.keys(results.record).sort()).toEqual(['commit', 'date', 'verdict']);
  });

  it('the regenerated tracker loads the recorded results cleanly (116/116, key ff33-testrun-v1)', async () => {
    const html = injectTrackerData(fs.readFileSync(templatePath, 'utf8'), data);
    const savedResults = fs.readFileSync(resultsPath, 'utf8');
    const tracker = await runTrackerHeadless(html, {
      storage: { 'ff33-testrun-v1': savedResults },
    });

    expect(tracker.title).toBe('FileFerry · feature/33 manual pass');
    expect(tracker.elementById('tally').innerHTML).toBe('<b>116</b>/116 checks');
    expect(tracker.storage.get('ff33-testrun-v1.probe')).toBe('1');

    const rendered = tracker.renderLog.join('\n');
    for (const caseId of EXPECTED_CASE_IDS) {
      expect(rendered).toContain(caseId);
    }
  });
});
