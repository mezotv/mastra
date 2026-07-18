import type { FactoryRuleJsonValue } from '../factory/rules/types.js';
import type { FactoryRunBindingRecord, WorkItemRow } from '../storage/domains/work-items/base.js';
import type { GithubIntegration } from './integration.js';
import { parseCreatedPullRequest } from './session-subscriptions.js';

export interface RecordFactoryPullRequestProvenanceInput {
  binding: FactoryRunBindingRecord;
  item: WorkItemRow;
  assistantMessageId: string;
  toolCallId: string;
  toolName: string;
  toolInput: FactoryRuleJsonValue;
  toolResult: FactoryRuleJsonValue;
  status: 'success' | 'error';
}

export async function recordFactoryPullRequestProvenance(
  github: GithubIntegration,
  input: RecordFactoryPullRequestProvenanceInput,
): Promise<void> {
  if (input.status !== 'success' || input.item.source === 'github-pr') return;
  const url = parseCreatedPullRequest({
    toolName: input.toolName,
    input: input.toolInput,
    output: input.toolResult,
  });
  if (!url) return;

  try {
    const project = await github.storageDomain.getOrgProject(input.binding.orgId, input.binding.githubProjectId);
    if (!project) return;
    const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/i);
    if (!match || match[1]!.toLowerCase() !== project.repoFullName.toLowerCase()) return;
    const pullRequestNumber = Number(match[2]);
    const [owner, repo] = project.repoFullName.split('/');
    if (!owner || !repo || !Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) return;
    if (await github.storageDomain.getPullRequestProvenance(project.id, project.repoId, pullRequestNumber)) return;

    const { data } = await github
      .getInstallationOctokit(project.installationId)
      .pulls.get({ owner, repo, pull_number: pullRequestNumber });
    if (data.base.repo.id !== project.repoId || data.number !== pullRequestNumber || data.html_url !== url) return;

    await github.storageDomain.recordPullRequestProvenance({
      orgId: input.binding.orgId,
      githubProjectId: project.id,
      bindingId: input.binding.id,
      workItemId: input.item.id,
      repositoryId: project.repoId,
      pullRequestNumber,
      pullRequestUrl: url,
      threadId: input.binding.threadId,
      assistantMessageId: input.assistantMessageId,
      toolCallId: input.toolCallId,
    });
  } catch {
    return;
  }
}
