// Strict parser for the manual-test-plan markdown convention (the feature-33
// format — see docs/plans/manual_tests/README.md). Pure: string in, data out.
// Any deviation from the convention throws a PlanParseError with the 1-based
// line number, so a silently missing case can never reach a tracker.

export interface TrackerCase {
  id: string;
  do: string;
  expect: string;
  superseded: boolean;
}

export type SectionBlock =
  | { kind: 'prose'; text: string }
  | { kind: 'subheading'; text: string }
  | { kind: 'seed'; command: string }
  | { kind: 'cases' };

export interface TrackerSection {
  key: string;
  title: string;
  automatedNote: string | null;
  blocks: SectionBlock[];
  cases: TrackerCase[];
}

export type RecordStateKey = 'date' | 'commit' | 'verdict';

export interface RecordField {
  label: string;
  value: string;
  stateKey?: RecordStateKey;
}

export interface TrackerData {
  token: string;
  lanes: string[];
  record: RecordField[];
  sections: TrackerSection[];
}

export class PlanParseError extends Error {
  constructor(
    message: string,
    public readonly line: number
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'PlanParseError';
  }
}

const AUTOMATED_NOTE_MARKER = "**Already automated — don't re-test by hand:**";

const CANONICAL_RECORD_FIELDS: ReadonlyArray<{ label: string; stateKey: RecordStateKey }> = [
  { label: 'Date of pass', stateKey: 'date' },
  { label: 'Branch commit tested', stateKey: 'commit' },
  { label: 'Overall verdict', stateKey: 'verdict' },
];

/** Split a `| a | b |` row into trimmed cells, honouring `\|` escapes. */
function splitTableRow(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < row.length; index++) {
    const character = row[index];
    if (character === '\\' && row[index + 1] === '|') {
      current += '|';
      index++;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  cells.push(current.trim());
  // A well-formed `| a | b |` row yields empty first/last fragments — drop them.
  if (cells.length > 0 && cells[0] === '') {
    cells.shift();
  }
  if (cells.length > 0 && cells[cells.length - 1] === '') {
    cells.pop();
  }
  return cells;
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parsePlan(markdown: string, featureToken: string): TrackerData {
  const lines = markdown.split(/\r?\n/);

  const titleMatch = /^# Feature (\S+) — .+$/.exec(lines[0] ?? '');
  if (!titleMatch) {
    throw new PlanParseError(
      'expected the plan to start with "# Feature <token> — <title>"',
      1
    );
  }
  if (titleMatch[1] !== featureToken) {
    throw new PlanParseError(
      `plan title is for feature "${titleMatch[1]}" but feature "${featureToken}" was requested`,
      1
    );
  }

  const sections: TrackerSection[] = [];
  let record: RecordField[] | null = null;
  let lanes: string[] | null = null;

  // Parsing context: null = preamble prose before the first section (ignored),
  // 'record' = inside "## Execution record", otherwise the open section.
  let currentSection: TrackerSection | 'record' | null = null;
  let paragraph: { text: string; startLine: number } | null = null;

  const flushParagraph = (): void => {
    if (!paragraph) {
      return;
    }
    const { text, startLine } = paragraph;
    paragraph = null;
    if (currentSection === null || currentSection === 'record') {
      return;
    }
    if (text.startsWith(AUTOMATED_NOTE_MARKER)) {
      if (currentSection.automatedNote !== null) {
        throw new PlanParseError(
          `section ${currentSection.key} has a second "Already automated" preamble`,
          startLine
        );
      }
      currentSection.automatedNote = text.slice(AUTOMATED_NOTE_MARKER.length).trim();
      return;
    }
    currentSection.blocks.push({ kind: 'prose', text });
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineNumber = index + 1;

    // Fenced blocks are consumed wholesale so their contents can never be
    // mistaken for structure.
    const fenceMatch = /^```(.*)$/.exec(line);
    if (fenceMatch) {
      flushParagraph();
      const language = fenceMatch[1].trim();
      const commandLines: string[] = [];
      let closed = false;
      while (index + 1 < lines.length) {
        index++;
        if (/^```\s*$/.test(lines[index])) {
          closed = true;
          break;
        }
        commandLines.push(lines[index]);
      }
      if (!closed) {
        throw new PlanParseError('unclosed fenced block', lineNumber);
      }
      if (currentSection === null) {
        continue; // pre-section preamble is ignored wholesale
      }
      if (currentSection === 'record') {
        throw new PlanParseError('unexpected fenced block in the Execution record section', lineNumber);
      }
      if (language !== 'sh') {
        throw new PlanParseError(
          `expected seed blocks to be fenced as \`sh\`, found "${language || '(none)'}"`,
          lineNumber
        );
      }
      currentSection.blocks.push({ kind: 'seed', command: commandLines.join('\n') });
      continue;
    }

    const sectionHeadingMatch = /^## (.+)$/.exec(line);
    if (sectionHeadingMatch) {
      flushParagraph();
      const headingText = sectionHeadingMatch[1].trim();
      if (headingText === 'Execution record') {
        if (record !== null) {
          throw new PlanParseError('duplicate "## Execution record" section', lineNumber);
        }
        record = [];
        currentSection = 'record';
        continue;
      }
      const keyedMatch = /^([A-Za-z0-9]+)\. (.+)$/.exec(headingText);
      if (!keyedMatch) {
        throw new PlanParseError(
          `malformed section heading "## ${headingText}" — expected "## <KEY>. <Title>" or "## Execution record"`,
          lineNumber
        );
      }
      const [, key, title] = keyedMatch;
      if (sections.some((section) => section.key === key)) {
        throw new PlanParseError(`duplicate section key "${key}"`, lineNumber);
      }
      currentSection = { key, title, automatedNote: null, blocks: [], cases: [] };
      sections.push(currentSection);
      continue;
    }

    const subheadingMatch = /^### (.+)$/.exec(line);
    if (subheadingMatch) {
      flushParagraph();
      if (currentSection !== null && currentSection !== 'record') {
        currentSection.blocks.push({ kind: 'subheading', text: subheadingMatch[1].trim() });
      }
      continue;
    }

    if (line.startsWith('|')) {
      flushParagraph();
      if (currentSection === null) {
        continue; // tables in the ignored preamble region
      }
      const headerCells = splitTableRow(line);

      if (currentSection === 'record') {
        if (record === null || record.length > 0) {
          throw new PlanParseError('unexpected second table in the Execution record section', lineNumber);
        }
        if (headerCells.length !== 2 || headerCells[0] !== 'Field' || headerCells[1] !== 'Value') {
          throw new PlanParseError(
            'expected the Execution record table header to be "| Field | Value |"',
            lineNumber
          );
        }
        index++;
        if (index >= lines.length || !isSeparatorRow(splitTableRow(lines[index]))) {
          throw new PlanParseError('expected a "| --- | --- |" separator row', lineNumber + 1);
        }
        while (index + 1 < lines.length && lines[index + 1].startsWith('|')) {
          index++;
          const rowCells = splitTableRow(lines[index]);
          if (rowCells.length !== 2) {
            throw new PlanParseError(
              `expected 2 columns in the Execution record row, found ${rowCells.length}`,
              index + 1
            );
          }
          const [label, value] = rowCells;
          if (record.some((field) => field.label === label)) {
            throw new PlanParseError(`duplicate Execution record field "${label}"`, index + 1);
          }
          const canonical = CANONICAL_RECORD_FIELDS.find((field) => field.label === label);
          record.push(canonical ? { label, value, stateKey: canonical.stateKey } : { label, value });
        }
        continue;
      }

      // Case table in a regular section.
      if (currentSection.blocks.some((block) => block.kind === 'cases')) {
        throw new PlanParseError(
          `section ${currentSection.key} has more than one case table`,
          lineNumber
        );
      }
      if (headerCells.length < 4 || headerCells[0] !== '#' || headerCells[1] !== 'Do' || headerCells[2] !== 'Expect') {
        const laneProblem = headerCells.length < 4 ? ' with at least one lane column' : '';
        throw new PlanParseError(
          `expected a case-table header "| # | Do | Expect | <lane…> |"${laneProblem}, found "${line.trim()}"`,
          lineNumber
        );
      }
      const tableLanes = headerCells.slice(3);
      if (lanes === null) {
        lanes = tableLanes;
      } else if (lanes.length !== tableLanes.length || lanes.some((lane, laneIndex) => lane !== tableLanes[laneIndex])) {
        throw new PlanParseError(
          `lane columns [${tableLanes.join(', ')}] do not match the plan's first case table [${lanes.join(', ')}]`,
          lineNumber
        );
      }
      const columnCount = headerCells.length;

      index++;
      if (index >= lines.length || !lines[index].startsWith('|') || !isSeparatorRow(splitTableRow(lines[index]))) {
        throw new PlanParseError('expected a "| --- | … |" separator row after the case-table header', index + 1);
      }
      if (splitTableRow(lines[index]).length !== columnCount) {
        throw new PlanParseError(
          `expected the separator row to have ${columnCount} columns like the header`,
          index + 1
        );
      }

      while (index + 1 < lines.length && lines[index + 1].startsWith('|')) {
        index++;
        const rowCells = splitTableRow(lines[index]);
        if (rowCells.length !== columnCount) {
          throw new PlanParseError(
            `expected ${columnCount} columns in the case row, found ${rowCells.length}`,
            index + 1
          );
        }
        const [id, doText, expectText] = rowCells;
        const idPattern = new RegExp(`^${currentSection.key}\\d+$`);
        if (!idPattern.test(id)) {
          throw new PlanParseError(
            `case id "${id}" does not match the section key "${currentSection.key}" (expected ${currentSection.key}1, ${currentSection.key}2, …)`,
            index + 1
          );
        }
        for (const section of sections) {
          if (section.cases.some((existingCase) => existingCase.id === id)) {
            throw new PlanParseError(`duplicate case id "${id}"`, index + 1);
          }
        }
        currentSection.cases.push({
          id,
          do: doText,
          expect: expectText,
          superseded: doText.startsWith('~~'),
        });
      }
      currentSection.blocks.push({ kind: 'cases' });
      continue;
    }

    if (/^---\s*$/.test(line)) {
      flushParagraph();
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    // Plain prose — accumulate hard-wrapped lines into one paragraph.
    if (paragraph) {
      paragraph.text += ' ' + line.trim();
    } else {
      paragraph = { text: line.trim(), startLine: lineNumber };
    }
  }
  flushParagraph();

  if (record === null) {
    throw new PlanParseError('missing the required "## Execution record" section', lines.length);
  }
  for (const canonical of CANONICAL_RECORD_FIELDS) {
    if (!record.some((field) => field.label === canonical.label)) {
      throw new PlanParseError(
        `the Execution record table is missing the "${canonical.label}" field`,
        lines.length
      );
    }
  }
  if (lanes === null) {
    throw new PlanParseError('the plan contains no case table', lines.length);
  }

  return { token: featureToken, lanes, record, sections };
}
