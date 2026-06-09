export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agent?: 'context-builder' | 'insights' | null;
  is_edited: boolean;
  original_content?: string;
  timestamp: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface SessionTokenUsage {
  context_builder: TokenUsage;
  insights: TokenUsage;
  cumulative: TokenUsage;
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  token_usage: SessionTokenUsage;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  message_count: number;
  token_usage: TokenUsage;
  created_at: string;
  updated_at: string;
}

export interface StreamEvent {
  type: 'agent_started' | 'token' | 'agent_completed' | 'error' | 'done' | 'context_graph';
  agent?: string;
  content?: string;
  message_id?: string;
  usage?: TokenUsage;
  cumulative_usage?: TokenUsage;
  error?: string;
  data?: any;
}
