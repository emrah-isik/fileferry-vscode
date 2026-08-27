import * as fs from 'node:fs';
import * as path from 'node:path';
import { parsePlan } from '../../../tools/manualTestTracker/parser';
import { injectTrackerData, DATA_MARKER } from '../../../tools/manualTestTracker/injector';
import { runTrackerHeadless } from './headlessTracker';
import { buildPlan } from './syntheticPlan';

const templatePath = path.join(__dirname, '../../../tools/manualTestTracker/template.html');
const templateHtml = fs.readFileSync(templatePath, 'utf8');

const syntheticData = parsePlan(buildPlan(), '77');
const STATE_KEY = 'ff77-testrun-v1';

describe('injectTrackerData', () => {
  it('the committed template carries the marker exactly once', () => {
    expect(templateHtml.split(DATA_MARKER).length - 1).toBe(1);
  });

  it('replaces the marker with the serialized plan data', () => {
    const html = injectTrackerData(templateHtml, syntheticData);
    expect(html).not.toContain(DATA_MARKER);
    expect(html).toContain('"token":"77"');
    expect(html).toContain('"lanes":["SFTP","FTP"]');
  });

  it('throws when the marker is missing', () => {
    expect(() => injectTrackerData('<html>no marker</html>', syntheticData)).toThrow(/marker/);
  });

  it('escapes < so case text can never terminate the script block early', () => {
    const plan = buildPlan({
      sections: [
        '## A. Alpha (77a)',
        '',
        '| # | Do | Expect | SFTP |',
        '| --- | --- | --- | --- |',
        '| A1 | Type `</script>` into the field. | Nothing breaks. | |',
      ],
    });
    const html = injectTrackerData(templateHtml, parsePlan(plan, '77'));
    const closingTags = html.split('</script>').length - 1;
    expect(closingTags).toBe(1);
  });
});

describe('generated tracker — headless load check', () => {
  it('boots from a fresh state, renders every case, and probes storage', async () => {
    const html = injectTrackerData(templateHtml, syntheticData);
    const tracker = await runTrackerHeadless(html);

    expect(tracker.title).toBe('FileFerry · feature/77 manual pass');

    const rendered = tracker.renderLog.join('\n');
    for (const caseId of ['A1', 'A2', 'A3', 'B1']) {
      expect(rendered).toContain(caseId);
    }
    expect(rendered).toContain('echo seed-main');
    expect(rendered).toContain('echo cleanup');

    // 3 non-superseded cases (A3 is superseded) × 2 lanes = 6 cells.
    expect(tracker.elementById('tally').innerHTML).toBe('<b>0</b>/6 checks');
    expect(tracker.storage.get(STATE_KEY + '.probe')).toBe('1');
    expect(tracker.elementById('savenote').textContent).toContain('browser storage only');
  });

  it('renders one nav chip per section that has cases', async () => {
    const html = injectTrackerData(templateHtml, syntheticData);
    const tracker = await runTrackerHeadless(html);
    const chipLabels = tracker
      .elementById('chips')
      .children.map((chip: { textContent: string }) => chip.textContent);
    expect(chipLabels).toEqual(['A 0/4', 'B 0/2']);
  });

  it('loads previously recorded results from storage under the ff<token>-testrun-v1 key', async () => {
    const savedState = JSON.stringify({
      record: { date: '2026-01-01', commit: 'abc1234', verdict: '' },
      cells: {
        'A1.SFTP': { s: 'ok', i: '' },
        'A2.FTP': { s: 'fail', i: '#9' },
      },
    });
    const html = injectTrackerData(templateHtml, syntheticData);
    const tracker = await runTrackerHeadless(html, { storage: { [STATE_KEY]: savedState } });

    expect(tracker.elementById('tally').innerHTML).toContain('<b>2</b>/6 checks');
    expect(tracker.elementById('tally').innerHTML).toContain('1 FAIL');
    expect(tracker.renderLog.join('\n')).toContain('2026-01-01');
  });

  describe('Mark PASS button', () => {
    const allOk = {
      'A1.SFTP': { s: 'ok', i: '' }, 'A1.FTP': { s: 'ok', i: '' },
      'A2.SFTP': { s: 'ok', i: '' }, 'A2.FTP': { s: 'ok', i: '' },
      'B1.SFTP': { s: 'ok', i: '' }, 'B1.FTP': { s: 'ok', i: '' },
    };
    const today = () => new Date().toLocaleDateString('en-CA');

    it('is disabled while any cell is still unrecorded or FAIL', async () => {
      const savedState = JSON.stringify({
        record: { date: '', commit: '', verdict: '' },
        cells: { ...allOk, 'B1.FTP': { s: 'fail', i: '#9' } },
      });
      const html = injectTrackerData(templateHtml, syntheticData);
      const tracker = await runTrackerHeadless(html, { storage: { [STATE_KEY]: savedState } });
      expect(tracker.elementById('markPassBtn').disabled).toBe(true);
    });

    it('is enabled once every cell is ok', async () => {
      const savedState = JSON.stringify({ record: { date: '', commit: '', verdict: '' }, cells: allOk });
      const html = injectTrackerData(templateHtml, syntheticData);
      const tracker = await runTrackerHeadless(html, { storage: { [STATE_KEY]: savedState } });
      expect(tracker.elementById('markPassBtn').disabled).toBe(false);
    });

    it('stamps the date and a PASS verdict, keeps the commit field, and saves', async () => {
      const savedState = JSON.stringify({ record: { date: '', commit: 'abc1234', verdict: '' }, cells: allOk });
      const html = injectTrackerData(templateHtml, syntheticData);
      const tracker = await runTrackerHeadless(html, { storage: { [STATE_KEY]: savedState } });

      tracker.elementById('markPassBtn').onclick();
      await new Promise((resolve) => setTimeout(resolve, 500)); // debounced autosave

      const saved = JSON.parse(tracker.storage.get(STATE_KEY)!);
      expect(saved.record.date).toBe(today());
      expect(saved.record.verdict).toBe('PASS — 6/6 ok');
      expect(saved.record.commit).toBe('abc1234');
      expect(tracker.renderLog.join('\n')).toContain('PASS — 6/6 ok');
    });

    it('does not overwrite an existing verdict without confirmation', async () => {
      const savedState = JSON.stringify({
        record: { date: '2026-01-01', commit: '', verdict: 'FAIL — see #9' },
        cells: allOk,
      });
      const html = injectTrackerData(templateHtml, syntheticData);
      // the headless harness answers every confirm() with false
      const tracker = await runTrackerHeadless(html, { storage: { [STATE_KEY]: savedState } });

      tracker.elementById('markPassBtn').onclick();
      await new Promise((resolve) => setTimeout(resolve, 500));

      const saved = JSON.parse(tracker.storage.get(STATE_KEY)!);
      expect(saved.record.verdict).toBe('FAIL — see #9');
      expect(saved.record.date).toBe('2026-01-01');
    });
  });
});
