import { reattachSandbox } from '../sandbox/fleet.js';
import type { GithubIntegration } from './integration.js';
import { withProjectLock } from './project-lock.js';
import { ensureWorktree, MaterializeError, runWorktreeSetup } from './sandbox.js';
import type { GithubProjectRow } from './storage/base.js';

export async function ensureFactoryRuleWorktree(
  github: GithubIntegration,
  project: GithubProjectRow,
  branch: string,
): Promise<string> {
  const sandboxRow = await github.storageDomain.getOrCreateSandbox(project, project.userId);
  if (!sandboxRow.sandboxId) {
    throw new MaterializeError('Project sandbox is not provisioned. Open the project first.', 'clone-failed');
  }

  return withProjectLock(`${project.id}:${project.userId}`, async () => {
    const sandbox = await reattachSandbox(sandboxRow.sandboxId!);
    const token = await github.mintInstallationToken(project.installationId);
    const result = await ensureWorktree(sandbox, sandboxRow.sandboxWorkdir, {
      branch,
      baseBranch: project.defaultBranch,
      token,
      repoFullName: project.repoFullName,
    });
    if (!result.reused && project.setupCommand) {
      await runWorktreeSetup(sandbox, result.worktreePath, project.setupCommand);
    }
    await github.storageDomain.upsertWorktree({
      orgId: project.orgId,
      userId: project.userId,
      githubProjectId: project.id,
      branch: result.branch,
      baseBranch: result.baseBranch,
      worktreePath: result.worktreePath,
    });
    return result.worktreePath;
  });
}
