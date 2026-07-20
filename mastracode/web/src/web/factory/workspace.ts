import { existsSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDynamicWorkspace } from '@mastra/code-sdk/agents/workspace';
import type { WorkspaceSkillExtension } from '@mastra/code-sdk/agents/workspace';
import { LocalSandbox, LocalSkillSource } from '@mastra/core/workspace';
import { Workspace, type SkillSource, type SkillSourceEntry, type SkillSourceStat } from '@mastra/core/workspace';
import type { MastraFactorySandboxConfig } from '../factory-entry';
import { MASTRACODE_WORKSPACE_TOOLS } from '@mastra/code-sdk/agents/tool-availability';
import type { AgentControllerRequestContext } from '@mastra/core/agent-controller';
import type { MastraCodeState } from '@mastra/code-sdk/schema';
import { DEFAULT_CONFIG_DIR } from '@mastra/code-sdk/constants';
import { SandboxFilesystem } from '@mastra/code-sdk/agents/sandbox-filesystem';
import { checkoutSessionBranch, materializeRepo, runWorktreeSetup } from '../github/sandbox';
import { getSeededGithubIntegration } from '../runtime-config';
import { computeLocalSessionSandboxWorkdir, ensureSandbox } from '../sandbox/fleet';
import type { SandboxBindingStore } from '../sandbox/fleet';
import type { WebAuthUser } from '../auth-adapter';

const WORKSPACE_ID_PREFIX = 'mfw';
const SESSION_CHECKPOINT_PREFIX = 'mastracode-session';

export function checkpointNameForSession(sessionId: string): string {
  return `${SESSION_CHECKPOINT_PREFIX}-${sessionId}`;
}

const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const bundledFactorySkillsPath = join(bundleDirectory, 'factory-skills');
const FACTORY_SKILLS_SOURCE_PATH =
  [
    join(process.cwd(), 'src', 'mastra', 'public', 'factory-skills'),
    join(bundleDirectory, '..', '..', 'src', 'mastra', 'public', 'factory-skills'),
    bundledFactorySkillsPath,
  ].find(existsSync) ?? bundledFactorySkillsPath;
const FACTORY_SKILLS_MOUNT = path.resolve(path.parse(process.cwd()).root, '__mastracode_factory_skills__');
const FACTORY_SKILL_NAMES = new Set(['understand-issue', 'understand-pr']);

class FactorySkillSource implements SkillSource {
  readonly #factorySource = new LocalSkillSource({ basePath: FACTORY_SKILLS_SOURCE_PATH });
  readonly #fallbackSkillRoots: Set<string>;

  constructor(
    readonly fallback: SkillSource,
    fallbackSkillRoots: string[],
  ) {
    this.#fallbackSkillRoots = new Set(fallbackSkillRoots.map(skillPath => path.normalize(skillPath)));
  }

  #isFactoryPath(skillPath: string): boolean {
    const normalized = path.normalize(skillPath);
    return normalized === FACTORY_SKILLS_MOUNT || normalized.startsWith(`${FACTORY_SKILLS_MOUNT}${path.sep}`);
  }

  #factoryPath(skillPath: string): string {
    return path.relative(FACTORY_SKILLS_MOUNT, path.normalize(skillPath));
  }

  exists(skillPath: string): Promise<boolean> {
    return this.#isFactoryPath(skillPath)
      ? this.#factorySource.exists(this.#factoryPath(skillPath))
      : this.fallback.exists(skillPath);
  }

  stat(skillPath: string): Promise<SkillSourceStat> {
    return this.#isFactoryPath(skillPath)
      ? this.#factorySource.stat(this.#factoryPath(skillPath))
      : this.fallback.stat(skillPath);
  }

  readFile(skillPath: string): Promise<string | Buffer> {
    return this.#isFactoryPath(skillPath)
      ? this.#factorySource.readFile(this.#factoryPath(skillPath))
      : this.fallback.readFile(skillPath);
  }

  async readdir(skillPath: string): Promise<SkillSourceEntry[]> {
    if (this.#isFactoryPath(skillPath)) {
      return this.#factorySource.readdir(this.#factoryPath(skillPath));
    }
    const entries = await this.fallback.readdir(skillPath);
    if (this.#fallbackSkillRoots.has(path.normalize(skillPath))) {
      return entries.filter(entry => !FACTORY_SKILL_NAMES.has(entry.name));
    }
    return entries;
  }

  realpath(skillPath: string): Promise<string> {
    if (this.#isFactoryPath(skillPath)) return Promise.resolve(path.normalize(skillPath));
    return this.fallback.realpath ? this.fallback.realpath(skillPath) : Promise.resolve(skillPath);
  }
}

const factorySkillExtension: WorkspaceSkillExtension = {
  id: 'web-factory',
  paths: [FACTORY_SKILLS_MOUNT],
  createSource: (fallback, fallbackSkillRoots) => new FactorySkillSource(fallback, fallbackSkillRoots),
};

type DynamicWorkspaceContext = Parameters<typeof getDynamicWorkspace>[0];

export function createWorkspaceFactory(sandboxConfig?: MastraFactorySandboxConfig) {
  const hasSandboxProvider = Boolean(sandboxConfig);
  const isLocalSandbox = sandboxConfig?.machine instanceof LocalSandbox;

  return async ({ requestContext, mastra, skillExtension }: DynamicWorkspaceContext) => {
    const effectiveSkillExtension = skillExtension ?? factorySkillExtension;
    const ctx = requestContext.get('controller') as AgentControllerRequestContext<MastraCodeState> | undefined;
    const user = requestContext.get('user') as WebAuthUser | undefined;

    const shouldPrepareGithubSession = hasSandboxProvider && Boolean(ctx?.resourceId) && Boolean(ctx?.scope);

    if (shouldPrepareGithubSession) {
      if (!ctx?.resourceId) {
        throw new Error('Resource ID is required to create a sandbox workspace');
      }
      if (!ctx.scope) {
        throw new Error('Session scope is required to create a GitHub workspace');
      }

      if (!user?.organizationId) {
        throw new Error('Organization ID is required to create a sandbox workspace');
      }
      if (!user.workosId) {
        throw new Error('User ID is required to create a sandbox workspace');
      }

      const github = getSeededGithubIntegration();
      if (!github) {
        throw new Error('GitHub integration is required to create a sandbox workspace');
      }
      const storage = github.storageDomain;
      const project = await storage.getOrgProject(user.organizationId, ctx.resourceId);

      if (!project) {
        throw new Error(`Project with id ${ctx.resourceId} not found. Something went wrong during session creation.`);
      }

      const session = await storage.getSession(ctx.scope);
      if (!session || session.githubProjectId !== project.id || session.userId !== user.workosId) {
        throw new Error(`GitHub session ${ctx.scope} not found for project ${ctx.resourceId}`);
      }

      const workdir = isLocalSandbox
        ? computeLocalSessionSandboxWorkdir(project.repoFullName, session.id)
        : (session.sandboxWorkdir ?? project.sandboxWorkdir);
      const binding: SandboxBindingStore = {
        sandboxId: session.sandboxId,
        checkpointName: checkpointNameForSession(session.id),
        setSandboxId: async id => {
          await storage.setSessionSandbox(session.id, id, workdir);
          session.sandboxId = id;
          session.sandboxWorkdir = workdir;
        },
        clear: async () => {
          await storage.setSessionSandbox(session.id, null, project.sandboxWorkdir);
          session.sandboxId = null;
          session.sandboxWorkdir = project.sandboxWorkdir;
        },
      };

      const extensionId = effectiveSkillExtension ? `-${effectiveSkillExtension.id}` : '';
      const workspaceId = `${WORKSPACE_ID_PREFIX}-${project.id}-${session.id}${extensionId}`;
      const configDir = sandboxConfig?.workdir ?? DEFAULT_CONFIG_DIR;

      // Reuse the existing remote workspace if already registered (preserves the
      // reattached sandbox + ProcessManager state across re-opens).
      try {
        const existing = mastra?.getWorkspaceById(workspaceId) as Workspace | undefined;
        if (existing) {
          existing.setToolsConfig(MASTRACODE_WORKSPACE_TOOLS);
          return existing;
        }
      } catch {
        // Not registered yet.
      }

      const token = await github.mintInstallationToken(project.installationId);

      if (!token) {
        throw new Error('GitHub token could not be generated. Something went wrong during session creation.');
      }

      const sandbox = await ensureSandbox(
        binding,
        {
          GH_TOKEN: token,
        },
        undefined,
        isLocalSandbox ? { workingDirectory: workdir } : {},
      );
      await materializeRepo(
        { ...session, sandboxWorkdir: workdir, materializedAt: null },
        { repoFullName: project.repoFullName, defaultBranch: project.defaultBranch },
        sandbox,
        token,
        storage,
        undefined,
        async () => {
          await storage.setSessionSandbox(session.id, session.sandboxId, workdir);
        },
      );
      await checkoutSessionBranch(sandbox, workdir, {
        branch: session.branch,
        baseBranch: session.baseBranch || project.defaultBranch,
        token,
        repoFullName: project.repoFullName,
      });
      if (project.setupCommand) {
        await runWorktreeSetup(sandbox, workdir, project.setupCommand);
      }

      const filesystem = new SandboxFilesystem({ sandbox, workdir: workdir });
      const projectSkillPaths = [path.join(configDir, 'skills'), '.claude/skills', '.agents/skills'];
      const skillPaths = [...(effectiveSkillExtension?.paths ?? []), ...projectSkillPaths];

      return new Workspace({
        id: workspaceId,
        name: 'Mastra Code Sandbox Workspace',
        filesystem,
        sandbox: sandbox as unknown as ConstructorParameters<typeof Workspace>[0]['sandbox'],
        tools: MASTRACODE_WORKSPACE_TOOLS,
        skills: skillPaths,
        skillSource: effectiveSkillExtension?.createSource(filesystem, projectSkillPaths) ?? filesystem,
      });
    }

    if (hasSandboxProvider && !isLocalSandbox) {
      throw new Error('Resource ID and session scope are required to create a remote sandbox workspace');
    }

    return getDynamicWorkspace({ requestContext, mastra, skillExtension: effectiveSkillExtension });
  };
}

export const getFactoryWorkspace = createWorkspaceFactory();
