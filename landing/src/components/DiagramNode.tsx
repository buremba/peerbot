import type React from "react";
import { motion } from "framer-motion";
import type { NodePosition } from "../types";
import { NodeIcon } from "./NodeIcon";
import { colors } from "../styles";

interface DiagramNodeProps {
  node: NodePosition;
  isActive: boolean;
  callout?: {
    text: string;
    type: "info" | "security" | "warning";
  };
}

const NODE_WIDTH = 140;
const NODE_HEIGHT = 80;

const calloutColors = {
  info: { bg: colors.accentDim, border: colors.accent, text: colors.accent },
  security: {
    bg: colors.greenDim,
    border: colors.green,
    text: colors.green,
  },
  warning: {
    bg: colors.yellowDim,
    border: colors.yellow,
    text: colors.yellow,
  },
};

export const DiagramNode: React.FC<DiagramNodeProps> = ({
  node,
  isActive,
  callout,
}) => {
  const nodeX = node.x - NODE_WIDTH / 2;
  const nodeY = node.y - NODE_HEIGHT / 2;

  return (
    <g>
      {/* Node box */}
      <motion.g
        animate={{
          filter: isActive
            ? "drop-shadow(0 0 12px rgba(74, 158, 255, 0.4))"
            : "drop-shadow(0 0 0px rgba(74, 158, 255, 0))",
        }}
        transition={{ duration: 0.4 }}
      >
        <motion.rect
          x={nodeX}
          y={nodeY}
          width={NODE_WIDTH}
          height={NODE_HEIGHT}
          rx={12}
          fill={isActive ? colors.bgTertiary : colors.bgSecondary}
          stroke={isActive ? colors.accent : colors.border}
          strokeWidth={isActive ? 2 : 1}
          animate={{
            fill: isActive ? colors.bgTertiary : colors.bgSecondary,
            stroke: isActive ? colors.accent : colors.border,
            strokeWidth: isActive ? 2 : 1,
          }}
          transition={{ duration: 0.3 }}
        />

        {/* Icon */}
        <foreignObject x={node.x - 14} y={nodeY + 10} width={28} height={28}>
          <div
            style={{
              color: isActive ? colors.accent : colors.textSecondary,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "color 0.3s",
            }}
          >
            <NodeIcon type={node.icon} size={24} />
          </div>
        </foreignObject>

        {/* Label */}
        <text
          x={node.x}
          y={nodeY + NODE_HEIGHT - 20}
          textAnchor="middle"
          fill={isActive ? colors.text : colors.textSecondary}
          fontSize={12}
          fontWeight={600}
          fontFamily="Inter, sans-serif"
          style={{ transition: "fill 0.3s" }}
        >
          {node.label}
        </text>

        {/* Sublabel */}
        {node.sublabel && (
          <text
            x={node.x}
            y={nodeY + NODE_HEIGHT - 6}
            textAnchor="middle"
            fill={colors.textMuted}
            fontSize={9}
            fontFamily="Inter, sans-serif"
          >
            {node.sublabel}
          </text>
        )}
      </motion.g>

      {/* Callout bubble */}
      {callout && (
        <motion.g
          initial={{ opacity: 0, y: 5 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -5 }}
          transition={{ duration: 0.3 }}
        >
          <foreignObject
            x={node.x - 100}
            y={nodeY - 48}
            width={200}
            height={40}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              style={{
                background: calloutColors[callout.type].bg,
                border: `1px solid ${calloutColors[callout.type].border}`,
                borderRadius: 8,
                padding: "6px 12px",
                fontSize: 11,
                fontWeight: 500,
                color: calloutColors[callout.type].text,
                textAlign: "center",
                fontFamily: "Inter, sans-serif",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {callout.type === "security" && "🔒 "}
              {callout.type === "warning" && "⚠️ "}
              {callout.text}
            </motion.div>
          </foreignObject>
        </motion.g>
      )}
    </g>
  );
};
