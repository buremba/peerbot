import type { ComponentChildren } from "preact";

/**
 * Shared inline-style scaffold for the registry tables (SkillsRegistryTable,
 * ProvidersRegistryTable). Keeps the cell/header style objects and the
 * horizontally-scrollable `<table>` shell in one place so the two tables can't
 * drift. PlatformConfigTable styles its tables via Tailwind/global CSS and is
 * intentionally not built on this.
 */

export const cellStyle = {
  padding: "8px 12px",
  borderBottom: "1px solid var(--color-page-border)",
  fontSize: "13px",
  color: "var(--color-page-text-muted)",
};

export const headerCellStyle = {
  ...cellStyle,
  fontWeight: 600,
  color: "var(--color-page-text)",
  backgroundColor: "var(--color-page-surface-dim)",
};

type DataTableProps = {
  headers: string[];
  children: ComponentChildren;
};

export function DataTable({ headers, children }: DataTableProps) {
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
            {headers.map((header) => (
              <th key={header} style={headerCellStyle}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
