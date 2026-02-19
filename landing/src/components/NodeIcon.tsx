import type React from "react";

interface NodeIconProps {
  type: string;
  size?: number;
}

export const NodeIcon: React.FC<NodeIconProps> = ({ type, size = 28 }) => {
  const s = size;
  const color = "currentColor";

  switch (type) {
    case "slack":
      return (
        <svg
          width={s}
          height={s}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z"
            fill="#E01E5A"
          />
          <path
            d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z"
            fill="#36C5F0"
          />
          <path
            d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312z"
            fill="#2EB67D"
          />
          <path
            d="M15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z"
            fill="#ECB22E"
          />
        </svg>
      );

    case "gateway":
      return (
        <svg
          width={s}
          height={s}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="2"
            y="3"
            width="20"
            height="18"
            rx="3"
            stroke={color}
            strokeWidth="1.5"
          />
          <circle cx="7" cy="8" r="1.5" fill="#10B981" />
          <circle cx="7" cy="12" r="1.5" fill="#F59E0B" />
          <circle cx="7" cy="16" r="1.5" fill="#4A9EFF" />
          <line
            x1="11"
            y1="8"
            x2="19"
            y2="8"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="11"
            y1="12"
            x2="17"
            y2="12"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <line
            x1="11"
            y1="16"
            x2="15"
            y2="16"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );

    case "sandbox":
      return (
        <svg
          width={s}
          height={s}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <rect
            x="3"
            y="3"
            width="18"
            height="18"
            rx="2"
            stroke={color}
            strokeWidth="1.5"
            strokeDasharray="3 2"
          />
          <rect
            x="7"
            y="7"
            width="10"
            height="10"
            rx="1.5"
            stroke={color}
            strokeWidth="1.5"
          />
          <path
            d="M12 10v4m-2-2h4"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );

    case "mcp":
      return (
        <svg
          width={s}
          height={s}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.5" />
          <path
            d="M12 3c-3 3-3 6 0 9s3 6 0 9"
            stroke={color}
            strokeWidth="1.5"
          />
          <path
            d="M3 12h18"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M4.5 7.5h15M4.5 16.5h15"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );

    case "llm":
      return (
        <svg
          width={s}
          height={s}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M12 3L20 7.5V16.5L12 21L4 16.5V7.5L12 3Z"
            stroke={color}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M12 12L20 7.5M12 12L4 7.5M12 12V21"
            stroke={color}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      );

    default:
      return (
        <svg
          width={s}
          height={s}
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" stroke={color} strokeWidth="1.5" />
        </svg>
      );
  }
};
