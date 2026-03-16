/**
 * @fileoverview ResearchPanel — Beacon autonomous research pipeline UI.
 *
 * Shows:
 * - Research topic input
 * - Live pipeline progress (Step 1 gemini-flash → Step 2 claude-sonnet → Step 3 gemini-flash)
 * - Final report with key findings, confidence, tags
 * - Model usage economy tracker
 */

import { useState } from 'react';
import { Search, Loader2, CheckCircle2, Circle, Zap, Brain, FileText, BarChart3, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Agent } from '../types';
import type { ResearchResult, ModelUsageEntry } from '../hooks/useBankrAI';
import { MODELS } from '../hooks/useBankrAI';

interface ResearchPanelProps {
  agents: Agent[];
  researchResult: ResearchResult | null;
  researchLoading: boolean;
  researchError: string | null;
  researchProgress: { step: number; total: number; label: string; model: string } | null;
  modelUsage: ModelUsageEntry[];
  onRunResearch: (topic: string, context?: string, agentId?: string) => void;
  onClear: () => void;
}

const MODEL_COLORS: Record<string, { text: string; bg: string; border: string }> = {
  [MODELS.fast]:   { text: 'text-amber-400',  bg: 'bg-amber-500/10',  border: 'border-amber-500/20' },
  [MODELS.medium]: { text: 'text-blue-400',   bg: 'bg-blue-500/10',   border: 'border-blue-500/20' },
  [MODELS.deep]:   { text: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20' },
  [MODELS.json]:   { text: 'text-green-400',  bg: 'bg-green-500/10',  border: 'border-green-500/20' },
};

const MODEL_LABELS: Record<string, string> = {
  [MODELS.fast]:   'gemini-flash',
  [MODELS.medium]: 'gemini-2-flash',
  [MODELS.deep]:   'claude-sonnet-4',
  [MODELS.json]:   'gpt-4o-mini',
};

function ModelBadge({ model }: { model: string }) {
  const colors = PROFILE_COLORS[model] ?? MODEL_COLORS[model] ?? MODEL_COLORS[MODELS.fast];
  const label = MODEL_LABELS[model] ?? model;
  return (
    <span className={`text-[9px] px-2 py-0.5 rounded border font-medium ${colors.text} ${colors.bg} ${colors.border}`}>
      {label}
    </span>
  );
}

const PIPELINE_STEPS = [
  { step: 1, label: 'Screen topic',   model: 'eco profile',     icon: Zap,      desc: 'Cheapest eligible model — fast screening' },
  { step: 2, label: 'Deep analysis',  model: 'premium profile', icon: Brain,    desc: 'Best reasoning model — thorough analysis' },
  { step: 3, label: 'Format report',  model: 'eco profile',     icon: FileText, desc: 'Reliable structured JSON output' },
];

const PROFILE_COLORS: Record<string, { text: string; bg: string; border: string }> = {
  'eco profile':     { text: 'text-green-400',  bg: 'bg-green-500/10',  border: 'border-green-500/20' },
  'premium profile': { text: 'text-purple-400', bg: 'bg-purple-500/10', border: 'border-purple-500/20' },
};

const CONFIDENCE_STYLES: Record<string, { text: string; bg: string; border: string }> = {
  high:   { text: 'text-green-400',  bg: 'bg-green-500/10',  border: 'border-green-500/20' },
  medium: { text: 'text-amber-400',  bg: 'bg-amber-500/10',  border: 'border-amber-500/20' },
  low:    { text: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/20' },
};

export function ResearchPanel({
  agents,
  researchResult,
  researchLoading,
  researchError,
  researchProgress,
  modelUsage,
  onRunResearch,
  onClear,
}: ResearchPanelProps) {
  const [topic, setTopic] = useState('');
  const [context, setContext] = useState('');
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(false);

  const handleRun = () => {
    if (!topic.trim() || researchLoading) return;
    onRunResearch(topic.trim(), context.trim(), selectedAgent || undefined);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun();
  };

  // ── Input view ─────────────────────────────────────────────────────────
  if (!researchLoading && !researchResult && !researchError) {
    return (
      <div className="flex flex-col gap-4">
        {/* Pipeline explanation */}
        <div className="bg-white/3 border border-white/5 rounded-lg p-3">
          <p className="text-xs text-accent-muted mb-3 font-medium">3-step autonomous pipeline</p>
          <div className="flex flex-col gap-2">
            {PIPELINE_STEPS.map((s, i) => {
              const Icon = s.icon as React.ElementType;
              const colors = PROFILE_COLORS[s.model] ?? MODEL_COLORS[s.model] ?? MODEL_COLORS[MODELS.fast];
              return (
                <div key={s.step} className="flex items-start gap-2.5">
                  <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 mt-0.5 border ${colors.bg} ${colors.border}`}>
                    <Icon className={`w-3 h-3 ${colors.text}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-white/80 font-medium">{s.label}</span>
                      <ModelBadge model={s.model} />
                    </div>
                    <p className="text-[10px] text-accent-muted mt-0.5">{s.desc}</p>
                  </div>
                  {i < PIPELINE_STEPS.length - 1 && (
                    <div className="absolute left-5 text-white/10 text-[8px]">↓</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Topic input */}
        <div>
          <label className="text-[10px] text-accent-muted uppercase tracking-wider block mb-1.5">
            Research topic
          </label>
          <textarea
            value={topic}
            onChange={e => setTopic(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. Analyze liquidity patterns on Uniswap V4 Base pools this week"
            className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white placeholder:text-white/20 resize-none focus:outline-none focus:border-white/20 transition-colors"
            rows={3}
          />
        </div>

        {/* Agent attribution */}
        <div className="relative">
          <label className="text-[10px] text-accent-muted uppercase tracking-wider block mb-1.5">
            Run as agent (optional)
          </label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setAgentDropdownOpen(!agentDropdownOpen)}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 text-left flex items-center justify-between hover:border-white/20 transition-colors"
            >
              <span>{selectedAgent ? (agents.find(a => a.id === selectedAgent)?.name ?? 'Unknown') + ' (' + (agents.find(a => a.id === selectedAgent)?.role ?? 'Agent') + ')' : 'No attribution'}</span>
              <span className="text-white/30 text-xs">▾</span>
            </button>
            {agentDropdownOpen && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-[#1a1a1a] border border-white/15 rounded-lg overflow-hidden z-50">
                <div
                  className="px-3 py-2 text-sm text-white/60 hover:bg-white/8 cursor-pointer transition-colors"
                  onClick={() => { setSelectedAgent(''); setAgentDropdownOpen(false); }}
                >
                  No attribution
                </div>
                {agents.map(a => (
                  <div
                    key={a.id}
                    className={`px-3 py-2 text-sm cursor-pointer transition-colors ${selectedAgent === a.id ? 'bg-white/10 text-white' : 'text-white/80 hover:bg-white/8'}`}
                    onClick={() => { setSelectedAgent(a.id); setAgentDropdownOpen(false); }}
                  >
                    {a.name} <span className="text-white/40">({a.role ?? 'Agent'})</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Extra context toggle */}
        <button
          onClick={() => setShowContext(!showContext)}
          className="text-[11px] text-accent-muted hover:text-white/60 text-left transition-colors"
        >
          {showContext ? '− hide' : '+ add'} extra context
        </button>

        {showContext && (
          <textarea
            value={context}
            onChange={e => setContext(e.target.value)}
            placeholder="Paste any relevant data, task descriptions, or onchain info..."
            className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white placeholder:text-white/20 resize-none focus:outline-none focus:border-white/20 transition-colors"
            rows={4}
          />
        )}

        <button
          onClick={handleRun}
          disabled={!topic.trim()}
          className="w-full py-2.5 rounded-lg bg-accent-primary/10 border border-accent-primary/30 text-accent-primary text-sm font-medium hover:bg-accent-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          <Search className="w-4 h-4" />
          Run research pipeline
        </button>

        <p className="text-[10px] text-accent-muted text-center">⌘↵ to run</p>

        {/* Model usage summary if any */}
        {modelUsage.length > 0 && (
          <div className="border-t border-white/5 pt-3">
            <p className="text-[10px] text-accent-muted uppercase tracking-wider mb-2">Session model usage</p>
            <div className="flex flex-col gap-1.5">
              {modelUsage.map(u => {
                const colors = MODEL_COLORS[u.model] ?? MODEL_COLORS[MODELS.fast];
                return (
                  <div key={u.model} className="flex items-center justify-between">
                    <ModelBadge model={u.model} />
                    <span className={`text-[10px] ${colors.text}`}>{u.calls} call{u.calls !== 1 ? 's' : ''}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Loading / pipeline progress ─────────────────────────────────────────
  if (researchLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="text-center py-4">
          <Loader2 className="w-6 h-6 animate-spin text-accent-primary mx-auto mb-3" />
          <p className="text-sm text-white/80 font-medium">Running research pipeline</p>
          <p className="text-xs text-accent-muted mt-1">This takes ~10-15 seconds</p>
        </div>

        {/* Pipeline step progress */}
        <div className="flex flex-col gap-2">
          {PIPELINE_STEPS.map(s => {
            const currentStep = researchProgress?.step ?? 0;
            const isDone = s.step < currentStep;
            const isActive = s.step === currentStep;
            const colors = PROFILE_COLORS[s.model] ?? MODEL_COLORS[s.model] ?? MODEL_COLORS[MODELS.fast];

            return (
              <div
                key={s.step}
                className={`flex items-center gap-3 p-2.5 rounded-lg border transition-all ${
                  isActive
                    ? `${colors.bg} ${colors.border}`
                    : isDone
                    ? 'bg-green-500/5 border-green-500/15'
                    : 'bg-white/2 border-white/5 opacity-40'
                }`}
              >
                <div className="flex-shrink-0">
                  {isDone ? (
                    <CheckCircle2 className="w-4 h-4 text-green-400" />
                  ) : isActive ? (
                    <Loader2 className={`w-4 h-4 animate-spin ${colors.text}`} />
                  ) : (
                    <Circle className="w-4 h-4 text-white/20" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-medium ${isDone ? 'text-green-400' : isActive ? 'text-white' : 'text-white/30'}`}>
                      Step {s.step}: {s.label}
                    </span>
                    <ModelBadge model={s.model} />
                  </div>
                  {isActive && researchProgress && (
                    <p className={`text-[10px] mt-0.5 ${colors.text}`}>{researchProgress.label}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[10px] text-accent-muted text-center">
          Using 3 models: gemini-flash → claude-sonnet → gemini-flash
        </p>
      </div>
    );
  }

  // ── Error ───────────────────────────────────────────────────────────────
  if (researchError) {
    return (
      <div className="flex flex-col gap-3">
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          <p className="text-xs text-red-400 font-medium mb-1">Research failed</p>
          <p className="text-[11px] text-red-400/70">{researchError}</p>
        </div>
        <button
          onClick={onClear}
          className="w-full py-2 rounded-lg border border-white/10 text-white/60 text-sm hover:text-white hover:border-white/20 transition-colors flex items-center justify-center gap-2"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Try again
        </button>
      </div>
    );
  }

  // ── Result ──────────────────────────────────────────────────────────────
  if (researchResult) {
    const { report, analysis, pipeline, meta } = researchResult;
    const confStyle = CONFIDENCE_STYLES[report.confidence] ?? CONFIDENCE_STYLES.medium;

    return (
      <div className="flex flex-col gap-3">
        {/* Report header */}
        <div className="bg-white/3 border border-white/8 rounded-lg p-3">
          <div className="flex items-start justify-between gap-2 mb-2">
            <h4 className="text-sm font-semibold text-white leading-snug flex-1">{report.title}</h4>
            <span className={`text-[9px] px-2 py-0.5 rounded border font-medium flex-shrink-0 ${confStyle.text} ${confStyle.bg} ${confStyle.border}`}>
              {report.confidence} confidence
            </span>
          </div>
          <p className="text-[11px] text-accent-muted leading-relaxed">{report.summary}</p>
        </div>

        {/* Key findings */}
        {report.key_findings?.length > 0 && (
          <div>
            <p className="text-[10px] text-accent-muted uppercase tracking-wider mb-1.5">Key findings</p>
            <div className="flex flex-col gap-1.5">
              {report.key_findings.map((f, i) => (
                <div key={i} className="flex gap-2 text-[11px] text-white/70 leading-relaxed">
                  <span className="text-accent-primary flex-shrink-0 mt-0.5">→</span>
                  <span>{f}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tags */}
        {report.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {report.tags.map(tag => (
              <span key={tag} className="text-[9px] px-2 py-0.5 rounded bg-white/5 border border-white/8 text-white/50 uppercase tracking-wider">
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Pipeline trace */}
        <div className="border border-white/5 rounded-lg p-2.5">
          <p className="text-[10px] text-accent-muted uppercase tracking-wider mb-2">Pipeline ({meta.duration_ms}ms)</p>
          <div className="flex flex-col gap-1.5">
            {pipeline.map(step => (
              <div key={step.step} className="flex items-center gap-2">
                <CheckCircle2 className="w-3 h-3 text-green-400 flex-shrink-0" />
                <span className="text-[10px] text-white/50 flex-1">Step {step.step}: {step.role}</span>
                <ModelBadge model={step.model} />
              </div>
            ))}
          </div>
          {meta.agent_id && (
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/5">
              <span className="text-[10px] text-accent-muted">attributed to agent #{meta.agent_id}</span>
            </div>
          )}
        </div>

        {/* Full analysis toggle */}
        <button
          onClick={() => setShowAnalysis(!showAnalysis)}
          className="text-[11px] text-accent-muted hover:text-white/60 text-left transition-colors flex items-center gap-1.5"
        >
          <BarChart3 className="w-3.5 h-3.5" />
          {showAnalysis ? 'Hide' : 'Show'} full analysis
        </button>

        {showAnalysis && (
          <div className="bg-white/3 border border-white/5 rounded-lg p-3 max-h-64 overflow-y-auto">
            <div className="prose prose-invert prose-sm max-w-none text-white/70 prose-p:my-1 prose-headings:text-white prose-headings:text-xs prose-ul:my-1 prose-li:my-0.5 text-[11px] leading-relaxed">
              <ReactMarkdown>{analysis}</ReactMarkdown>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={onClear}
            className="flex-1 py-2 rounded-lg border border-white/10 text-white/60 text-xs hover:text-white hover:border-white/20 transition-colors"
          >
            New research
          </button>
          <button
            onClick={() => navigator.clipboard?.writeText(JSON.stringify(report, null, 2))}
            className="flex-1 py-2 rounded-lg border border-white/10 text-white/60 text-xs hover:text-white hover:border-white/20 transition-colors"
          >
            Copy JSON
          </button>
        </div>
      </div>
    );
  }

  return null;
}
