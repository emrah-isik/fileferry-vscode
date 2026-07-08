import type { OutputChannel, ViewColumn } from 'vscode';

const MASK = '••••';

// An OutputChannel wrapper that replaces known secret values with •••• in
// everything written through it (#27b). HookRunner registers each value it
// resolves from a ${secret:NAME} reference via registerSecretValues.
//
// Deliberate under-promise: this masks values FileFerry itself resolved,
// nothing more. A hook that prints a secret we never handled prints it
// verbatim — the docs say "FileFerry masks values it knows about", never
// "output is safe".
export class SecretMaskingOutputChannel implements OutputChannel {
  // Longest first, so an overlapping shorter value can't leave a partial leak
  // (masking "abc" inside "abcdef" would expose "def").
  private secretValues: string[] = [];

  constructor(private readonly inner: OutputChannel) {}

  get name(): string {
    return this.inner.name;
  }

  registerSecretValues(values: string[]): void {
    for (const value of values) {
      if (value.length > 0 && !this.secretValues.includes(value)) {
        this.secretValues.push(value);
      }
    }
    this.secretValues.sort((first, second) => second.length - first.length);
  }

  private mask(text: string): string {
    let masked = text;
    for (const value of this.secretValues) {
      // split/join replaces literally — no regular-expression escaping issues.
      masked = masked.split(value).join(MASK);
    }
    return masked;
  }

  append(value: string): void {
    this.inner.append(this.mask(value));
  }

  appendLine(value: string): void {
    this.inner.appendLine(this.mask(value));
  }

  replace(value: string): void {
    this.inner.replace(this.mask(value));
  }

  clear(): void {
    this.inner.clear();
  }

  show(columnOrPreserveFocus?: ViewColumn | boolean, preserveFocus?: boolean): void {
    this.inner.show(columnOrPreserveFocus as ViewColumn, preserveFocus);
  }

  hide(): void {
    this.inner.hide();
  }

  dispose(): void {
    this.inner.dispose();
  }
}
