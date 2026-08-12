// Synthetic manual-test-plan fixtures for the tracker-generator tests.
// Invented mini-feature "77" in the same format as the real plans (the
// feature-33 convention) — no private plan content lives in the repo.

export const DEFAULT_TITLE = '# Feature 77 — Widget polish manual test plan';

export const DEFAULT_EXECUTION_RECORD = [
  '## Execution record',
  '',
  '| Field | Value |',
  '| --- | --- |',
  '| Date of pass | |',
  '| Branch commit tested | abc1234 |',
  '| Dev host | Test rig |',
  '| Overall verdict | |',
  '',
];

export const DEFAULT_SECTIONS = [
  '## 0. Setup',
  '',
  'Start the widget sandbox.',
  '',
  '```sh',
  'echo seed-main',
  '```',
  '',
  '## A. Alpha ops (77a)',
  '',
  "**Already automated — don't re-test by hand:** the alpha suite",
  '(`alpha.test.ts`, 5 tests).',
  '',
  'This section verifies the alpha human paths.',
  '',
  '| # | Do | Expect | SFTP | FTP |',
  '| --- | --- | --- | --- | --- |',
  '| A1 | Click the alpha button. | Alpha happens. | | |',
  '| A2 | Toggle **Dry Run** on. | Nothing changes; `log` line only. | ok | FAIL #12 |',
  '| A3 | ~~Old flow.~~ Superseded by B1. | — | — | — |',
  '',
  '---',
  '',
  '## B. Beta ops (77b)',
  '',
  'Beta intro paragraph',
  'wrapped across two lines.',
  '',
  '```sh',
  'echo seed-beta',
  '```',
  '',
  '| # | Do | Expect | SFTP | FTP |',
  '| --- | --- | --- | --- | --- |',
  '| B1 | Run beta. | Beta result shows. | | |',
  '',
  '### Wrap-up',
  '',
  'Clean the sandbox.',
  '',
  '```sh',
  'echo cleanup',
  '```',
];

export interface BuildPlanOptions {
  title?: string;
  executionRecord?: string[];
  sections?: string[];
}

export function buildPlan(options: BuildPlanOptions = {}): string {
  const lines = [
    options.title ?? DEFAULT_TITLE,
    '',
    'Status prose before the first section is ignored by the parser.',
    '',
    ...(options.executionRecord ?? DEFAULT_EXECUTION_RECORD),
    ...(options.sections ?? DEFAULT_SECTIONS),
  ];
  return lines.join('\n') + '\n';
}
