import type React from "react";
import { motion } from "framer-motion";
import type { PromptOption } from "../types";
import { colors } from "../styles";

interface PromptSwitcherProps {
  options: PromptOption[];
  selected: PromptOption;
  onSelect: (option: PromptOption) => void;
}

export const PromptSwitcher: React.FC<PromptSwitcherProps> = ({
  options,
  selected,
  onSelect,
}) => {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {options.map((option) => {
        const isSelected = option.label === selected.label;
        return (
          <motion.button
            key={option.label}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => onSelect(option)}
            style={{
              padding: "6px 14px",
              borderRadius: 20,
              border: `1px solid ${isSelected ? colors.accent : colors.border}`,
              background: isSelected ? colors.accentDim : "transparent",
              color: isSelected ? colors.accent : colors.textSecondary,
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              whiteSpace: "nowrap",
              fontFamily: "Inter, sans-serif",
              transition: "all 0.2s",
            }}
          >
            {option.label}
          </motion.button>
        );
      })}
    </div>
  );
};
