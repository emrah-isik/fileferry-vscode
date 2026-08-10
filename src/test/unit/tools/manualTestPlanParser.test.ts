import { parsePlan, PlanParseError } from '../../../tools/manualTestTracker/parser';
import { buildPlan, DEFAULT_SECTIONS } from './syntheticPlan';

function parseErrorFrom(markdown: string, featureToken = '77'): PlanParseError {
  try {
    parsePlan(markdown, featureToken);
  } catch (error) {
    if (error instanceof PlanParseError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected parsePlan to throw a PlanParseError');
}

describe('parsePlan — happy path (feature-33 convention)', () => {
  const data = parsePlan(buildPlan(), '77');

  it('returns the feature token and the lanes read from the table header', () => {
    expect(data.token).toBe('77');
    expect(data.lanes).toEqual(['SFTP', 'FTP']);
  });

  it('parses the execution record, tolerating empty values', () => {
    expect(data.record).toEqual([
      { label: 'Date of pass', value: '', stateKey: 'date' },
      { label: 'Branch commit tested', value: 'abc1234', stateKey: 'commit' },
      { label: 'Dev host', value: 'Test rig' },
      { label: 'Overall verdict', value: '', stateKey: 'verdict' },
    ]);
  });

  it('parses every section heading into key and title', () => {
    expect(data.sections.map((section) => section.key)).toEqual(['0', 'A', 'B']);
    expect(data.sections.map((section) => section.title)).toEqual([
      'Setup',
      'Alpha ops (77a)',
      'Beta ops (77b)',
    ]);
  });

  it('allows sections without a case table (setup) and attaches their prose and seed blocks', () => {
    const setup = data.sections[0];
    expect(setup.cases).toEqual([]);
    expect(setup.automatedNote).toBeNull();
    expect(setup.blocks).toEqual([
      { kind: 'prose', text: 'Start the widget sandbox.' },
      { kind: 'seed', command: 'echo seed-main' },
    ]);
  });

  it('extracts the already-automated preamble, joining wrapped lines', () => {
    expect(data.sections[1].automatedNote).toBe('the alpha suite (`alpha.test.ts`, 5 tests).');
  });

  it('parses cases with id, do, and expect text preserved', () => {
    const alpha = data.sections[1];
    expect(alpha.cases.map((testCase) => testCase.id)).toEqual(['A1', 'A2', 'A3']);
    expect(alpha.cases[0]).toEqual({
      id: 'A1',
      do: 'Click the alpha button.',
      expect: 'Alpha happens.',
      superseded: false,
    });
    expect(alpha.cases[1].do).toBe('Toggle **Dry Run** on.');
    expect(alpha.cases[1].expect).toBe('Nothing changes; `log` line only.');
  });

  it('marks ~~struck~~ rows as superseded', () => {
    const superseded = data.sections[1].cases[2];
    expect(superseded.superseded).toBe(true);
    expect(superseded.do).toBe('~~Old flow.~~ Superseded by B1.');
  });

  it('keeps the section blocks in document order, including subheadings and trailing seeds', () => {
    const beta = data.sections[2];
    expect(beta.blocks).toEqual([
      { kind: 'prose', text: 'Beta intro paragraph wrapped across two lines.' },
      { kind: 'seed', command: 'echo seed-beta' },
      { kind: 'cases' },
      { kind: 'subheading', text: 'Wrap-up' },
      { kind: 'prose', text: 'Clean the sandbox.' },
      { kind: 'seed', command: 'echo cleanup' },
    ]);
  });

  it('places exactly one cases block in sections that have a table', () => {
    const alphaBlocks = data.sections[1].blocks.filter((block) => block.kind === 'cases');
    expect(alphaBlocks).toHaveLength(1);
  });

  it('unescapes \\| inside cells', () => {
    const plan = buildPlan({
      sections: [
        '## A. Alpha (77a)',
        '',
        '| # | Do | Expect | SFTP |',
        '| --- | --- | --- | --- |',
        '| A1 | Type `a \\| b`. | Shows `a \\| b`. | |',
      ],
    });
    const parsed = parsePlan(plan, '77');
    expect(parsed.sections[0].cases[0].do).toBe('Type `a | b`.');
    expect(parsed.sections[0].cases[0].expect).toBe('Shows `a | b`.');
  });
});

describe('parsePlan — header variants', () => {
  it('accepts "Check" in place of "Do" (the feature-33 closing-checks section)', () => {
    const plan = buildPlan({
      sections: [
        '## Z. Closing checks (77z)',
        '',
        '| # | Check | Expect | SFTP | FTP |',
        '| --- | --- | --- | --- | --- |',
        '| Z1 | Output stayed clean. | No hook lines. | | |',
      ],
    });
    const parsed = parsePlan(plan, '77');
    expect(parsed.sections[0].cases[0].do).toBe('Output stayed clean.');
  });
});

describe('parsePlan — dynamic lanes', () => {
  it('accepts a single lane', () => {
    const plan = buildPlan({
      sections: [
        '## A. Alpha (77a)',
        '',
        '| # | Do | Expect | Manual |',
        '| --- | --- | --- | --- |',
        '| A1 | Do it. | It happens. | |',
      ],
    });
    expect(parsePlan(plan, '77').lanes).toEqual(['Manual']);
  });

  it('accepts three lanes', () => {
    const plan = buildPlan({
      sections: [
        '## A. Alpha (77a)',
        '',
        '| # | Do | Expect | SFTP | FTP | Local |',
        '| --- | --- | --- | --- | --- | --- |',
        '| A1 | Do it. | It happens. | | | |',
      ],
    });
    expect(parsePlan(plan, '77').lanes).toEqual(['SFTP', 'FTP', 'Local']);
  });
});

describe('parsePlan — strict errors with line numbers', () => {
  it('rejects a missing or malformed H1 title', () => {
    const error = parseErrorFrom('Some prose\n\n## A. Alpha (77a)\n');
    expect(error.line).toBe(1);
    expect(error.message).toMatch(/# Feature/);
  });

  it('rejects an H1 whose token does not match the requested feature', () => {
    const error = parseErrorFrom(buildPlan(), '99');
    expect(error.line).toBe(1);
    expect(error.message).toMatch(/99/);
    expect(error.message).toMatch(/77/);
  });

  it('rejects a plan without an Execution record section', () => {
    const error = parseErrorFrom(buildPlan({ executionRecord: [] }));
    expect(error.message).toMatch(/Execution record/);
  });

  it('rejects an execution record with a wrong table header', () => {
    const error = parseErrorFrom(
      buildPlan({
        executionRecord: [
          '## Execution record',
          '',
          '| Field | Result |',
          '| --- | --- |',
          '| Date of pass | |',
          '',
        ],
      })
    );
    expect(error.line).toBe(7);
    expect(error.message).toMatch(/\| Field \| Value \|/);
  });

  it('rejects an execution record missing a canonical field', () => {
    const error = parseErrorFrom(
      buildPlan({
        executionRecord: [
          '## Execution record',
          '',
          '| Field | Value |',
          '| --- | --- |',
          '| Date of pass | |',
          '| Branch commit tested | abc1234 |',
          '',
        ],
      })
    );
    expect(error.message).toMatch(/Overall verdict/);
  });

  it('rejects a malformed section heading', () => {
    const error = parseErrorFrom(buildPlan({ sections: ['## Just a heading', ''] }));
    expect(error.line).toBe(14);
    expect(error.message).toMatch(/section heading/i);
  });

  it('rejects a duplicate section key', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Do | Expect | SFTP |',
          '| --- | --- | --- | --- |',
          '| A1 | Do it. | It happens. | |',
          '',
          '## A. Alpha again',
          '',
        ],
      })
    );
    expect(error.message).toMatch(/duplicate section key/i);
  });

  it('rejects a case-table header without the fixed # / Do / Expect columns', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Action | Expect | SFTP |',
          '| --- | --- | --- | --- |',
          '| A1 | Do it. | It happens. | |',
        ],
      })
    );
    expect(error.line).toBe(16);
    expect(error.message).toMatch(/Do/);
  });

  it('rejects a case table with zero lane columns', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Do | Expect |',
          '| --- | --- | --- |',
          '| A1 | Do it. | It happens. |',
        ],
      })
    );
    expect(error.line).toBe(16);
    expect(error.message).toMatch(/lane/i);
  });

  it('rejects mismatched lane columns between tables', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Do | Expect | SFTP | FTP |',
          '| --- | --- | --- | --- | --- |',
          '| A1 | Do it. | It happens. | | |',
          '',
          '## B. Beta (77b)',
          '',
          '| # | Do | Expect | SFTP |',
          '| --- | --- | --- | --- |',
          '| B1 | Do it. | It happens. | |',
        ],
      })
    );
    expect(error.line).toBe(22);
    expect(error.message).toMatch(/SFTP, FTP/);
  });

  it('rejects a missing separator row after the table header', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Do | Expect | SFTP |',
          '| A1 | Do it. | It happens. | |',
        ],
      })
    );
    expect(error.line).toBe(17);
    expect(error.message).toMatch(/separator/i);
  });

  it('rejects a separator row with the wrong column count', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Do | Expect | SFTP |',
          '| --- | --- | --- |',
          '| A1 | Do it. | It happens. | |',
        ],
      })
    );
    expect(error.line).toBe(17);
    expect(error.message).toMatch(/separator/i);
  });

  it('rejects a case row with the wrong column count', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Do | Expect | SFTP | FTP |',
          '| --- | --- | --- | --- | --- |',
          '| A1 | Do it. | It happens. | |',
        ],
      })
    );
    expect(error.line).toBe(18);
    expect(error.message).toMatch(/5 column/);
  });

  it('rejects a case id that does not extend the section key', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Do | Expect | SFTP |',
          '| --- | --- | --- | --- |',
          '| X1 | Do it. | It happens. | |',
        ],
      })
    );
    expect(error.line).toBe(18);
    expect(error.message).toMatch(/X1/);
  });

  it('rejects a duplicate case id', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Do | Expect | SFTP |',
          '| --- | --- | --- | --- |',
          '| A1 | Do it. | It happens. | |',
          '| A1 | Do it again. | It happens. | |',
        ],
      })
    );
    expect(error.line).toBe(19);
    expect(error.message).toMatch(/duplicate case id/i);
  });

  it('rejects a second case table in the same section', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          '| # | Do | Expect | SFTP |',
          '| --- | --- | --- | --- |',
          '| A1 | Do it. | It happens. | |',
          '',
          '| # | Do | Expect | SFTP |',
          '| --- | --- | --- | --- |',
          '| A2 | Do it. | It happens. | |',
        ],
      })
    );
    expect(error.line).toBe(20);
    expect(error.message).toMatch(/more than one case table/i);
  });

  it('rejects an unclosed fenced block', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: ['## 0. Setup', '', '```sh', 'echo never closed'],
      })
    );
    expect(error.line).toBe(16);
    expect(error.message).toMatch(/unclosed/i);
  });

  it('rejects a fenced block that is not sh', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: ['## 0. Setup', '', '```text', 'plain', '```'],
      })
    );
    expect(error.line).toBe(16);
    expect(error.message).toMatch(/sh/);
  });

  it('rejects a second already-automated preamble in one section', () => {
    const error = parseErrorFrom(
      buildPlan({
        sections: [
          '## A. Alpha (77a)',
          '',
          "**Already automated — don't re-test by hand:** first note.",
          '',
          "**Already automated — don't re-test by hand:** second note.",
          '',
          '| # | Do | Expect | SFTP |',
          '| --- | --- | --- | --- |',
          '| A1 | Do it. | It happens. | |',
        ],
      })
    );
    expect(error.line).toBe(18);
    expect(error.message).toMatch(/already automated/i);
  });

  it('rejects a plan with no case table anywhere', () => {
    const error = parseErrorFrom(buildPlan({ sections: ['## 0. Setup', '', 'Prose only.'] }));
    expect(error.message).toMatch(/no case table/i);
  });
});

describe('parsePlan — fixture sanity', () => {
  it('the default synthetic fixture stays aligned with the line numbers asserted above', () => {
    // Error tests assert absolute line numbers computed from the builder's
    // fixed prefix: title(1) + blank + ignored prose + blank + 9-line
    // execution record = first section line at 14.
    const plan = buildPlan({ sections: ['## A. Alpha (77a)'] });
    expect(plan.split('\n')[13]).toBe('## A. Alpha (77a)');
    expect(DEFAULT_SECTIONS[0]).toBe('## 0. Setup');
  });
});
