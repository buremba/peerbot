import providersConfig from "@providers-config";
import { cellStyle, DataTable } from "./DataTable";

interface ProviderConfig {
  displayName: string;
  defaultModel?: string;
  sdkCompat?: string;
  upstreamBaseUrl?: string;
  modelsEndpoint?: string;
}

interface ProviderEntry {
  id: string;
  providers?: ProviderConfig[];
}

const providers = (providersConfig as { providers: ProviderEntry[] }).providers;
const providerRows = providers.flatMap((providerEntry) =>
  (providerEntry.providers ?? []).map((provider) => ({
    id: providerEntry.id,
    displayName: provider.displayName,
    defaultModel: provider.defaultModel ?? "N/A",
    sdkCompat: provider.sdkCompat ?? "N/A",
    upstreamBaseUrl: provider.upstreamBaseUrl ?? "N/A",
    modelsEndpoint: provider.modelsEndpoint ?? "N/A",
  }))
);

function Badge({ text }: { text: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: "10px",
        fontFamily: "monospace",
        padding: "1px 6px",
        borderRadius: "4px",
        backgroundColor: "var(--color-page-surface-dim)",
        border: "1px solid var(--color-page-border)",
        color: "var(--color-page-text-muted)",
      }}
    >
      {text}
    </span>
  );
}

export function ProvidersRegistryTable() {
  return (
    <DataTable
      headers={[
        "Provider",
        "ID",
        "Default Model",
        "SDK Compat",
        "Base URL",
        "Models Endpoint",
      ]}
    >
      {providerRows.map((provider) => (
        <tr key={`${provider.id}:${provider.displayName}`}>
          <td
            style={{
              ...cellStyle,
              fontWeight: 500,
              color: "var(--color-page-text)",
            }}
          >
            {provider.displayName}
          </td>
          <td style={cellStyle}>
            <Badge text={provider.id} />
          </td>
          <td style={cellStyle}>
            <code style={{ fontSize: "12px" }}>{provider.defaultModel}</code>
          </td>
          <td style={cellStyle}>
            <Badge text={provider.sdkCompat} />
          </td>
          <td style={cellStyle}>
            <code style={{ fontSize: "12px" }}>{provider.upstreamBaseUrl}</code>
          </td>
          <td style={cellStyle}>
            <code style={{ fontSize: "12px" }}>{provider.modelsEndpoint}</code>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}
