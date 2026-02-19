export interface FlowStep {
  id: string;
  title: string;
  description: string;
  /** Which nodes are active/highlighted during this step */
  activeNodes: string[];
  /** Animated packet from → to */
  packet?: {
    from: string;
    to: string;
    label?: string;
    color?: string;
  };
  /** What appears in the Slack chat panel */
  slackEvent?: {
    type: "user" | "bot" | "system" | "typing" | "permission";
    text: string;
    streaming?: boolean;
  };
  /** Callout/annotation to show */
  callout?: {
    node: string;
    text: string;
    type: "info" | "security" | "warning";
  };
  /** Duration in ms for auto-play */
  duration: number;
}

export interface NodePosition {
  id: string;
  label: string;
  x: number;
  y: number;
  icon: string;
  sublabel?: string;
}

export interface PromptOption {
  label: string;
  prompt: string;
  mcpTarget: string;
  mcpDomain: string;
}
