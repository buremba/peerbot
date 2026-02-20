import type React from "react";
import { motion } from "framer-motion";
import { NODES } from "../nodes";

interface AnimatedPacketProps {
  from: string;
  to: string;
  color: string;
  label?: string;
}

export const AnimatedPacket: React.FC<AnimatedPacketProps> = ({
  from,
  to,
  color,
  label,
}) => {
  const fromNode = NODES.find((n) => n.id === from);
  const toNode = NODES.find((n) => n.id === to);
  if (!fromNode || !toNode) return null;

  // If from and to are not directly connected, route through gateway
  const isDirectConnection = from === "gateway" || to === "gateway";

  // For indirect routes (e.g., mcp → sandbox), we go through gateway
  let waypoints: Array<{ x: number; y: number }>;

  if (isDirectConnection) {
    waypoints = [
      { x: fromNode.x, y: fromNode.y },
      { x: toNode.x, y: toNode.y },
    ];
  } else {
    const gateway = NODES.find((n) => n.id === "gateway")!;
    waypoints = [
      { x: fromNode.x, y: fromNode.y },
      { x: gateway.x, y: gateway.y },
      { x: toNode.x, y: toNode.y },
    ];
  }

  const numWaypoints = waypoints.length;
  const duration = 0.8 * (numWaypoints - 1);

  // Compute midpoint for label positioning
  const midIdx = Math.floor(numWaypoints / 2);
  const midX = waypoints[midIdx].x;
  const midY = waypoints[midIdx].y;

  return (
    <g>
      {/* Animated dot traveling the path */}
      <motion.circle
        r={6}
        fill={color}
        filter={`drop-shadow(0 0 6px ${color})`}
        initial={{ cx: waypoints[0].x, cy: waypoints[0].y, opacity: 0 }}
        animate={{
          cx: waypoints.map((w) => w.x),
          cy: waypoints.map((w) => w.y),
        }}
        transition={{ duration, ease: "easeInOut" }}
      />

      {/* Fade in/out overlay */}
      <motion.circle
        r={6}
        fill={color}
        initial={{ cx: waypoints[0].x, cy: waypoints[0].y, opacity: 0 }}
        animate={{
          cx: waypoints.map((w) => w.x),
          cy: waypoints.map((w) => w.y),
          opacity: [0, 1, 0],
        }}
        transition={{
          duration,
          ease: "easeInOut",
          opacity: { duration, times: [0, 0.15, 1] },
        }}
      />

      {/* Trail effect */}
      <motion.circle
        r={3}
        fill={color}
        initial={{ cx: waypoints[0].x, cy: waypoints[0].y, opacity: 0 }}
        animate={{
          cx: waypoints.map((w) => w.x),
          cy: waypoints.map((w) => w.y),
          opacity: [0, 0.4, 0],
        }}
        transition={{
          duration,
          ease: "easeInOut",
          delay: 0.08,
          opacity: { duration, times: [0, 0.2, 1] },
        }}
      />

      {/* Label at midpoint */}
      {label && (
        <motion.text
          textAnchor="middle"
          fill={color}
          fontSize={10}
          fontWeight={600}
          fontFamily="Inter, sans-serif"
          x={midX}
          y={midY - 18}
          initial={{ opacity: 0, y: midY - 10 }}
          animate={{ opacity: [0, 1, 1, 0], y: midY - 18 }}
          transition={{ duration, times: [0, 0.15, 0.7, 1] }}
        >
          {label}
        </motion.text>
      )}
    </g>
  );
};
