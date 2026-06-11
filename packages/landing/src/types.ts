export interface ChatMessage {
  role: "user" | "bot";
  text: string;
  buttons?: InlineButton[];
}

export interface InlineButton {
  label: string;
  action?: "settings" | "link";
  url?: string;
}

export interface UseCase {
  id: string;
  tabLabel: string;
  title: string;
  description: string;
  settingsLabel: string;
  chatLabel: string;
  messages: ChatMessage[];
  botName: string;
  botInitial: string;
  botColor: string;
}
