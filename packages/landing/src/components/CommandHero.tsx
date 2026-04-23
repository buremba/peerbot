import type { ComponentChildren } from "preact";
import {
  CopyPromptButton,
  type SupportedPromptClientId,
} from "./CopyPromptButton";

type CommandHeroProps = {
  title: ComponentChildren;
  description: string;
  prompt?: string;
  promptTriggerLabel?: string;
  supportedClients?: SupportedPromptClientId[];
  supportedClientHrefForId?: (
    clientId: SupportedPromptClientId
  ) => string | undefined;
  actions?: ComponentChildren;
};

export function CommandHero({
  title,
  description,
  prompt,
  promptTriggerLabel,
  supportedClients,
  supportedClientHrefForId,
  actions,
}: CommandHeroProps) {
  return (
    <div class="text-center mb-12">
      <h1
        class="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5"
        style={{ color: "var(--color-page-text)" }}
      >
        {title}
      </h1>
      <p
        class="text-lg sm:text-xl leading-8 max-w-[40rem] mx-auto m-0"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {description}
      </p>

      <div class="mt-10 flex flex-wrap items-center justify-center gap-3 mb-4">
        {actions}
        <CopyPromptButton
          prompt={prompt}
          label="Copy prompt to your agent"
          triggerLabel={promptTriggerLabel}
          supportedClients={supportedClients}
          supportedClientHrefForId={supportedClientHrefForId}
        />
      </div>
    </div>
  );
}
