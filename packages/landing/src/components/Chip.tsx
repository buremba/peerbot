import { darkBase, textColor } from "./memory/styles";

const primaryAccent = "var(--color-tg-accent)";
const primaryAccentSoft = "rgba(var(--color-tg-accent-rgb), 0.08)";

interface ChipProps {
  label: string;
  active?: boolean;
  onClick?: () => void;
  color?: string;
}

export function Chip({
  label,
  active = false,
  onClick,
  color = primaryAccent,
}: ChipProps) {
  const isPrimaryAccent = color === primaryAccent;
  const style = {
    color: active ? darkBase : textColor,
    backgroundColor: active
      ? color
      : isPrimaryAccent
        ? primaryAccentSoft
        : `${color}14`,
    borderColor: active
      ? isPrimaryAccent
        ? "rgba(var(--color-tg-accent-rgb), 0.72)"
        : `${color}b8`
      : isPrimaryAccent
        ? "rgba(var(--color-tg-accent-rgb), 0.28)"
        : `${color}47`,
    boxShadow: active
      ? isPrimaryAccent
        ? "0 8px 24px rgba(var(--color-tg-accent-rgb), 0.16)"
        : `0 8px 24px ${color}29`
      : "none",
  };

  if (!onClick) {
    return (
      <span class="px-3 py-1 rounded-full text-xs border" style={style}>
        {label}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      class="px-3 py-1 rounded-full text-xs border transition-all hover:-translate-y-0.5 cursor-pointer"
      style={style}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}
