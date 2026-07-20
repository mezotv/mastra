/**
 * BDD coverage for `ActiveFactoryProvider` (`domains/workspaces/context`).
 *
 * The provider exposes the existing `useActiveFactory()` hook through context
 * so factory selection is consumed via `useActiveFactoryContext()` instead of
 * being prop-drilled from the chat composition root. GitHub factories are
 * selected without project-level materialization; scoped sessions prepare their
 * checkouts through the server-side workspace factory.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../../../../../e2e/web-ui/msw-server';
import { TEST_BASE_URL, renderWithProviders } from '../../../../../../../e2e/web-ui/render';
import { isGithubFactory, loadFactories } from '../../services/factories';
import type { Factory, GithubFactory, LocalFactory } from '../../services/factories';
import { ActiveFactoryProvider, useActiveFactoryContext } from '../ActiveFactoryProvider';

const LOCAL_FACTORY: LocalFactory = {
  id: 'factory-test',
  name: 'MastraCode Test',
  resourceId: 'resource-test',
  createdAt: 1,
  binding: {
    kind: 'local',
    path: '/tmp/mastracode-test',
  },
};

const GITHUB_FACTORY: GithubFactory = {
  id: 'factory-gh',
  name: 'octo/hello',
  createdAt: 2,
  binding: {
    kind: 'github',
    githubProjectId: 'ghp_1',
    worktrees: [],
  },
};

const ENSURE_URL = `${TEST_BASE_URL}/web/github/repositories/ghp_1/ensure`;

afterEach(() => {
  localStorage.clear();
});

function seedFactory(factory: Factory = LOCAL_FACTORY, active = true) {
  localStorage.setItem('mastracode-factories', JSON.stringify([factory]));
  if (active) localStorage.setItem('mastracode-active-factory', factory.id);
}

function Probe({ selectTarget }: { selectTarget?: Factory }) {
  const api = useActiveFactoryContext();
  const { factories, activeFactory, resourceId, sessionEnabled, selectFactory, preparing, prepareError } = api;
  return (
    <div>
      <span data-testid="factory-count">{factories.length}</span>
      <span data-testid="active-factory">{activeFactory?.name ?? '(none)'}</span>
      <span data-testid="active-factory-id">{activeFactory?.id ?? '(none)'}</span>
      <span data-testid="has-legacy-id-field">{'activeFactoryId' in api ? 'yes' : 'no'}</span>
      <span data-testid="resource-id">{resourceId}</span>
      <span data-testid="session-enabled">{sessionEnabled ? 'yes' : 'no'}</span>
      <span data-testid="preparing">{preparing?.message ?? '(idle)'}</span>
      <span data-testid="prepare-error">{prepareError?.message ?? '(none)'}</span>
      <button onClick={() => void selectFactory(null)}>clear selection</button>
      {selectTarget && <button onClick={() => void selectFactory(selectTarget)}>select target</button>}
    </div>
  );
}

function renderProbe(selectTarget?: Factory) {
  return renderWithProviders(
    <ActiveFactoryProvider>
      <Probe selectTarget={selectTarget} />
    </ActiveFactoryProvider>,
  );
}

describe('ActiveFactoryProvider', () => {
  it('given a seeded active factory, then it exposes the factories and active selection', async () => {
    seedFactory();
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('active-factory')).toHaveTextContent('MastraCode Test'));
    expect(screen.getByTestId('factory-count')).toHaveTextContent('1');
    expect(screen.getByTestId('active-factory-id')).toHaveTextContent('factory-test');
    expect(screen.getByTestId('resource-id')).toHaveTextContent('resource-test');
    expect(screen.getByTestId('session-enabled')).toHaveTextContent('yes');
    // `activeFactory` is the canonical field; the redundant id field is gone.
    expect(screen.getByTestId('has-legacy-id-field')).toHaveTextContent('no');
  });

  it('given an active factory, when selectFactory(null) is called, then the selection clears', async () => {
    seedFactory();
    renderProbe();

    await waitFor(() => expect(screen.getByTestId('active-factory')).toHaveTextContent('MastraCode Test'));
    await userEvent.click(screen.getByRole('button', { name: 'clear selection' }));

    expect(screen.getByTestId('active-factory')).toHaveTextContent('(none)');
    expect(screen.getByTestId('active-factory-id')).toHaveTextContent('(none)');
    expect(screen.getByTestId('session-enabled')).toHaveTextContent('no');
  });

  it('given no provider, when useActiveFactoryContext is called, then it throws a descriptive error', () => {
    expect(() => render(<Probe />)).toThrow('useActiveFactoryContext must be used within an ActiveFactoryProvider');
  });

  describe('GitHub factories', () => {
    it('given a GitHub factory, when selected, then it activates without project-level materialization', async () => {
      const ensureRequested = vi.fn();
      seedFactory(GITHUB_FACTORY, false);
      server.use(
        http.post(ENSURE_URL, () => {
          ensureRequested();
          return HttpResponse.json({ error: 'unexpected_ensure' }, { status: 500 });
        }),
      );
      renderProbe(GITHUB_FACTORY);

      await waitFor(() => expect(screen.getByTestId('factory-count')).toHaveTextContent('1'));
      await userEvent.click(screen.getByRole('button', { name: 'select target' }));

      await waitFor(() => expect(screen.getByTestId('active-factory')).toHaveTextContent('octo/hello'));
      expect(screen.getByTestId('resource-id')).toHaveTextContent('ghp_1');
      expect(screen.getByTestId('session-enabled')).toHaveTextContent('yes');
      expect(screen.getByTestId('preparing')).toHaveTextContent('(idle)');
      expect(screen.getByTestId('prepare-error')).toHaveTextContent('(none)');
      expect(ensureRequested).not.toHaveBeenCalled();

      const stored = loadFactories().find(factory => factory.id === 'factory-gh');
      expect(isGithubFactory(stored!)).toBe(true);
      if (!isGithubFactory(stored!)) throw new Error('expected github factory');
      expect(stored.resourceId).toBeUndefined();
      expect(stored.binding.worktrees).toEqual([]);
      expect(stored.id).not.toBe(stored.binding.githubProjectId);
    });

    it('given a GitHub factory selection after a local factory, then the GitHub repository id becomes the resource id', async () => {
      localStorage.setItem('mastracode-factories', JSON.stringify([LOCAL_FACTORY, GITHUB_FACTORY]));
      localStorage.setItem('mastracode-active-factory', LOCAL_FACTORY.id);

      renderProbe(GITHUB_FACTORY);

      await waitFor(() => expect(screen.getByTestId('active-factory')).toHaveTextContent('MastraCode Test'));
      await userEvent.click(screen.getByRole('button', { name: 'select target' }));

      await waitFor(() => expect(screen.getByTestId('active-factory')).toHaveTextContent('octo/hello'));
      expect(screen.getByTestId('resource-id')).toHaveTextContent('ghp_1');
      expect(screen.getByTestId('session-enabled')).toHaveTextContent('yes');
      expect(screen.getByTestId('prepare-error')).toHaveTextContent('(none)');
    });
  });
});
