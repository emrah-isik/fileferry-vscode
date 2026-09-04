import { resolveUploadOnSave } from '../../../services/uploadOnSaveResolution';

// Feature 35a: a server's own `uploadOnSave` wins over the project toggle;
// an absent field inherits it. The resolver is the ONE place that rule lives.
describe('resolveUploadOnSave', () => {
  it.each([
    [undefined, undefined, false, 'project'],
    [true, undefined, true, 'project'],
    [false, undefined, false, 'project'],
    [undefined, true, true, 'server'],
    [undefined, false, false, 'server'],
    [true, false, false, 'server'],
    [false, true, true, 'server'],
    [true, true, true, 'server'],
  ] as const)('project=%s server=%s → enabled=%s from %s', (project, server, enabled, source) => {
    expect(resolveUploadOnSave({ uploadOnSave: project }, { uploadOnSave: server })).toEqual({ enabled, source });
  });

  it('treats a missing server (no default server resolved) as inherit', () => {
    expect(resolveUploadOnSave({ uploadOnSave: true }, undefined)).toEqual({ enabled: true, source: 'project' });
    expect(resolveUploadOnSave({}, undefined)).toEqual({ enabled: false, source: 'project' });
  });
});
