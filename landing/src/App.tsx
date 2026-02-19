import type React from "react";
import { useState, useEffect, useCallback, useRef } from "react";
import { Diagram } from "./components/Diagram";
import { SlackPanel } from "./components/SlackPanel";
import { StepIndicator } from "./components/StepIndicator";
import { PromptSwitcher } from "./components/PromptSwitcher";
import { buildSteps, PROMPT_OPTIONS } from "./steps";
import { colors, layout } from "./styles";

const globalStyles = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body, #root { height: 100%; }
  body { background: ${colors.bg}; color: ${colors.text}; }
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: ${colors.border}; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: ${colors.borderLight}; }
`;

const App: React.FC = () => {
  const [selectedPrompt, setSelectedPrompt] = useState(PROMPT_OPTIONS[0]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const steps = buildSteps(selectedPrompt);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Auto-play timer
  useEffect(() => {
    clearTimer();

    if (!isPlaying) return;

    const currentStep = steps[currentStepIndex];
    timerRef.current = setTimeout(() => {
      setCurrentStepIndex((prev) => {
        if (prev >= steps.length - 1) {
          // Loop back to start
          return 0;
        }
        return prev + 1;
      });
    }, currentStep.duration);

    return clearTimer;
  }, [isPlaying, currentStepIndex, steps, clearTimer]);

  const handleStepClick = useCallback(
    (index: number) => {
      clearTimer();
      setCurrentStepIndex(index);
      setIsPlaying(false);
    },
    [clearTimer]
  );

  const handleTogglePlay = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  const handleReset = useCallback(() => {
    clearTimer();
    setCurrentStepIndex(0);
    setIsPlaying(true);
  }, [clearTimer]);

  const handlePromptChange = useCallback(
    (prompt: typeof selectedPrompt) => {
      clearTimer();
      setSelectedPrompt(prompt);
      setCurrentStepIndex(0);
      setIsPlaying(true);
    },
    [clearTimer]
  );

  const currentStep = steps[currentStepIndex];

  return (
    <>
      <style>{globalStyles}</style>
      <div style={layout.container}>
        {/* Header */}
        <div style={layout.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: "linear-gradient(135deg, #10B981 0%, #059669 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 700,
                fontSize: 16,
              }}
            >
              L
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 16 }}>
                How Lobu Works
              </div>
              <div style={{ fontSize: 12, color: colors.textMuted }}>
                Message processing flow
              </div>
            </div>
          </div>

          <PromptSwitcher
            options={PROMPT_OPTIONS}
            selected={selectedPrompt}
            onSelect={handlePromptChange}
          />
        </div>

        {/* Main content */}
        <div style={layout.main}>
          {/* Diagram area */}
          <div style={layout.diagramPanel}>
            {/* Step description overlay */}
            <div
              style={{
                position: "absolute",
                top: 20,
                left: 24,
                right: 24,
                zIndex: 10,
                pointerEvents: "none",
              }}
            >
              <div
                style={{
                  background: `${colors.bgSecondary}dd`,
                  backdropFilter: "blur(8px)",
                  borderRadius: 10,
                  padding: "12px 18px",
                  border: `1px solid ${colors.border}`,
                  maxWidth: 500,
                }}
              >
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    marginBottom: 4,
                    color: colors.accent,
                  }}
                >
                  Step {currentStepIndex + 1}: {currentStep.title}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: colors.textSecondary,
                    lineHeight: 1.4,
                  }}
                >
                  {currentStep.description}
                </div>
              </div>
            </div>

            {/* SVG Diagram */}
            <div style={{ flex: 1, padding: "0 16px" }}>
              <Diagram currentStep={currentStep} prompt={selectedPrompt} />
            </div>
          </div>

          {/* Slack chat panel */}
          <div style={layout.slackPanel}>
            <SlackPanel steps={steps} currentStepIndex={currentStepIndex} />
          </div>
        </div>

        {/* Bottom control bar */}
        <div style={layout.bottomBar}>
          <StepIndicator
            steps={steps}
            currentIndex={currentStepIndex}
            onStepClick={handleStepClick}
            isPlaying={isPlaying}
            onTogglePlay={handleTogglePlay}
            onReset={handleReset}
          />
        </div>
      </div>
    </>
  );
};

export default App;
