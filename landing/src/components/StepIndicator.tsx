import type React from "react";
import { motion } from "framer-motion";
import type { FlowStep } from "../types";
import { colors } from "../styles";

interface StepIndicatorProps {
  steps: FlowStep[];
  currentIndex: number;
  onStepClick: (index: number) => void;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onReset: () => void;
}

export const StepIndicator: React.FC<StepIndicatorProps> = ({
  steps,
  currentIndex,
  onStepClick,
  isPlaying,
  onTogglePlay,
  onReset,
}) => {
  const currentStep = steps[currentIndex];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        width: "100%",
      }}
    >
      {/* Play/Pause button */}
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        onClick={onTogglePlay}
        style={{
          width: 36,
          height: 36,
          borderRadius: "50%",
          background: colors.accent,
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {isPlaying ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="white"
            aria-hidden="true"
          >
            <rect x="2" y="1" width="3.5" height="12" rx="1" />
            <rect x="8.5" y="1" width="3.5" height="12" rx="1" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="white"
            aria-hidden="true"
          >
            <path d="M3 1.5L12 7L3 12.5V1.5Z" />
          </svg>
        )}
      </motion.button>

      {/* Reset button */}
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        onClick={onReset}
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          background: "transparent",
          border: `1px solid ${colors.border}`,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: colors.textSecondary,
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M7 1a6 6 0 0 0-6 6h2a4 4 0 0 1 7.17-2.42L8.5 6H13V1.5l-1.76 1.76A5.98 5.98 0 0 0 7 1zM1 7v4.5l1.76-1.76A5.98 5.98 0 0 0 13 7h-2a4 4 0 0 1-7.17 2.42L5.5 8H1z" />
        </svg>
      </motion.button>

      {/* Step dots */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          flex: 1,
          minWidth: 0,
        }}
      >
        {steps.map((_, index) => (
          <motion.button
            // biome-ignore lint/suspicious/noArrayIndexKey: steps array is static and never reordered
            key={index}
            onClick={() => onStepClick(index)}
            style={{
              width: index === currentIndex ? 16 : 6,
              height: 6,
              borderRadius: 3,
              background:
                index < currentIndex
                  ? colors.green
                  : index === currentIndex
                    ? colors.accent
                    : colors.border,
              border: "none",
              cursor: "pointer",
              padding: 0,
              transition: "all 0.3s",
            }}
            whileHover={{ scale: 1.4 }}
            title={steps[index].title}
          />
        ))}
      </div>

      {/* Current step info */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          minWidth: 200,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: colors.text,
            whiteSpace: "nowrap",
          }}
        >
          {currentStep.title}
        </div>
        <div
          style={{
            fontSize: 11,
            color: colors.textMuted,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            maxWidth: 280,
          }}
        >
          {currentIndex + 1}/{steps.length} — {currentStep.description}
        </div>
      </div>
    </div>
  );
};
