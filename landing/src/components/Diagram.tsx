import type React from "react";
import { AnimatePresence } from "framer-motion";
import { NODES, CONNECTIONS } from "../nodes";
import type { FlowStep, PromptOption } from "../types";
import { DiagramNode } from "./DiagramNode";
import { ConnectionLine } from "./ConnectionLine";
import { AnimatedPacket } from "./AnimatedPacket";

interface DiagramProps {
  currentStep: FlowStep;
  prompt: PromptOption;
}

export const Diagram: React.FC<DiagramProps> = ({ currentStep, prompt }) => {
  const activeNodes = new Set(currentStep.activeNodes);

  // Determine which connections are active
  const activeConnections = new Set<string>();
  if (currentStep.packet) {
    const { from, to } = currentStep.packet;
    // Mark direct connection or connections through gateway
    for (const conn of CONNECTIONS) {
      if (
        (conn.from === from && conn.to === to) ||
        (conn.from === to && conn.to === from) ||
        // Indirect: from → gateway → to
        (conn.from === from && conn.to === "gateway") ||
        (conn.from === "gateway" && conn.to === to) ||
        (conn.to === from && conn.from === "gateway") ||
        (conn.to === "gateway" && conn.from === to)
      ) {
        activeConnections.add(`${conn.from}-${conn.to}`);
      }
    }
  }

  // Update MCP label dynamically based on selected prompt
  const nodesWithDynamicLabels = NODES.map((n) => {
    if (n.id === "mcp") {
      return { ...n, label: prompt.mcpTarget, sublabel: prompt.mcpDomain };
    }
    return n;
  });

  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 800 540"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block" }}
      aria-hidden="true"
    >
      {/* Defs for gradients */}
      <defs>
        {/* biome-ignore lint/correctness/useUniqueElementIds: SVG gradient ID is scoped within this component's SVG element */}
        <linearGradient id="diagram-lineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="rgba(74, 158, 255, 0.1)" />
          <stop offset="50%" stopColor="rgba(74, 158, 255, 0.3)" />
          <stop offset="100%" stopColor="rgba(74, 158, 255, 0.1)" />
        </linearGradient>
      </defs>

      {/* Connection lines */}
      {CONNECTIONS.map((conn) => (
        <ConnectionLine
          key={`${conn.from}-${conn.to}`}
          from={conn.from}
          to={conn.to}
          isActive={activeConnections.has(`${conn.from}-${conn.to}`)}
        />
      ))}

      {/* Nodes */}
      {nodesWithDynamicLabels.map((node) => (
        <DiagramNode
          key={node.id}
          node={node}
          isActive={activeNodes.has(node.id)}
          callout={
            currentStep.callout?.node === node.id
              ? {
                  text: currentStep.callout.text,
                  type: currentStep.callout.type,
                }
              : undefined
          }
        />
      ))}

      {/* Animated packet */}
      <AnimatePresence mode="wait">
        {currentStep.packet && (
          <AnimatedPacket
            key={currentStep.id}
            from={currentStep.packet.from}
            to={currentStep.packet.to}
            color={currentStep.packet.color || "#4A9EFF"}
            label={currentStep.packet.label}
          />
        )}
      </AnimatePresence>
    </svg>
  );
};
