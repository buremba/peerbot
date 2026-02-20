import type React from "react";
import { useEffect, useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { colors } from "../styles";
import type { FlowStep } from "../types";

interface SlackMessage {
  id: string;
  type: "user" | "bot" | "system" | "permission";
  text: string;
  streaming?: boolean;
}

interface SlackPanelProps {
  steps: FlowStep[];
  currentStepIndex: number;
}

export const SlackPanel: React.FC<SlackPanelProps> = ({
  steps,
  currentStepIndex,
}) => {
  const [messages, setMessages] = useState<SlackMessage[]>([]);
  const [streamedText, setStreamedText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prevStepRef = useRef(-1);

  useEffect(() => {
    // Reset on prompt change (step 0 reached again)
    if (currentStepIndex === 0 && prevStepRef.current !== 0) {
      setMessages([]);
      setStreamedText("");
      setIsStreaming(false);
    }
    prevStepRef.current = currentStepIndex;

    // Collect all slack events up to current step
    const slackMessages: SlackMessage[] = [];
    for (let i = 0; i <= currentStepIndex; i++) {
      const step = steps[i];
      if (step.slackEvent && step.slackEvent.type !== "typing") {
        slackMessages.push({
          id: step.id,
          type: step.slackEvent.type,
          text: step.slackEvent.text,
        });
      }
    }
    setMessages(slackMessages);

    // Handle streaming for typing events
    const currentStep = steps[currentStepIndex];
    if (currentStep?.slackEvent?.streaming) {
      setIsStreaming(true);
      const fullText = currentStep.slackEvent.text;
      let charIndex = 0;
      setStreamedText("");

      const interval = setInterval(() => {
        charIndex += 2;
        if (charIndex >= fullText.length) {
          setStreamedText(fullText);
          setIsStreaming(false);
          clearInterval(interval);
        } else {
          setStreamedText(fullText.slice(0, charIndex));
        }
      }, 40);

      return () => clearInterval(interval);
    } else {
      setIsStreaming(false);
      setStreamedText("");
    }
  }, [currentStepIndex, steps]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollRef is a stable ref and does not need to be a dependency
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamedText]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: colors.slackBg,
      }}
    >
      {/* Slack header */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: `1px solid ${colors.border}`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: colors.green,
          }}
        />
        <span style={{ fontWeight: 600, fontSize: 14 }}># general</span>
      </div>

      {/* Messages area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <AnimatePresence mode="popLayout">
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              {msg.type === "user" && <UserMessage text={msg.text} />}
              {msg.type === "bot" && <BotMessage text={msg.text} />}
              {msg.type === "system" && <SystemMessage text={msg.text} />}
              {msg.type === "permission" && (
                <PermissionMessage text={msg.text} />
              )}
            </motion.div>
          ))}

          {/* Streaming message */}
          {isStreaming && (
            <motion.div
              key="streaming"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <BotMessage text={streamedText} isStreaming />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Input bar */}
      <div
        style={{
          padding: "12px 16px",
          borderTop: `1px solid ${colors.border}`,
        }}
      >
        <div
          style={{
            background: colors.bgTertiary,
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 13,
            color: colors.textMuted,
            border: `1px solid ${colors.border}`,
          }}
        >
          Message #general
        </div>
      </div>
    </div>
  );
};

const UserMessage: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 6,
        background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      U
    </div>
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>You</span>
        <span style={{ fontSize: 11, color: colors.textMuted }}>now</span>
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: colors.text,
          marginTop: 2,
        }}
      >
        {text}
      </div>
    </div>
  </div>
);

const BotMessage: React.FC<{ text: string; isStreaming?: boolean }> = ({
  text,
  isStreaming,
}) => (
  <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 6,
        background: "linear-gradient(135deg, #10B981 0%, #059669 100%)",
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      L
    </div>
    <div style={{ flex: 1 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>Lobu</span>
        <span
          style={{
            fontSize: 10,
            color: colors.accent,
            background: colors.accentDim,
            padding: "1px 6px",
            borderRadius: 4,
          }}
        >
          APP
        </span>
        <span style={{ fontSize: 11, color: colors.textMuted }}>now</span>
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: colors.text,
          marginTop: 2,
          whiteSpace: "pre-wrap",
        }}
      >
        {renderMarkdownLight(text)}
        {isStreaming && (
          <motion.span
            animate={{ opacity: [1, 0] }}
            transition={{ duration: 0.5, repeat: Infinity }}
            style={{ color: colors.accent }}
          >
            |
          </motion.span>
        )}
      </div>
    </div>
  </div>
);

const SystemMessage: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      fontSize: 12,
      color: colors.green,
      textAlign: "center",
      padding: "4px 0",
      fontWeight: 500,
    }}
  >
    {text}
  </div>
);

const PermissionMessage: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      background: colors.yellowDim,
      border: `1px solid rgba(245, 158, 11, 0.3)`,
      borderRadius: 8,
      padding: "12px 14px",
    }}
  >
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: colors.yellow,
        marginBottom: 8,
      }}
    >
      Permission Required
    </div>
    <div style={{ fontSize: 13, color: colors.text, marginBottom: 10 }}>
      {text}
    </div>
    <div style={{ display: "flex", gap: 8 }}>
      <motion.button
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        style={{
          background: colors.green,
          color: "#fff",
          border: "none",
          borderRadius: 6,
          padding: "6px 14px",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Allow for 1 hour
      </motion.button>
      <button
        type="button"
        style={{
          background: "transparent",
          color: colors.textSecondary,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          padding: "6px 14px",
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        Deny
      </button>
    </div>
  </div>
);

function renderMarkdownLight(text: string): React.ReactNode {
  // Very simple bold markdown rendering
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: markdown parts are derived from static text and never reordered
        <strong key={i} style={{ fontWeight: 600 }}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    return part;
  });
}
