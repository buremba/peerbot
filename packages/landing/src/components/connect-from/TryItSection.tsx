import { useMemo, useState } from "preact/hooks";
import type { LandingUseCaseWorkspaceOption } from "../../use-case-showcases";
import { UseCaseTabs } from "../UseCaseTabs";

type TryItSectionProps = {
  clientLabel: string;
  mcpBaseUrl: string;
  owlettoBaseUrl: string;
  owlettoBaseHostLabel: string;
  workspaces: LandingUseCaseWorkspaceOption[];
  initialUseCaseId?: string;
};

export function TryItSection({
  clientLabel,
  mcpBaseUrl,
  owlettoBaseUrl,
  owlettoBaseHostLabel,
  workspaces,
  initialUseCaseId,
}: TryItSectionProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(
    initialUseCaseId
  );

  const selected = useMemo(
    () => workspaces.find((w) => w.id === selectedId),
    [workspaces, selectedId]
  );

  const mcpUrl = selected?.mcpUrl ?? mcpBaseUrl;
  const signInHref = selected?.owlettoUrl ?? owlettoBaseUrl;
  const signInLabel = selected?.hostLabel ?? owlettoBaseHostLabel;

  const tabs = useMemo(
    () => workspaces.map((w) => ({ id: w.id, label: w.label })),
    [workspaces]
  );

  const handleSelect = (id: string) => {
    setSelectedId((current) => (current === id ? undefined : id));
  };

  return (
    <div>
      <p>
        Lobu is open-source but we also have a managed cloud. If you'd like to
        try, sign in at{" "}
        <a href={signInHref} target="_blank" rel="noopener noreferrer">
          {signInLabel}
        </a>
        , then point {clientLabel} at <code>{mcpUrl}</code> as the MCP endpoint.{" "}
        {selected ? (
          <>
            This URL is scoped to the <strong>{selected.label}</strong>{" "}
            workspace.
          </>
        ) : (
          <>
            The same URL works for every workspace — pick one below to scope it
            to that example.
          </>
        )}
      </p>

      <div class="not-content my-6">
        <UseCaseTabs
          tabs={tabs}
          activeId={selectedId ?? ""}
          onSelect={handleSelect}
        />
      </div>
    </div>
  );
}
