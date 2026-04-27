import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";

const CAL_URL =
  "https://cal.com/buremba/lobu-discovery?duration=15&overlayCalendar=true&embed=true&layout=month_view";

export function ScheduleCallIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

export function ScheduleCallButton({
  children,
  class: className,
  style,
}: {
  children: ComponentChildren;
  class?: string;
  style?: Record<string, string>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Mount the cal.com iframe only after the user opens the dialog. Loading it
  // up-front (even hidden via <dialog> default display:none) blocks the page
  // `load` event in headless browsers, which makes agent-readiness scanners
  // time out before they can detect WebMCP. `loading="lazy"` is added too as
  // belt-and-suspenders.
  const [hasOpened, setHasOpened] = useState(false);

  const open = () => {
    setHasOpened(true);
    dialogRef.current?.showModal();
  };

  return (
    <>
      <button
        type="button"
        class={className}
        style={{ cursor: "pointer", ...style }}
        onClick={open}
      >
        {children}
      </button>
      <dialog
        ref={dialogRef}
        class="schedule-dialog"
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current.close();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") dialogRef.current?.close();
        }}
      >
        <div class="schedule-dialog-content">
          <button
            type="button"
            class="schedule-dialog-close"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close"
          >
            &times;
          </button>
          {hasOpened && (
            <iframe
              src={CAL_URL}
              title="Schedule a call"
              class="schedule-dialog-iframe"
              loading="lazy"
            />
          )}
        </div>
      </dialog>
    </>
  );
}
