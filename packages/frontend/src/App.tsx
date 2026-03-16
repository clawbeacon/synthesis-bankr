import { useState, useCallback, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Wifi, WifiOff, FlaskConical, Users, BarChart3 } from 'lucide-react';
import type { Agent, ResearchReport, EconomyData } from './types';
import { ResearchPanel } from './components/ResearchPanel';
import { useBankrAI } from './hooks/useBankrAI';

const API_BASE: string =
  (window as any).__CLAW_CONFIG__?.API_URL ??
  (import.meta.env.VITE_API_URL as string | undefined) ??
  '';

// ── Helpers ────────────────────────────────────────────────────────────────
function transformAgent(a: Record<string, unknown>): Agent {
  return {
    id: String(a.id),
    name: String(a.name || ''),
    role: a.role ? String(a.role) : undefined,
    description: a.description ? String(a.description) : undefined,
    status: (a.status as Agent['status']) || 'idle',
    token_symbol: a.token_symbol ? String(a.token_symbol) : undefined,
    token_address: a.token_address ? String(a.token_address) : undefined,
    wallet_address: a.wallet_address ? String(a.wallet_address) : undefined,
    fee_balance: a.fee_balance ? Number(a.fee_balance) : 0,
    llm_calls: a.llm_calls ? Number(a.llm_calls) : 0,
    created_at: a.created_at ? String(a.created_at) : undefined,
  };
}

function transformReport(r: Record<string, unknown>): ResearchReport {
  const parseArray = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return []; } }
    return [];
  };
  return {
    id: String(r.id),
    agent_id: r.agent_id ? String(r.agent_id) : undefined,
    agent_name: r.agent_name ? String(r.agent_name) : undefined,
    topic: String(r.topic || ''),
    title: String(r.title || ''),
    summary: String(r.summary || ''),
    key_findings: parseArray(r.key_findings),
    tags: parseArray(r.tags),
    confidence: (r.confidence as any) || 'medium',
    analysis: r.analysis ? String(r.analysis) : undefined,
    models_used: parseArray(r.models_used),
    duration_ms: Number(r.duration_ms || 0),
    created_at: String(r.created_at || new Date().toISOString()),
  };
}

const CONFIDENCE_STYLES = {
  high:   { dot: 'bg-green-400',  text: 'text-green-400',  badge: 'bg-green-500/10 text-green-400 border-green-500/20' },
  medium: { dot: 'bg-amber-400',  text: 'text-amber-400',  badge: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
  low:    { dot: 'bg-red-400',    text: 'text-red-400',    badge: 'bg-red-500/10 text-red-400 border-red-500/20' },
};

const MODEL_COLORS: Record<string, string> = {
  'gemini-3-flash':            'text-amber-400',
  'gemini-2-flash':            'text-blue-400',
  'claude-sonnet-4-20250514':  'text-purple-400',
  'gpt-4o-mini':               'text-green-400',
};

function ModelTag({ model }: { model: string }) {
  const color = MODEL_COLORS[model] ?? 'text-white/40';
  const label = model.replace('claude-sonnet-4-20250514', 'claude-sonnet').replace('-20250514', '');
  return <span className={`text-[9px] font-medium ${color} bg-white/5 border border-white/8 px-1.5 py-0.5 rounded`}>{label}</span>;
}

function getRelative(dateStr: string): string {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Main App ───────────────────────────────────────────────────────────────
function BeaconApp() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [reports, setReports] = useState<ResearchReport[]>([]);
  const [economy, setEconomy] = useState<EconomyData | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<'feed' | 'research' | 'agents' | 'economy'>('feed');
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [filterConf, setFilterConf] = useState<string>('all');

  const ai = useBankrAI([], [], agents);

  // Fetch initial data
  useEffect(() => {
    fetch(`${API_BASE}/api/agents`)
      .then(r => r.json())
      .then(d => setAgents((d.data || d).map(transformAgent)))
      .catch(() => {});

    fetch(`${API_BASE}/api/reports`)
      .then(r => r.json())
      .then(d => setReports(Array.isArray(d) ? d.map(transformReport) : []))
      .catch(() => {});

    fetch(`${API_BASE}/api/economy`)
      .then(r => r.json())
      .then(d => setEconomy(d))
      .catch(() => {});
  }, []);

  // SSE
  useEffect(() => {
    const es = new EventSource(`${API_BASE}/api/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.addEventListener('init', (e: MessageEvent) => {
      const d = JSON.parse(e.data);
      if (d.agents) setAgents(d.agents.map(transformAgent));
      if (d.reports) setReports(d.reports.map(transformReport));
    });

    es.addEventListener('report-created', (e: MessageEvent) => {
      const d = JSON.parse(e.data);
      fetch(`${API_BASE}/api/reports/${d.id}`)
        .then(r => r.json())
        .then(report => setReports(prev => [transformReport(report), ...prev]))
        .catch(() => {});
    });

    es.addEventListener('report-deleted', (e: MessageEvent) => {
      const d = JSON.parse(e.data);
      setReports(prev => prev.filter(r => r.id !== String(d.id)));
    });

    es.addEventListener('agent-updated', (e: MessageEvent) => {
      const a = transformAgent(JSON.parse(e.data));
      setAgents(prev => prev.map(x => x.id === a.id ? { ...x, ...a } : x));
    });

    es.addEventListener('agent-created', (e: MessageEvent) => {
      setAgents(prev => [...prev, transformAgent(JSON.parse(e.data))]);
    });

    return () => es.close();
  }, []);

  const handleRunResearch = useCallback((topic: string, context?: string, agentId?: string) => {
    ai.runResearch(topic, context, agentId || selectedAgent || undefined);
  }, [ai, selectedAgent]);

  const filteredReports = reports.filter(r => filterConf === 'all' || r.confidence === filterConf);
  const liveAgents = agents.filter(a => a.status === 'working').length;

  return (
    <div className="h-screen flex flex-col bg-[#080808] text-white overflow-hidden font-mono">

      {/* Topbar */}
      <header className="h-12 border-b border-white/5 bg-[#0f0f0f] flex items-center justify-between px-5 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 border border-[#003322] bg-[#001a0d] flex items-center justify-center">
            <span className="text-[10px] text-green-400 font-bold tracking-wider">BCN</span>
          </div>
          <span className="text-sm font-semibold text-white tracking-tight" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>Beacon</span>
          <span className="text-[10px] text-white/20 uppercase tracking-widest border-l border-white/10 pl-3 ml-1">autonomous research</span>
        </div>

        <nav className="flex items-center gap-1">
          {(['feed', 'research', 'agents', 'economy'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 text-[11px] uppercase tracking-wider transition-colors ${activeTab === tab ? 'text-green-400' : 'text-white/30 hover:text-white/60'}`}>
              {tab}
            </button>
          ))}
        </nav>

        <div className={`flex items-center gap-2 px-3 py-1 border text-[10px] ${connected ? 'border-green-900 bg-green-950/50 text-green-400' : 'border-red-900 bg-red-950/50 text-red-400'}`}>
          {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
          {connected ? `${liveAgents} agent${liveAgents !== 1 ? 's' : ''} live` : 'offline'}
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">

        {/* ── Feed tab ── */}
        {activeTab === 'feed' && (
          <div className="flex-1 flex overflow-hidden">

            {/* Agent sidebar */}
            <aside className="w-52 border-r border-white/5 bg-[#0d0d0d] overflow-y-auto flex-shrink-0 p-3 flex flex-col gap-2">
              <div className="text-[9px] text-white/20 uppercase tracking-widest px-1 mb-1">Agents</div>
              {agents.map(a => (
                <div key={a.id} className={`p-2.5 border cursor-pointer transition-all ${selectedAgent === a.id ? 'border-white/15 bg-white/4' : 'border-white/5 hover:border-white/10'}`}
                  onClick={() => setSelectedAgent(selectedAgent === a.id ? '' : a.id)}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] text-white/80 font-medium">{a.name}</span>
                    <div className={`w-1.5 h-1.5 rounded-full ${a.status === 'working' ? 'bg-green-400' : a.status === 'idle' ? 'bg-white/20' : 'bg-white/10'}`} />
                  </div>
                  <div className="text-[10px] text-white/30">{a.role}</div>
                  {a.token_symbol && (
                    <div className="mt-1.5 text-[10px] text-green-400/70">{a.token_symbol} · ${a.fee_balance?.toFixed(2) ?? '0.00'}</div>
                  )}
                </div>
              ))}
              {agents.length === 0 && <div className="text-[10px] text-white/20 px-1">No agents yet</div>}
            </aside>

            {/* Reports feed */}
            <main className="flex-1 overflow-y-auto">
              <div className="border-b border-white/5 bg-[#0d0d0d] px-5 py-3 flex items-center justify-between sticky top-0 z-10">
                <div className="text-xs text-white/60">
                  {filteredReports.length} report{filteredReports.length !== 1 ? 's' : ''}
                  {selectedAgent && ` · ${agents.find(a => a.id === selectedAgent)?.name ?? ''}`}
                </div>
                <div className="flex gap-1">
                  {['all', 'high', 'medium', 'low'].map(f => (
                    <button key={f} onClick={() => setFilterConf(f)}
                      className={`px-2.5 py-1 text-[10px] uppercase tracking-wider border transition-all ${filterConf === f ? 'border-white/20 text-white bg-white/5' : 'border-white/5 text-white/30 hover:text-white/50'}`}>
                      {f}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-5 flex flex-col gap-3">
                {filteredReports.length === 0 && (
                  <div className="text-center py-16 text-white/20 text-sm">
                    <FlaskConical className="w-8 h-8 mx-auto mb-3 opacity-20" />
                    No reports yet — run a research task to get started
                  </div>
                )}
                {filteredReports.map(r => {
                  const conf = CONFIDENCE_STYLES[r.confidence] ?? CONFIDENCE_STYLES.medium;
                  return (
                    <div key={r.id} className="border border-white/6 bg-[#0f0f0f] p-4 hover:border-white/12 transition-colors">
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <h3 className="text-sm text-white font-medium leading-snug flex-1" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>{r.title}</h3>
                        <span className={`text-[9px] px-2 py-0.5 border rounded flex-shrink-0 ${conf.badge}`}>{r.confidence}</span>
                      </div>

                      <p className="text-[11px] text-white/40 leading-relaxed mb-3">{r.summary}</p>

                      {r.key_findings.length > 0 && (
                        <div className="mb-3 flex flex-col gap-1">
                          {r.key_findings.slice(0, 2).map((f, i) => (
                            <div key={i} className="flex gap-2 text-[11px] text-white/50">
                              <span className="text-green-400/60 flex-shrink-0">→</span>
                              <span>{f}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center justify-between pt-3 border-t border-white/5">
                        <div className="flex items-center gap-3">
                          {r.agent_name && <span className="text-[10px] text-white/30">by {r.agent_name}</span>}
                          <span className="text-[10px] text-white/20">{getRelative(r.created_at)}</span>
                          <span className="text-[10px] text-white/20">{(r.duration_ms / 1000).toFixed(1)}s</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {r.models_used.slice(0, 3).map((m, i) => <ModelTag key={i} model={m} />)}
                        </div>
                      </div>

                      {r.tags.length > 0 && (
                        <div className="flex gap-1.5 mt-2 flex-wrap">
                          {r.tags.map(t => (
                            <span key={t} className="text-[9px] px-1.5 py-0.5 bg-white/3 border border-white/6 text-white/30 uppercase tracking-wider">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </main>
          </div>
        )}

        {/* ── Research tab ── */}
        {activeTab === 'research' && (
          <div className="flex-1 flex overflow-hidden">
            {/* Left: input panel - fixed width, only show when no result OR loading */}
            <div className={`border-r border-white/5 overflow-y-auto flex-shrink-0 p-4 bg-[#0d0d0d] transition-all duration-300 ${ai.researchResult ? 'w-72' : 'w-96'}`}>
              <div className="text-[9px] text-white/20 uppercase tracking-widest mb-3">Run research</div>
              <ResearchPanel
                agents={agents}
                researchResult={ai.researchResult}
                researchLoading={ai.researchLoading}
                researchError={ai.researchError}
                researchProgress={ai.researchProgress}
                modelUsage={ai.modelUsage}
                onRunResearch={handleRunResearch}
                onClear={ai.clearResearch}
              />
            </div>
            {/* Right: result panel - takes remaining space */}
            <main className="flex-1 overflow-y-auto p-6 min-w-0">
              {ai.researchResult ? (
                <div className="w-full">
                  <h2 className="text-base font-semibold text-white mb-2 leading-snug" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>{ai.researchResult.report.title}</h2>
                  <p className="text-xs text-white/40 mb-5 leading-relaxed">{ai.researchResult.report.summary}</p>
                  <div className="text-[12px] text-white/60 leading-relaxed whitespace-pre-wrap font-mono bg-white/3 border border-white/5 p-5 rounded-lg">
                    {ai.researchResult.analysis}
                  </div>
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-white/15 flex-col gap-3">
                  <FlaskConical className="w-10 h-10 opacity-20" />
                  <p className="text-sm">Run a research task to see the full analysis here</p>
                </div>
              )}
            </main>
          </div>
        )}

        {/* ── Agents tab ── */}
        {activeTab === 'agents' && (
          <main className="flex-1 overflow-y-auto p-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl">
              {agents.map(a => (
                <div key={a.id} className="border border-white/8 bg-[#0f0f0f] p-4">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="text-sm font-semibold text-white" style={{ fontFamily: 'Space Grotesk, sans-serif' }}>{a.name}</div>
                      <div className="text-[11px] text-white/30 mt-0.5">{a.role}</div>
                    </div>
                    <div className={`text-[10px] px-2 py-0.5 border ${a.status === 'working' ? 'border-green-900 bg-green-950/50 text-green-400' : 'border-white/8 text-white/20'}`}>
                      {a.status}
                    </div>
                  </div>

                  {a.description && <p className="text-[11px] text-white/30 mb-3 leading-relaxed">{a.description}</p>}

                  <div className="border-t border-white/5 pt-3 flex flex-col gap-1.5">
                    {a.token_symbol && (
                      <div className="flex justify-between text-[10px]">
                        <span className="text-white/30">token</span>
                        <span className="text-green-400">{a.token_symbol}</span>
                      </div>
                    )}
                    {a.fee_balance !== undefined && (
                      <div className="flex justify-between text-[10px]">
                        <span className="text-white/30">fee balance</span>
                        <span className="text-green-400">${a.fee_balance.toFixed(4)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-[10px]">
                      <span className="text-white/30">llm calls</span>
                      <span className="text-white/50">{a.llm_calls ?? 0}</span>
                    </div>
                  </div>
                </div>
              ))}
              {agents.length === 0 && (
                <div className="col-span-3 text-center py-12 text-white/20 text-sm">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  No agents yet
                </div>
              )}
            </div>
          </main>
        )}

        {/* ── Economy tab ── */}
        {activeTab === 'economy' && (
          <main className="flex-1 overflow-y-auto p-6">
            {economy ? (
              <div className="max-w-3xl">
                {/* Totals */}
                <div className="grid grid-cols-3 gap-3 mb-6">
                  {[
                    { label: 'Total fee revenue', value: `$${economy.totals.total_fee_revenue.toFixed(4)}`, color: 'text-green-400' },
                    { label: 'Total LLM spend',   value: `$${economy.totals.total_llm_spend.toFixed(4)}`,   color: 'text-amber-400' },
                    { label: 'Net balance',        value: `$${economy.totals.total_net.toFixed(4)}`,         color: economy.totals.total_net >= 0 ? 'text-green-400' : 'text-red-400' },
                  ].map(s => (
                    <div key={s.label} className="border border-white/8 bg-[#0f0f0f] p-4">
                      <div className="text-[10px] text-white/30 uppercase tracking-wider mb-2">{s.label}</div>
                      <div className={`text-xl font-semibold ${s.color}`} style={{ fontFamily: 'Space Grotesk, sans-serif' }}>{s.value}</div>
                    </div>
                  ))}
                </div>

                {/* Per-agent breakdown */}
                <div className="border border-white/8">
                  <div className="grid grid-cols-6 gap-0 text-[9px] text-white/20 uppercase tracking-wider px-4 py-2.5 border-b border-white/5">
                    <div className="col-span-2">Agent</div>
                    <div>Fee revenue</div>
                    <div>LLM spend</div>
                    <div>Net</div>
                    <div>Status</div>
                  </div>
                  {economy.agents.map(a => (
                    <div key={a.agent_id} className="grid grid-cols-6 gap-0 px-4 py-3 border-b border-white/5 last:border-0 hover:bg-white/2 transition-colors">
                      <div className="col-span-2">
                        <div className="text-[11px] text-white/80 font-medium">{a.agent_name}</div>
                        {a.token_symbol && <div className="text-[10px] text-green-400/60">{a.token_symbol}</div>}
                      </div>
                      <div className="text-[11px] text-green-400">${a.fee_revenue.toFixed(4)}</div>
                      <div className="text-[11px] text-amber-400">${a.llm_spend.toFixed(4)}</div>
                      <div className={`text-[11px] font-medium ${a.net_balance >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {a.net_balance >= 0 ? '+' : ''}${a.net_balance.toFixed(4)}
                      </div>
                      <div>
                        {a.self_sustaining ? (
                          <span className="text-[9px] text-green-400 border border-green-900 bg-green-950/30 px-1.5 py-0.5">self-sustaining</span>
                        ) : (
                          <span className="text-[9px] text-white/20 border border-white/8 px-1.5 py-0.5">subsidized</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="mt-4 p-3 border border-green-900/50 bg-green-950/20 text-[11px] text-green-400/70">
                  Self-sustaining = token swap fees cover LLM inference costs via Bankr LLM Gateway
                </div>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-white/15 flex-col gap-3">
                <BarChart3 className="w-10 h-10 opacity-20" />
                <p className="text-sm">Loading economy data...</p>
              </div>
            )}
          </main>
        )}

      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/*" element={<BeaconApp />} />
      </Routes>
    </BrowserRouter>
  );
}
