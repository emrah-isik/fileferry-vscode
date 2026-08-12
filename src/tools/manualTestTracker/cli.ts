// Thin CLI for the tracker generator: npm run tracker -- <feature>
// Reads docs/plans/manual_tests/feature_<token>_manual_test_plan.md, parses it
// strictly, and writes the tracker next to the existing ones. Paths are
// hardcoded relative to the repo root by design — the tool is repo-specific.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePlan, PlanParseError } from './parser';
import { injectTrackerData } from './injector';

export const USAGE = 'usage: npm run tracker -- <feature>   (a feature token like 33, 27b, or 33a)';

export interface CliArguments {
  featureToken: string;
}

export function parseArguments(argv: string[]): CliArguments {
  if (argv.length !== 1) {
    throw new Error(USAGE);
  }
  const featureToken = argv[0];
  if (!/^[A-Za-z0-9]+$/.test(featureToken)) {
    throw new Error(`invalid feature token "${featureToken}" — letters and digits only\n${USAGE}`);
  }
  return { featureToken };
}

export interface TrackerPaths {
  planPath: string;
  templatePath: string;
  trackerPath: string;
}

export function deriveTrackerPaths(repositoryRoot: string, featureToken: string): TrackerPaths {
  return {
    planPath: path.join(
      repositoryRoot,
      'docs/plans/manual_tests',
      `feature_${featureToken}_manual_test_plan.md`
    ),
    templatePath: path.join(repositoryRoot, 'src/tools/manualTestTracker/template.html'),
    trackerPath: path.join(
      repositoryRoot,
      'docs/plans/manual_tests/trackers',
      `feature_${featureToken}_manual_test_tracker.html`
    ),
  };
}

/** Both out/tools/manualTestTracker (compiled) and src/tools/manualTestTracker
 *  (ts-jest) sit three levels below the repo root. */
export function repositoryRootFromModuleDirectory(moduleDirectory: string): string {
  return path.resolve(moduleDirectory, '../../..');
}

export function main(
  argv: string[],
  repositoryRoot: string = repositoryRootFromModuleDirectory(__dirname)
): number {
  let cliArguments: CliArguments;
  try {
    cliArguments = parseArguments(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const { featureToken } = cliArguments;
  const { planPath, templatePath, trackerPath } = deriveTrackerPaths(repositoryRoot, featureToken);

  let planMarkdown: string;
  try {
    planMarkdown = fs.readFileSync(planPath, 'utf8');
  } catch {
    console.error(`no manual test plan for feature ${featureToken} at ${planPath}`);
    return 1;
  }

  let trackerHtml: string;
  try {
    const templateHtml = fs.readFileSync(templatePath, 'utf8');
    const data = parsePlan(planMarkdown, featureToken);
    trackerHtml = injectTrackerData(templateHtml, data);

    fs.mkdirSync(path.dirname(trackerPath), { recursive: true });
    fs.writeFileSync(trackerPath, trackerHtml);

    const caseCount = data.sections.reduce((count, section) => count + section.cases.length, 0);
    const supersededCount = data.sections.reduce(
      (count, section) => count + section.cases.filter((testCase) => testCase.superseded).length,
      0
    );
    const cellCount = (caseCount - supersededCount) * data.lanes.length;
    console.log(
      `wrote ${trackerPath}\n` +
        `  sections: ${data.sections.length}, cases: ${caseCount}` +
        ` (${supersededCount} superseded), lanes: ${data.lanes.join(', ')} → ${cellCount} cells\n` +
        `  state key: ff${featureToken}-testrun-v1`
    );
    return 0;
  } catch (error) {
    if (error instanceof PlanParseError) {
      console.error(`${planPath}: ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
