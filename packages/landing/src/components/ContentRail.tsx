import type { ComponentChildren } from "preact";

type ContentRailProps = {
  children: ComponentChildren;
  className?: string;
  variant?: "page" | "inset" | "compact";
};

const railClasses = {
  page: "w-full max-w-[72rem] mx-auto",
  inset: "w-full max-w-[68rem] mx-auto px-4 sm:px-6 box-border",
  compact: "max-w-[60rem] mx-auto",
};

export function ContentRail({
  children,
  className = "",
  variant = "inset",
}: ContentRailProps) {
  return (
    <div class={`${railClasses[variant]} ${className}`.trim()}>{children}</div>
  );
}
