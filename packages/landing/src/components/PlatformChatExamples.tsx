/**
 * Renders a full chat-grid showcase for a platform docs page.
 * A use-case chip row at the top lets the visitor re-skin the three chat
 * windows with use-case-appropriate transcripts (engineering, support, legal, …).
 * The platform-specific theme (colors, chrome) stays fixed.
 */

import { useMemo, useState } from "preact/hooks";
import { PLATFORM_SCENARIOS } from "../chat-scenarios";
import type { UseCase } from "../types";
import { landingUseCaseShowcases } from "../use-case-showcases";
import {
  type ChatTheme,
  DISCORD_THEME,
  GCHAT_THEME,
  SampleChat,
  SLACK_THEME,
  TEAMS_THEME,
  TELEGRAM_THEME,
  WHATSAPP_THEME,
} from "./SampleChat";
import { UseCaseTabs } from "./UseCaseTabs";

const THEMES: Record<string, ChatTheme> = {
  telegram: TELEGRAM_THEME,
  slack: SLACK_THEME,
  discord: DISCORD_THEME,
  whatsapp: WHATSAPP_THEME,
  teams: TEAMS_THEME,
  gchat: GCHAT_THEME,
};

const GENERAL_TAB_ID = "general";

interface Props {
  platform: keyof typeof THEMES | string;
}

export function PlatformChatExamples({ platform }: Props) {
  const theme = THEMES[platform] ?? TELEGRAM_THEME;

  const tabs = useMemo(
    () => [
      { id: GENERAL_TAB_ID, label: "General" },
      ...landingUseCaseShowcases
        .filter((showcase) => showcase.chatScenarios !== undefined)
        .map((showcase) => ({ id: showcase.id, label: showcase.label })),
    ],
    []
  );

  const [activeId, setActiveId] = useState<string>(GENERAL_TAB_ID);

  const scenarios: UseCase[] = useMemo(() => {
    if (activeId === GENERAL_TAB_ID) return PLATFORM_SCENARIOS;
    const showcase = landingUseCaseShowcases.find((s) => s.id === activeId);
    const scenarioSet = showcase?.chatScenarios;
    if (!scenarioSet) return PLATFORM_SCENARIOS;
    return [scenarioSet.permission, scenarioSet.skill, scenarioSet.settings];
  }, [activeId]);

  return (
    <div class="not-content my-8 flex flex-col gap-10">
      <UseCaseTabs tabs={tabs} activeId={activeId} onSelect={setActiveId} />
      <div class="chat-grid-fullwidth grid gap-6 md:grid-cols-3">
        {scenarios.map((scenario) => (
          <SampleChat key={scenario.id} useCase={scenario} theme={theme} />
        ))}
      </div>
    </div>
  );
}
