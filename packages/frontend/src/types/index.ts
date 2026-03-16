export type AgentStatus = 'idle' | 'working' | 'offline';

export interface Agent {
  id: string;
  name: string;
  role?: string;
  description?: string;
  status: AgentStatus;
  token_symbol?: string;
  token_address?: string;
  wallet_address?: string;
  fee_balance?: number;
  llm_calls?: number;
  created_at?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

export interface ResearchReport {
  id: string;
  agent_id?: string;
  agent_name?: string;
  topic: string;
  title: string;
  summary: string;
  key_findings: string[];
  tags: string[];
  confidence: Confidence;
  analysis?: string;
  models_used: string[];
  duration_ms: number;
  created_at: string;
}

export interface PipelineStep {
  step: number;
  model: string;
  role: string;
  output: string;
}

export interface ResearchResult {
  success: boolean;
  report: ResearchReport;
  analysis: string;
  pipeline: PipelineStep[];
  db_id?: string;
  meta: {
    topic: string;
    duration_ms: number;
    models_used: string[];
    steps: number;
    agent_id: number | null;
  };
}

export interface AgentEconomy {
  agent_id: string;
  agent_name: string;
  token_symbol?: string;
  fee_revenue: number;
  llm_spend: number;
  net_balance: number;
  self_sustaining: boolean;
  report_count: number;
  llm_calls: number;
}

export interface EconomyData {
  agents: AgentEconomy[];
  totals: {
    total_fee_revenue: number;
    total_llm_spend: number;
    total_net: number;
  };
}

export type ModelHint = 'fast' | 'medium' | 'deep' | 'json';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
}

export interface ModelUsageEntry {
  model: string;
  hint: ModelHint;
  calls: number;
  reason: string;
}
