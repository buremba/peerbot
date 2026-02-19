import type React from "react";
import { colors } from "../styles";
import { NODES } from "../nodes";

interface ConnectionLineProps {
  from: string;
  to: string;
  isActive: boolean;
}

export const ConnectionLine: React.FC<ConnectionLineProps> = ({
  from,
  to,
  isActive,
}) => {
  const fromNode = NODES.find((n) => n.id === from);
  const toNode = NODES.find((n) => n.id === to);
  if (!fromNode || !toNode) return null;

  return (
    <line
      x1={fromNode.x}
      y1={fromNode.y}
      x2={toNode.x}
      y2={toNode.y}
      stroke={isActive ? colors.borderLight : colors.border}
      strokeWidth={isActive ? 2 : 1}
      strokeDasharray={isActive ? "none" : "6 4"}
      style={{ transition: "all 0.4s" }}
    />
  );
};
