export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agent?: 'context-builder' | 'customer-data' | 'insights' | null;
  is_edited: boolean;
  original_content?: string;
  edited_by?: string | null;
  timestamp: string;
}

export interface Collaborator {
  id: string;
  name: string;
  email: string;
  role: string;
  added_at: string;
}

export interface DraftDocument {
  content: string;
  updated_at: string;
  updated_by?: string | null;
}

export interface RubricCriterion {
  name: string;
  score: number;
  max_score: number;
  rationale: string;
}

export interface DraftEvaluation {
  overall_score: number;
  criteria: RubricCriterion[];
  summary: string;
  strengths: string[];
  improvements: string[];
  evaluated_at: string;
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
  collaborators: Collaborator[];
  assignee?: string | null;
  draft: DraftDocument;
  evaluation?: DraftEvaluation | null;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  message_count: number;
  token_usage: TokenUsage;
  collaborator_count: number;
  assignee?: string | null;
  has_draft: boolean;
  created_at: string;
  updated_at: string;
}

export interface StreamEvent {
  type: 'agent_started' | 'token' | 'agent_completed' | 'error' | 'done' | 'context_graph' | 'watermelon_data' | 'scorecard_data';
  agent?: string;
  content?: string;
  message_id?: string;
  usage?: TokenUsage;
  cumulative_usage?: TokenUsage;
  error?: string;
  data?: any;
}

export interface StreamEvent {
  type: 'agent_started' | 'token' | 'agent_completed' | 'error' | 'done' | 'context_graph' | 'watermelon_data' | 'scorecard_data';
  agent?: string;
  content?: string;
  message_id?: string;
  usage?: TokenUsage;
  cumulative_usage?: TokenUsage;
  error?: string;
  data?: any;
}
