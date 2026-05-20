import providersConfig from "@providers-config";

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

const cellStyle = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--color-page-border)",
  fontSize: "13px",
  color: "var(--color-page-text-muted)",
};

const headerCellStyle = {
  ...cellStyle,
  fontWeight: 600,
  color: "var(--color-page-text)",
  backgroundColor: "var(--color-page-surface-dim)",
};

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
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          border: "1px solid var(--color-page-border)",
        }}
      >
        <thead>
          <tr>
            <th style={headerCellStyle}>Provider</th>
            <th style={headerCellStyle}>ID</th>
            <th style={headerCellStyle}>Default Model</th>
            <th style={headerCellStyle}>SDK Compat</th>
            <th style={headerCellStyle}>Base URL</th>
            <th style={headerCellStyle}>Models Endpoint</th>
          </tr>
        </thead>
        <tbody>
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
                <code style={{ fontSize: "12px" }}>
                  {provider.defaultModel}
                </code>
              </td>
              <td style={cellStyle}>
                <Badge text={provider.sdkCompat} />
              </td>
              <td style={cellStyle}>
                <code style={{ fontSize: "12px" }}>
                  {provider.upstreamBaseUrl}
                </code>
              </td>
              <td style={cellStyle}>
                <code style={{ fontSize: "12px" }}>
                  {provider.modelsEndpoint}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
