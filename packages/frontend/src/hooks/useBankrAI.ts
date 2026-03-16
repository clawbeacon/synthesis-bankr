/**
 * @fileoverview Bankr LLM integration hook — Beacon edition.
 *
 * Upgrades:
 * - Multi-model routing: auto-selects gemini-flash / gemini-2-flash / claude-sonnet
 * - Research pipeline: 3-step autonomous research (screen → analyze → format)
 * - Model usage tracking: accumulates per model for Economy panel
 */

import { useState, useCallback } from 'react';
import type { Agent } from '../types';

const API_BASE: string =
  window.__CLAW_CONFIG__?.API_URL ??
  (import.meta.env.VITE_API_URL as string | undefined) ??
  '';

export type ModelHint = 'fast' | 'medium' | 'deep' | 'json';

export const MODELS: Record<ModelHint, string> = {
  fast:   'gemini-3-flash',
  medium: 'gemini-2-flash',
  deep:   'claude-sonnet-4-20250514',
  json:   'gpt-4o-mini',
};

export interface ModelUsageEntry {
  model: string;
  hint: ModelHint;
  calls: number;
  reason: string;
}

interface LLMResponse {
  choices?: { message?: { content?: string } }[];
  _meta?: { model: string; reason: string };
}

export interface ResearchReport {
  title: string;
  summary: string;
  key_findings: string[];
  tags: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface ResearchResult {
  success: boolean;
  report: ResearchReport;
  analysis: string;
  pipeline: Array<{ step: number; model: string; role: string; output: string }>;
  meta: { topic: string; duration_ms: number; models_used: string[]; steps: number; agent_id: number | null };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  model?: string;
}

export interface GeneratedTask {
  title: string;
  description: string;
  status: 'todo';
  priority: 'high' | 'medium' | 'low';
}

async function callBankrLLM(
  messages: { role: string; content: string }[],
  systemPrompt?: string,
  hint?: ModelHint,
  modelOverride?: string,
  max_tokens?: number,
): Promise<LLMResponse> {
  const body: Record<string, unknown> = { messages, max_tokens };
  if (systemPrompt) body.systemPrompt = systemPrompt;
  if (modelOverride) body.model = modelOverride;
  else if (hint) body.hint = hint;

  const res = await fetch(`${API_BASE}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Bankr LLM error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<LLMResponse>;
}

function extractContent(data: LLMResponse): string {
  return data.choices?.[0]?.message?.content ?? '';
}

export function useBankrAI(tasks: unknown[], messages: unknown[], agents: Agent[]) {

  const [modelUsage, setModelUsage] = useState<ModelUsageEntry[]>([]);

  const trackUsage = useCallback((model: string, reason: string) => {
    const hint = (Object.entries(MODELS).find(([, v]) => v === model)?.[0] ?? 'fast') as ModelHint;
    setModelUsage(prev => {
      const existing = prev.find(e => e.model === model);
      if (existing) return prev.map(e => e.model === model ? { ...e, calls: e.calls + 1 } : e);
      return [...prev, { model, hint, calls: 1, reason }];
    });
  }, []);

  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([{
    role: 'assistant',
    content: "Hello! I'm Beacon AI powered by Bankr LLM Gateway. I auto-select the best model — fast for simple questions, Claude for deep analysis. Ask me anything! 🦞",
  }]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

  const [generatedTasks, setGeneratedTasks] = useState<GeneratedTask[]>([]);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [summary, setSummary] = useState<string>('');
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [taskReview, setTaskReview] = useState<string>('');
  const [taskReviewLoading, setTaskReviewLoading] = useState(false);
  const [taskReviewError, setTaskReviewError] = useState<string | null>(null);

  const [agentBriefing, setAgentBriefing] = useState<string>('');
  const [agentBriefingLoading, setAgentBriefingLoading] = useState(false);
  const [agentBriefingError, setAgentBriefingError] = useState<string | null>(null);

  const [researchResult, setResearchResult] = useState<ResearchResult | null>(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [researchProgress, setResearchProgress] = useState<{ step: number; total: number; label: string; model: string } | null>(null);

  const sendChat = useCallback(async (userInput: string) => {
    if (!userInput.trim() || chatLoading) return;
    const userMsg: ChatMessage = { role: 'user', content: userInput };
    const newHistory = [...chatHistory, userMsg];
    setChatHistory(newHistory);
    setChatLoading(true);
    setChatError(null);

    const systemPrompt = [
      'You are an AI assistant for Beacon — a Kanban dashboard for autonomous AI agent teams.',
      `Tasks (${tasks.length}): ${(tasks as any[]).slice(0, 15).map(t => `[${t.status}] ${t.title}`).join(', ')}`,
      `Agents: ${agents.map(a => `${a.name} (${a.status})`).join(', ')}`,
      'Be concise and use markdown.',
    ].join('\n');

    const autoHint: ModelHint | undefined = newHistory.length > 6 ? 'deep' : undefined;

    try {
      const data = await callBankrLLM(newHistory.map(m => ({ role: m.role, content: m.content })), systemPrompt, autoHint);
      const usedModel = data._meta?.model ?? MODELS.fast;
      trackUsage(usedModel, data._meta?.reason ?? 'auto');
      setChatHistory([...newHistory, { role: 'assistant', content: extractContent(data), model: usedModel }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setChatError(msg);
      setChatHistory([...newHistory, { role: 'assistant', content: `❌ ${msg}` }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatHistory, chatLoading, tasks, agents, trackUsage]);

  const clearChat = useCallback(() => {
    setChatHistory([{ role: 'assistant', content: 'Chat reset. How can I help? 🦞' }]);
    setChatError(null);
  }, []);

  const generateTasks = useCallback(async (prompt: string) => {
    if (!prompt.trim() || generateLoading) return;
    setGenerateLoading(true);
    setGenerateError(null);
    setGeneratedTasks([]);

    const systemPrompt = 'You are a task planner. Create 3-5 tasks from the description.\nReply ONLY with a raw JSON array:\n[{"title":"...","description":"...","status":"todo","priority":"high"}]\npriority: high|medium|low';

    try {
      const data = await callBankrLLM([{ role: 'user', content: prompt }], systemPrompt, 'medium');
      trackUsage(data._meta?.model ?? MODELS.medium, 'generate-tasks');
      const clean = extractContent(data).replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(clean) as GeneratedTask[];
      if (!Array.isArray(parsed)) throw new Error('Not a valid JSON array');
      setGeneratedTasks(parsed);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : 'Failed to parse response');
    } finally {
      setGenerateLoading(false);
    }
  }, [generateLoading, trackUsage]);

  const clearGeneratedTasks = useCallback(() => { setGeneratedTasks([]); setGenerateError(null); }, []);

  const generateSummary = useCallback(async () => {
    setSummaryLoading(true);
    setSummaryError(null);
    setSummary('');
    const stats = tasks.reduce<Record<string, number>>((acc, t) => { acc[t.status] = (acc[t.status] ?? 0) + 1; return acc; }, {});
    try {
      const data = await callBankrLLM(
        [{ role: 'user', content: `Stats: ${JSON.stringify(stats)}\nAgents: ${agents.map(a => `${a.name}: ${a.status}`).join(', ')}\nActivity:\n${messages.slice(-15).map(m => `${m.agentName}: ${m.content.slice(0, 100)}`).join('\n')}` }],
        'Write a concise team summary with: **Team Summary**, **Agent Status**, **Activity Highlights**, **Recommendations**. Use markdown.',
        'fast',
      );
      trackUsage(data._meta?.model ?? MODELS.fast, 'summary');
      setSummary(extractContent(data));
    } catch (err) { setSummaryError(err instanceof Error ? err.message : 'Error'); }
    finally { setSummaryLoading(false); }
  }, [tasks, messages, agents, trackUsage]);

  const reviewTasks = useCallback(async () => {
    setTaskReviewLoading(true);
    setTaskReviewError(null);
    setTaskReview('');
    const inP = tasks.filter(t => t.status === 'in_progress');
    const rev = tasks.filter(t => t.status === 'review');
    const tod = tasks.filter(t => t.status === 'todo');
    const fmt = (list: unknown[]) => (list as any[]).map(t => `- "${t.title}"${t.description ? `: ${t.description.slice(0, 100)}` : ''}`).join('\n');
    try {
      const data = await callBankrLLM(
        [{ role: 'user', content: `In Progress:\n${fmt(inP)||'None'}\nIn Review:\n${fmt(rev)||'None'}\nTodo:\n${fmt(tod)||'None'}\nAgents: ${agents.map(a => `${a.name} (${a.status})`).join(', ')}` }],
        'You are a senior PM. Analyze tasks and write: **🔍 Bottlenecks**, **⚠️ Risks**, **✅ Quick Wins**, **💡 Recommendations**. Use markdown.',
        'deep',
      );
      trackUsage(data._meta?.model ?? MODELS.deep, 'task-review');
      setTaskReview(extractContent(data));
    } catch (err) { setTaskReviewError(err instanceof Error ? err.message : 'Error'); }
    finally { setTaskReviewLoading(false); }
  }, [tasks, agents, trackUsage]);

  const clearTaskReview = useCallback(() => { setTaskReview(''); setTaskReviewError(null); }, []);

  const generateAgentBriefing = useCallback(async (agentId: string) => {
    setAgentBriefingLoading(true);
    setAgentBriefingError(null);
    setAgentBriefing('');
    const agent = agents.find(a => a.id === agentId);
    if (!agent) { setAgentBriefingError('Agent not found'); setAgentBriefingLoading(false); return; }
    const agentTasks = (tasks as any[]).filter(t => t.agentId === agentId && t.status !== 'completed');
    try {
      const data = await callBankrLLM(
        [{ role: 'user', content: `Agent: ${agent.name} (${agent.role ?? 'AI Agent'}) - ${agent.status}\nTasks:\n${agentTasks.map(t => `- [${t.status}] ${t.title}`).join('\n') || 'None'}\nTeam:\n${tasks.filter(t => t.status === 'in_progress' && t.agentId !== agentId).slice(0, 5).map(t => `- ${t.title}`).join('\n') || 'None'}` }],
        `Prepare a briefing for ${agent.name} with: **🎯 Mission**, **📋 Active Tasks**, **⚡ Priority Action**, **🔗 Team Context**, **📌 Notes**. Markdown.`,
        'deep',
      );
      trackUsage(data._meta?.model ?? MODELS.deep, 'agent-briefing');
      setAgentBriefing(extractContent(data));
    } catch (err) { setAgentBriefingError(err instanceof Error ? err.message : 'Error'); }
    finally { setAgentBriefingLoading(false); }
  }, [tasks, agents, trackUsage]);

  const clearAgentBriefing = useCallback(() => { setAgentBriefing(''); setAgentBriefingError(null); }, []);

  // ── Research pipeline (calls /api/ai/research) ───────────────────────────
  const runResearch = useCallback(async (topic: string, context?: string, agentId?: string) => {
    if (!topic.trim() || researchLoading) return;
    setResearchLoading(true);
    setResearchError(null);
    setResearchResult(null);
    setResearchProgress({ step: 1, total: 3, label: 'Screening topic...', model: 'gemini-3-flash' });

    const t1 = setTimeout(() => setResearchProgress({ step: 2, total: 3, label: 'Deep analysis...', model: 'claude-sonnet-4' }), 2500);
    const t2 = setTimeout(() => setResearchProgress({ step: 3, total: 3, label: 'Formatting report...', model: 'gemini-2-flash' }), 6000);

    try {
      const res = await fetch(`${API_BASE}/api/ai/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, context: context || '', agent_id: agentId ? parseInt(agentId) : undefined }),
      });
      clearTimeout(t1); clearTimeout(t2);
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || `Research failed: ${res.status}`); }
      const result = await res.json() as ResearchResult;
      result.meta.models_used.forEach((model, i) => trackUsage(model, ['screening','analysis','formatting'][i] ?? 'research'));
      setResearchResult(result);
    } catch (err) {
      clearTimeout(t1); clearTimeout(t2);
      setResearchError(err instanceof Error ? err.message : 'Research pipeline failed');
    } finally {
      setResearchLoading(false);
      setResearchProgress(null);
    }
  }, [researchLoading, trackUsage]);

  const clearResearch = useCallback(() => { setResearchResult(null); setResearchError(null); setResearchProgress(null); }, []);

  return {
    modelUsage,
    chatHistory, chatLoading, chatError, sendChat, clearChat,
    generatedTasks, generateLoading, generateError, generateTasks, clearGeneratedTasks,
    summary, summaryLoading, summaryError, generateSummary,
    taskReview, taskReviewLoading, taskReviewError, reviewTasks, clearTaskReview,
    agentBriefing, agentBriefingLoading, agentBriefingError, generateAgentBriefing, clearAgentBriefing,
    researchResult, researchLoading, researchError, researchProgress, runResearch, clearResearch,
  };
}
