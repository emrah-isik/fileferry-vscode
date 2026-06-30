import * as path from 'path';
import type { OutputChannel } from 'vscode';
import { ResolvedUploadItem } from '../path/PathResolver';
import { ProjectServer } from '../models/ProjectConfig';

export interface DryRunPlan {
  serverName: string;
  uploadItems: ResolvedUploadItem[];
  deleteRemotePaths: string[];
  workspaceRoot: string;
  hooks?: ProjectServer['hooks'];
}

export class DryRunReporter {
  constructor(private readonly output: OutputChannel) {}

  report(plans: DryRunPlan[]): void {
    this.output.appendLine('──── DRY RUN ────────────────────────────');

    for (const plan of plans) {
      this.output.appendLine(`Server: ${plan.serverName}`);

      for (const item of plan.uploadItems) {
        const rel = path.relative(plan.workspaceRoot, item.localPath);
        this.output.appendLine(`  UPLOAD  ${rel} → ${item.remotePath}`);
      }

      for (const remotePath of plan.deleteRemotePaths) {
        this.output.appendLine(`  DELETE  ${remotePath}`);
      }

      // List the hooks that would run, so a dry run previews shell commands too
      // (the deploy path short-circuits before the orchestrator under dry run).
      for (const hook of plan.hooks?.preDeploy ?? []) {
        this.output.appendLine(`  HOOK (pre, ${hook.location})  ${hook.command}`);
      }
      for (const hook of plan.hooks?.postDeploy ?? []) {
        this.output.appendLine(`  HOOK (post, ${hook.location})  ${hook.command}`);
      }

      this.output.appendLine(
        `  Summary: ${plan.uploadItems.length} file(s) would be uploaded, ${plan.deleteRemotePaths.length} file(s) would be deleted`
      );

      if (plans.length > 1) {
        this.output.appendLine('');
      }
    }

    this.output.appendLine('──────────────────────────────────────────');
    this.output.show(true);
  }
}
