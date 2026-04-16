import { useState } from "preact/hooks";

type CopyableSnippetProps = {
  code: string;
  label?: string;
};

export function CopyableSnippet({
  code,
  label = "Copy",
}: CopyableSnippetProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  return (
    <div
      style={{
        borderRadius: "0.5rem",
        border: "1px solid var(--sl-color-hairline, rgba(255,255,255,0.1))",
        margin: "0.75rem 0",
        overflow: "hidden",
        backgroundColor: "var(--sl-color-bg-inline-code, rgba(0,0,0,0.2))",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
          padding: "0.5rem 0.75rem",
          borderBottom:
            "1px solid var(--sl-color-hairline, rgba(255,255,255,0.1))",
        }}
      >
        <span
          style={{
            fontSize: "10px",
            textTransform: "uppercase",
            letterSpacing: "0.18em",
            color: "var(--sl-color-gray-3, #888)",
          }}
        >
          {label}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            fontSize: "11px",
            fontWeight: 500,
            padding: "0.25rem 0.5rem",
            borderRadius: "0.375rem",
            cursor: "pointer",
            transition: "color 0.15s",
            color: copied
              ? "var(--sl-color-accent, #7aa2f7)"
              : "var(--sl-color-text, #fff)",
            backgroundColor: "transparent",
            border:
              "1px solid var(--sl-color-hairline, rgba(255,255,255,0.15))",
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "0.75rem",
          fontSize: "12px",
          lineHeight: "1.25rem",
          overflowX: "auto",
          backgroundColor: "transparent",
        }}
      >
        <code style={{ background: "transparent" }}>{code}</code>
      </pre>
    </div>
  );
}
