import { useEffect, useState } from 'react';

import {
  DEFAULT_RESOURCE_ID,
  isGithubFactory,
  loadActiveFactoryId,
  saveActiveFactoryId,
} from '../../web/ui/domains/workspaces/services/factories';
import type { Factory } from '../../web/ui/domains/workspaces/services/factories';
import { useFactoriesQuery } from './useFactories';

/** Live sandbox-preparation feedback while a GitHub factory is being opened. */
export interface PreparingState {
  factoryId: string;
  message: string;
}

export function useActiveFactory() {
  const { data: factories } = useFactoriesQuery();
  const [selectedFactoryId, setSelectedFactoryId] = useState<string | null>(() => loadActiveFactoryId());
  // Derived: a selection pointing at a deleted factory counts as no selection.
  const activeFactoryId =
    selectedFactoryId && factories.some(factory => factory.id === selectedFactoryId) ? selectedFactoryId : null;
  const activeFactory = factories.find(factory => factory.id === activeFactoryId) ?? null;
  const githubProjectResourceId = activeFactory && isGithubFactory(activeFactory) ? activeFactory.binding.githubProjectId : undefined;
  const resourceId = activeFactory?.resourceId ?? githubProjectResourceId ?? DEFAULT_RESOURCE_ID;
  const sessionEnabled = !!activeFactory;

  // Persisting to localStorage is external-system sync; keep as an effect.
  useEffect(() => {
    saveActiveFactoryId(activeFactoryId);
  }, [activeFactoryId]);

  const selectFactory = async (factory: Factory | null) => {
    setSelectedFactoryId(factory?.id ?? null);
  };

  return {
    factories,
    activeFactory,
    resourceId,
    sessionEnabled,
    selectFactory,
    preparing: null as PreparingState | null,
    prepareError: null as (Error & { code?: string }) | null,
  };
}
