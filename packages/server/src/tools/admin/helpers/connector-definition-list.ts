import { EMPTY_SUMMARY } from '../../../operations/catalog';
import { listCatalogConnectorDefinitions } from '../../../utils/connector-catalog';
import { connectorSourcePathToUri } from '../../../utils/connector-definition-install';
import type { ScopedConnectorDefinitionRow } from '../connector-definition-helpers';

type OperationsSummary = typeof EMPTY_SUMMARY;

type ListedConnectorDefinition = Omit<ScopedConnectorDefinitionRow, 'source_path'> & {
  source_uri: string | null;
  installed: boolean;
  installable: boolean;
  catalog_origin: 'org' | 'catalog';
  operations_summary: OperationsSummary;
  has_operations: boolean;
};

function mapInstalledConnectorDefinitions(
  rows: ScopedConnectorDefinitionRow[],
  summaries: Map<string, OperationsSummary>
): ListedConnectorDefinition[] {
  return rows.map(({ source_path, ...row }) => {
    const operationsSummary = summaries.get(row.key) ?? { ...EMPTY_SUMMARY };

    return {
      ...row,
      login_enabled: Boolean(row.login_enabled),
      source_uri: connectorSourcePathToUri(source_path),
      installed: true,
      installable: false,
      catalog_origin: 'org',
      operations_summary: operationsSummary,
      has_operations: operationsSummary.total > 0,
    };
  });
}

export async function buildConnectorDefinitionList(params: {
  installedRows: ScopedConnectorDefinitionRow[];
  summaries: Map<string, OperationsSummary>;
  includeInstallable?: boolean;
  catalogUris?: string;
}): Promise<ListedConnectorDefinition[]> {
  const installedDefinitions = mapInstalledConnectorDefinitions(
    params.installedRows,
    params.summaries
  );

  if (!params.includeInstallable) {
    return installedDefinitions;
  }

  const mergedByKey = new Map<string, ListedConnectorDefinition>();
  for (const definition of installedDefinitions) {
    mergedByKey.set(definition.key, definition);
  }

  const catalogDefinitions = await listCatalogConnectorDefinitions(params.catalogUris);
  for (const definition of catalogDefinitions) {
    if (mergedByKey.has(definition.key)) continue;
    const actionCount = definition.actions_schema
      ? Object.keys(definition.actions_schema).length
      : 0;
    const operationsSummary = {
      ...EMPTY_SUMMARY,
      total: actionCount,
      writes: actionCount,
      local_action: actionCount,
    };
    mergedByKey.set(definition.key, {
      ...definition,
      operations_summary: operationsSummary,
      has_operations: actionCount > 0,
    });
  }

  return [...mergedByKey.values()].sort((a, b) => {
    if (a.installed && !b.installed) return -1;
    if (!a.installed && b.installed) return 1;
    return String(a.name).localeCompare(String(b.name));
  });
}
