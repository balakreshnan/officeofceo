import { useState, useEffect, useRef, useCallback } from 'react';
import { Session, SessionSummary, ChatMessage, StreamEvent, TokenUsage } from './types';
import { useStreamingChat } from './hooks/useStreamingChat';
import { useVoiceInput } from './hooks/useVoiceInput';
import ReactMarkdown from 'react-markdown';
import { Send, Mic, MicOff, Plus, MessageSquare, Zap, X, Edit3, Check, RotateCcw, GitBranch, AlertTriangle, BarChart3 } from 'lucide-react';
import ForceGraph2D from 'react-force-graph-2d';

interface GraphNode {
  id: string;
  label: string;
  group: string;
  details?: string;
}

interface GraphLink {
  source: string;
  target: string;
  label?: string;
}

interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
  knowledge_graph_ref?: string;
}

function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [input, setInput] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [activeTab, setActiveTab] = useState<'chat' | 'graph' | 'watermelon' | 'scorecard'>('chat');
  const [graphData, setGraphData] = useState<GraphData | null>(null);
  const [watermelonRevealed, setWatermelonRevealed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const graphContainerRef = useRef<HTMLDivElement>(null);

  const { sendMessage, cancelStream, isStreaming, activeAgent } = useStreamingChat();

  const handleVoiceResult = useCallback((text: string) => {
    setInput(prev => prev + text);
  }, []);

  const { isListening, isSupported, startListening, stopListening } = useVoiceInput(handleVoiceResult);

  // Load sessions
  useEffect(() => {
    fetchSessions();
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [input]);

  async function fetchSessions() {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      setSessions(data);
    } catch { /* no-op */ }
  }

  async function createSession() {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New Session' }),
      });
      const data = await res.json();
      await fetchSessions();
      await loadSession(data.id);
    } catch { /* no-op */ }
  }

  async function loadSession(sessionId: string) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      const data = await res.json();
      setActiveSession(data);
    } catch { /* no-op */ }
  }

  async function handleSend() {
    if (!input.trim() || isStreaming) return;

    let session = activeSession;
    if (!session) {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: input.slice(0, 50) }),
      });
      const data = await res.json();
      session = {
        id: data.id,
        title: data.title,
        messages: [],
        token_usage: {
          context_builder: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          insights: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          cumulative: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setActiveSession(session);
      await fetchSessions();
    }

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      is_edited: false,
      timestamp: new Date().toISOString(),
    };

    setActiveSession(prev => prev ? {
      ...prev,
      messages: [...prev.messages, userMessage],
    } : null);

    const query = input;
    setInput('');

    await sendMessage(session.id, query, (event: StreamEvent) => {
      handleStreamEvent(event);
    });

    fetchSessions();
  }

  function handleStreamEvent(event: StreamEvent) {
    switch (event.type) {
      case 'agent_started':
        setActiveSession(prev => {
          if (!prev) return null;
          const newMsg: ChatMessage = {
            id: event.message_id || crypto.randomUUID(),
            role: 'assistant',
            content: '',
            agent: event.agent as ChatMessage['agent'],
            is_edited: false,
            timestamp: new Date().toISOString(),
          };
          return { ...prev, messages: [...prev.messages, newMsg] };
        });
        break;

      case 'token':
        setActiveSession(prev => {
          if (!prev) return null;
          const messages = [...prev.messages];
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.agent === event.agent) {
            messages[messages.length - 1] = {
              ...lastMsg,
              content: lastMsg.content + (event.content || ''),
            };
          }
          return { ...prev, messages };
        });
        break;

      case 'agent_completed':
        if (event.cumulative_usage) {
          setActiveSession(prev => {
            if (!prev) return null;
            return {
              ...prev,
              token_usage: {
                ...prev.token_usage,
                cumulative: event.cumulative_usage as TokenUsage,
              },
            };
          });
        }
        break;

      case 'done':
        if (event.cumulative_usage) {
          setActiveSession(prev => {
            if (!prev) return null;
            return {
              ...prev,
              token_usage: {
                ...prev.token_usage,
                cumulative: event.cumulative_usage as TokenUsage,
              },
            };
          });
        }
        break;

      case 'error':
        setActiveSession(prev => {
          if (!prev) return null;
          const errorMsg: ChatMessage = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `⚠️ Error: ${event.error}`,
            is_edited: false,
            timestamp: new Date().toISOString(),
          };
          return { ...prev, messages: [...prev.messages, errorMsg] };
        });
        break;

      case 'context_graph':
        if (event.data) {
          setGraphData(event.data);
        }
        break;
    }
  }

  async function handleEdit(messageId: string) {
    if (!activeSession) return;
    try {
      const res = await fetch('/api/messages/edit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_id: messageId,
          session_id: activeSession.id,
          new_content: editContent,
        }),
      });
      if (res.ok) {
        setActiveSession(prev => {
          if (!prev) return null;
          return {
            ...prev,
            messages: prev.messages.map(m =>
              m.id === messageId ? { ...m, content: editContent, is_edited: true } : m
            ),
          };
        });
      }
    } catch { /* no-op */ }
    setEditingId(null);
    setEditContent('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSuggestion(text: string) {
    setInput(text);
    textareaRef.current?.focus();
  }

  const cumulativeTokens = activeSession?.token_usage?.cumulative?.total_tokens || 0;

  return (
    <div className="app-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon">CEO</div>
            <div>
              <h1>Office of CEO</h1>
              <p>Insights Builder</p>
            </div>
          </div>
          <button className="new-session-btn" onClick={createSession}>
            <Plus size={14} /> New Session
          </button>
        </div>
        <div className="sidebar-sessions">
          {sessions.length === 0 ? (
            <div className="no-sessions">No sessions yet. Start a conversation!</div>
          ) : (
            sessions.map(s => (
              <div
                key={s.id}
                className={`session-item ${activeSession?.id === s.id ? 'active' : ''}`}
                onClick={() => loadSession(s.id)}
              >
                <div className="session-item-title">
                  <MessageSquare size={12} style={{ marginRight: 6, opacity: 0.5 }} />
                  {s.title}
                </div>
                <div className="session-item-meta">
                  {s.message_count} messages • {s.token_usage.total_tokens.toLocaleString()} tokens
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        {/* Header */}
        <header className="chat-header">
          <div className="chat-header-left">
            <div className="chat-header-title">
              {activeSession ? activeSession.title : 'Office of CEO - Insights Builder'}
            </div>
            <div className="tab-bar">
              <button
                className={`tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
                onClick={() => setActiveTab('chat')}
              >
                <MessageSquare size={14} /> Chat
              </button>
              <button
                className={`tab-btn ${activeTab === 'graph' ? 'active' : ''}`}
                onClick={() => setActiveTab('graph')}
                disabled={!graphData}
              >
                <GitBranch size={14} /> Knowledge Graph
                {graphData && <span className="tab-badge">{graphData.nodes.length}</span>}
              </button>
              <button
                className={`tab-btn ${activeTab === 'watermelon' ? 'active' : ''}`}
                onClick={() => setActiveTab('watermelon')}
              >
                <AlertTriangle size={14} /> 🍉 Watermelon
              </button>
              <button
                className={`tab-btn ${activeTab === 'scorecard' ? 'active' : ''}`}
                onClick={() => setActiveTab('scorecard')}
              >
                <BarChart3 size={14} /> Scorecard
              </button>
            </div>
          </div>
          <div className="token-counter">
            <Zap size={14} />
            Session Tokens: <span className="token-value">{cumulativeTokens.toLocaleString()}</span>
          </div>
        </header>

        {/* Tab Content */}
        {activeTab === 'scorecard' ? (
          <div className="scorecard-container">
            <div className="scorecard-header">
              <h2>📊 Executive Account Scorecard</h2>
              <p className="scorecard-subtitle">Side-by-side account health comparison — scalable across the portfolio</p>
            </div>

            <div className="scorecard-comparison">
              {/* Helios Energy Group */}
              <div className="sc-card">
                <div className="sc-card-header">
                  <div className="sc-account-name">Helios Energy Group</div>
                  <div className="sc-tier diamond">Diamond</div>
                </div>
                <div className="sc-health-bar">
                  <div className="sc-health-indicator amber" style={{ width: '52%' }}></div>
                </div>
                <div className="sc-health-label">Overall Health: <span className="amber">At Risk (52)</span></div>

                <div className="sc-metrics">
                  <div className="sc-metric-block">
                    <div className="sc-metric-title">Revenue</div>
                    <div className="sc-metric-big green">$48.2M</div>
                    <div className="sc-metric-delta green">↑ 8.1% YoY</div>
                  </div>
                  <div className="sc-metric-block">
                    <div className="sc-metric-title">Pipeline</div>
                    <div className="sc-metric-big">$12.6M</div>
                    <div className="sc-metric-delta">4 active deals</div>
                  </div>
                  <div className="sc-metric-block">
                    <div className="sc-metric-title">ACR (Monthly)</div>
                    <div className="sc-metric-big green">$3.8M</div>
                    <div className="sc-metric-delta green">↑ 12.4% MoM</div>
                  </div>
                  <div className="sc-metric-block">
                    <div className="sc-metric-title">CSAT</div>
                    <div className="sc-metric-big green">4.2/5</div>
                    <div className="sc-metric-delta amber">↓ 0.3 from Q1</div>
                  </div>
                </div>

                <div className="sc-section">
                  <div className="sc-section-title">Risk Factors</div>
                  <div className="sc-risk-list">
                    <div className="sc-risk red">Champion departure — R. Vance (Aug)</div>
                    <div className="sc-risk red">CFO migration fatigue signal</div>
                    <div className="sc-risk amber">Multi-cloud board mandate (Q4)</div>
                    <div className="sc-risk amber">AWS competitor workshops detected</div>
                  </div>
                </div>

                <div className="sc-section">
                  <div className="sc-section-title">CSAT Trend (6 mo)</div>
                  <div className="sc-sparkline">
                    <svg viewBox="0 0 200 40" className="sc-spark-svg">
                      <polyline points="0,8 33,6 66,5 100,10 133,14 166,18 200,16" fill="none" stroke="#f59e0b" strokeWidth="2" />
                      <circle cx="200" cy="16" r="3" fill="#f59e0b" />
                    </svg>
                    <div className="sc-spark-labels">
                      <span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span>
                    </div>
                  </div>
                </div>

                <div className="sc-section">
                  <div className="sc-section-title">Renewal</div>
                  <div className="sc-renewal">
                    <span className="sc-renewal-date">Sep 15, 2026</span>
                    <span className="sc-renewal-status amber">⚠️ Needs Attention</span>
                  </div>
                </div>
              </div>

              {/* Aster Pharmaceuticals */}
              <div className="sc-card">
                <div className="sc-card-header">
                  <div className="sc-account-name">Aster Pharmaceuticals</div>
                  <div className="sc-tier platinum">Platinum</div>
                </div>
                <div className="sc-health-bar">
                  <div className="sc-health-indicator green" style={{ width: '87%' }}></div>
                </div>
                <div className="sc-health-label">Overall Health: <span className="green">Strong (87)</span></div>

                <div className="sc-metrics">
                  <div className="sc-metric-block">
                    <div className="sc-metric-title">Revenue</div>
                    <div className="sc-metric-big green">$31.4M</div>
                    <div className="sc-metric-delta green">↑ 14.2% YoY</div>
                  </div>
                  <div className="sc-metric-block">
                    <div className="sc-metric-title">Pipeline</div>
                    <div className="sc-metric-big">$8.9M</div>
                    <div className="sc-metric-delta green">6 active deals</div>
                  </div>
                  <div className="sc-metric-block">
                    <div className="sc-metric-title">ACR (Monthly)</div>
                    <div className="sc-metric-big green">$2.4M</div>
                    <div className="sc-metric-delta green">↑ 18.7% MoM</div>
                  </div>
                  <div className="sc-metric-block">
                    <div className="sc-metric-title">CSAT</div>
                    <div className="sc-metric-big green">4.6/5</div>
                    <div className="sc-metric-delta green">↑ 0.2 from Q1</div>
                  </div>
                </div>

                <div className="sc-section">
                  <div className="sc-section-title">Risk Factors</div>
                  <div className="sc-risk-list">
                    <div className="sc-risk green">No critical risks identified</div>
                    <div className="sc-risk amber">Budget approval pending for AI platform</div>
                  </div>
                </div>

                <div className="sc-section">
                  <div className="sc-section-title">CSAT Trend (6 mo)</div>
                  <div className="sc-sparkline">
                    <svg viewBox="0 0 200 40" className="sc-spark-svg">
                      <polyline points="0,22 33,18 66,14 100,12 133,10 166,8 200,6" fill="none" stroke="#22c55e" strokeWidth="2" />
                      <circle cx="200" cy="6" r="3" fill="#22c55e" />
                    </svg>
                    <div className="sc-spark-labels">
                      <span>Jan</span><span>Feb</span><span>Mar</span><span>Apr</span><span>May</span><span>Jun</span>
                    </div>
                  </div>
                </div>

                <div className="sc-section">
                  <div className="sc-section-title">Renewal</div>
                  <div className="sc-renewal">
                    <span className="sc-renewal-date">Mar 1, 2027</span>
                    <span className="sc-renewal-status green">✓ On Track</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="scorecard-footer">
              <div className="sc-insight-box">
                <strong>💡 Portfolio Insight:</strong> Helios revenue masks underlying relationship erosion — agent intelligence detects 4 tacit signals missed by CRM. Aster shows genuine health trajectory with rising engagement and no hidden blockers.
              </div>
            </div>
          </div>
        ) : activeTab === 'watermelon' ? (
          <div className="watermelon-container">
            <div className="watermelon-header">
              <h2>🍉 The Watermelon Reveal</h2>
              <p className="watermelon-subtitle">What your systems see vs. what our agent uncovers</p>
              <div className="watermelon-account-badge">
                Account: Helios Energy Group &nbsp;|&nbsp; TPID: TPD-44120 &nbsp;|&nbsp; Tier: Diamond
              </div>
            </div>

            <div className="watermelon-grid">
              {/* System Dashboard — Green */}
              <div className="wm-panel wm-green-panel">
                <div className="wm-panel-label">📊 System Dashboard — CRM + Telemetry</div>
                <div className="wm-metric"><span>Annual Revenue (YTD)</span><span className="wm-val green">$48.2M (+8.1%)</span></div>
                <div className="wm-metric"><span>Azure Consumption (MoM)</span><span className="wm-val green">↑ 12.4%</span></div>
                <div className="wm-metric"><span>NPS Score</span><span className="wm-val green">72</span></div>
                <div className="wm-metric"><span>Support Tickets (P1/P2)</span><span className="wm-val green">3 open</span></div>
                <div className="wm-metric"><span>Engagement Score</span><span className="wm-pill green">● Healthy</span></div>
                <div className="wm-metric"><span>Renewal Forecast</span><span className="wm-pill green">● On Track</span></div>
              </div>

              {/* Agent Intel — Red Inside */}
              <div className={`wm-panel wm-red-panel ${watermelonRevealed ? 'revealed' : ''}`}>
                <div className="wm-panel-label">🚨 Agent Intel — Tacit Knowledge Layer</div>
                <div className="wm-metric"><span>CFO Sentiment (private briefing)</span><span className="wm-val red">Migration Blocker</span></div>
                <div className="wm-metric"><span>Board Directive (Q3)</span><span className="wm-val amber">Multi-cloud mandate</span></div>
                <div className="wm-metric"><span>Champion Risk</span><span className="wm-val red">R. Vance → departing Aug</span></div>
                <div className="wm-metric"><span>Budget Reallocation</span><span className="wm-val amber">-30% cloud by Q4</span></div>
                <div className="wm-metric"><span>True Risk Assessment</span><span className="wm-pill amber">● At Risk</span></div>
                <div className="wm-metric"><span>Real Renewal Probability</span><span className="wm-pill red">● 52% (was 94%)</span></div>
              </div>
            </div>

            {/* Risk Gauge */}
            <div className="wm-gauge-section">
              <svg viewBox="0 0 320 180" width="320" height="180">
                <path d="M 30 160 A 130 130 0 0 1 290 160" fill="none" stroke="var(--border-subtle)" strokeWidth="20" strokeLinecap="round" />
                <path d="M 30 160 A 130 130 0 0 1 115 35" fill="none" stroke="#22c55e" strokeWidth="20" strokeLinecap="round" opacity="0.3" />
                <path d="M 115 35 A 130 130 0 0 1 205 35" fill="none" stroke="#f59e0b" strokeWidth="20" strokeLinecap="round" opacity="0.3" />
                <path d="M 205 35 A 130 130 0 0 1 290 160" fill="none" stroke="#ef4444" strokeWidth="20" strokeLinecap="round" opacity="0.3" />
                <line
                  x1="160" y1="160"
                  x2={watermelonRevealed ? "220" : "80"}
                  y2={watermelonRevealed ? "50" : "60"}
                  stroke="var(--text-primary)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  style={{ transition: 'all 1.2s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
                />
                <circle cx="160" cy="160" r="8" fill="var(--text-primary)" />
              </svg>
              <div className={`wm-gauge-label ${watermelonRevealed ? 'amber' : 'green'}`}>
                {watermelonRevealed ? 'AT RISK' : 'LOW RISK'}
              </div>
              <div className="wm-gauge-sublabel">
                {watermelonRevealed ? 'Adjusted with tacit knowledge signals' : 'Based on CRM + telemetry signals'}
              </div>
            </div>

            {/* Reveal Button */}
            <div className="wm-reveal-section">
              <button
                className="wm-reveal-btn"
                onClick={() => setWatermelonRevealed(true)}
                disabled={watermelonRevealed}
              >
                {watermelonRevealed ? '✓ Intelligence Layer Active' : '🔍 Activate Agent Intelligence Layer'}
              </button>

              {watermelonRevealed && (
                <button
                  className="wm-reset-btn"
                  onClick={() => setWatermelonRevealed(false)}
                >
                  <RotateCcw size={14} /> Reset
                </button>
              )}
            </div>

            {/* Revealed Content */}
            {watermelonRevealed && (
              <div className="wm-revealed-content">
                {/* Score comparison */}
                <div className="wm-comparison">
                  <div className="wm-score-card">
                    <div className="wm-score-label">System Risk Score</div>
                    <div className="wm-score green">94%</div>
                    <div className="wm-score-sub">Renewal Confidence</div>
                  </div>
                  <div className="wm-arrow">→</div>
                  <div className="wm-score-card">
                    <div className="wm-score-label">Agent-Adjusted Score</div>
                    <div className="wm-score amber">52%</div>
                    <div className="wm-score-sub">True Renewal Probability</div>
                  </div>
                </div>

                {/* Watermelon signals */}
                <div className="wm-signals-card">
                  <h3>⚠️ Watermelon Signals Detected</h3>
                  <ul>
                    <li>
                      <span className="wm-flag red">🔴</span>
                      <span><strong>CFO J. Okafor</strong> privately expressed "migration fatigue" in exec dinner. Board evaluating GCP/AWS alternatives for Q4 workloads. Not captured in any system.</span>
                    </li>
                    <li>
                      <span className="wm-flag red">🔴</span>
                      <span><strong>Champion departure:</strong> R. Vance (VP Cloud Platforms) accepted offer at competitor. Official announcement Aug 1. No successor identified.</span>
                    </li>
                    <li>
                      <span className="wm-flag amber">🟡</span>
                      <span><strong>Budget freeze signal:</strong> Helios CFO told field team "no new Azure commitments until board reviews multi-cloud strategy" — logged only in personal notes.</span>
                    </li>
                    <li>
                      <span className="wm-flag amber">🟡</span>
                      <span><strong>Competitor activity:</strong> AWS SA team conducted 3 architecture workshops with Helios infra team in May. Detected via scheduling overlap, not in CRM.</span>
                    </li>
                  </ul>
                </div>

                {/* Timeline */}
                <div className="wm-timeline-section">
                  <h3>📅 Signal Timeline (not in CRM)</h3>
                  <div className="wm-timeline">
                    <div className="wm-timeline-item">
                      <div className="wm-time">May 2 — Private dinner</div>
                      <div className="wm-event">CFO mentions "migration fatigue" to field rep. Captured in personal notes only.</div>
                    </div>
                    <div className="wm-timeline-item">
                      <div className="wm-time">May 14 — Calendar intel</div>
                      <div className="wm-event">AWS SA team books 3 workshops with Helios infra team. No CRM entry.</div>
                    </div>
                    <div className="wm-timeline-item">
                      <div className="wm-time">May 22 — LinkedIn signal</div>
                      <div className="wm-event">R. Vance updates profile: "Open to opportunities." Champion risk indicator.</div>
                    </div>
                    <div className="wm-timeline-item">
                      <div className="wm-time">Jun 3 — Board filing</div>
                      <div className="wm-event">Helios board memo references "multi-cloud diversification mandate for FY27."</div>
                    </div>
                  </div>
                </div>

                <div className="wm-footer">Only our system catches this.</div>
              </div>
            )}
          </div>
        ) : activeTab === 'graph' && graphData ? (
          <div className="graph-container" ref={graphContainerRef}>
            <div className="graph-header">
              <h3>🗺️ Customer Knowledge Graph</h3>
              {graphData.knowledge_graph_ref && (
                <span className="graph-ref">{graphData.knowledge_graph_ref}</span>
              )}
            </div>
            <div className="graph-legend">
              <span className="legend-item"><span className="legend-dot account"></span> Account</span>
              <span className="legend-item"><span className="legend-dot person"></span> Person</span>
              <span className="legend-item"><span className="legend-dot data"></span> Data</span>
              <span className="legend-item"><span className="legend-dot opportunity"></span> Opportunity</span>
              <span className="legend-item"><span className="legend-dot risk"></span> Risk</span>
            </div>
            <div className="graph-canvas">
              <ForceGraph2D
                graphData={{
                  nodes: graphData.nodes.map(n => ({ ...n, name: n.label })),
                  links: graphData.links,
                }}
                nodeLabel={(node: any) => `${node.label}\n${node.details || ''}`}
                nodeColor={(node: any) => {
                  const colors: Record<string, string> = {
                    account: '#6366f1',
                    person: '#22c55e',
                    data: '#3b82f6',
                    opportunity: '#f59e0b',
                    risk: '#ef4444',
                  };
                  return colors[node.group] || '#94a3b8';
                }}
                nodeVal={(node: any) => node.group === 'account' ? 8 : 4}
                linkLabel={(link: any) => link.label || ''}
                linkColor={() => 'rgba(148, 163, 184, 0.4)'}
                linkDirectionalArrowLength={4}
                linkDirectionalArrowRelPos={0.8}
                nodeCanvasObject={(node: any, ctx, globalScale) => {
                  const label = node.label || '';
                  const fontSize = Math.max(10 / globalScale, 3);
                  const size = node.group === 'account' ? 10 : 6;
                  const colors: Record<string, string> = {
                    account: '#6366f1',
                    person: '#22c55e',
                    data: '#3b82f6',
                    opportunity: '#f59e0b',
                    risk: '#ef4444',
                  };
                  const color = colors[node.group] || '#94a3b8';

                  // Draw node circle
                  ctx.beginPath();
                  ctx.arc(node.x, node.y, size, 0, 2 * Math.PI);
                  ctx.fillStyle = color;
                  ctx.fill();
                  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
                  ctx.lineWidth = 1;
                  ctx.stroke();

                  // Draw label
                  ctx.font = `${fontSize}px Inter, sans-serif`;
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'top';
                  ctx.fillStyle = '#e2e8f0';
                  ctx.fillText(label, node.x, node.y + size + 2);
                }}
                width={graphContainerRef.current?.clientWidth || 800}
                height={500}
                backgroundColor="transparent"
              />
            </div>
          </div>
        ) : (
          <>
          {/* Messages or Welcome */}
          {!activeSession || activeSession.messages.length === 0 ? (
          <div className="welcome-screen">
            <div className="welcome-icon">🏢</div>
            <h2>Executive Insights Builder</h2>
            <p>
              Prepare for your next customer meeting with AI-powered research and strategic insights.
              Ask about any customer to get comprehensive briefing materials.
            </p>
            <div className="suggestions">
              <div className="suggestion-card" onClick={() => handleSuggestion('Research Contoso Corp for upcoming CEO meeting next week')}>
                <h4>🔍 Customer Research</h4>
                <p>Deep dive on a customer's business, financials, and recent news</p>
              </div>
              <div className="suggestion-card" onClick={() => handleSuggestion('What are the key talking points for our meeting with Fabrikam?')}>
                <h4>💬 Meeting Prep</h4>
                <p>Generate executive-level talking points and discussion topics</p>
              </div>
              <div className="suggestion-card" onClick={() => handleSuggestion('Identify risks and opportunities in our partnership with Northwind Traders')}>
                <h4>⚡ Risk & Opportunity</h4>
                <p>Analyze partnership risks and growth opportunities</p>
              </div>
              <div className="suggestion-card" onClick={() => handleSuggestion('Create a competitive landscape analysis for the healthcare sector')}>
                <h4>📊 Competitive Intel</h4>
                <p>Understand the competitive dynamics in a sector</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="messages-container">
            {activeSession.messages.map(msg => (
              <div key={msg.id} className={`message ${msg.role}`}>
                <div className="message-avatar">
                  {msg.role === 'user' ? 'You' : 'AI'}
                </div>
                <div className="message-bubble">
                  {msg.agent && (
                    <div className={`message-agent-badge ${msg.agent}`}>
                      {msg.agent === 'context-builder' ? '🔍 Context Builder' : '💡 Insights'}
                    </div>
                  )}
                  {editingId === msg.id ? (
                    <div>
                      <textarea
                        className="edit-textarea"
                        value={editContent}
                        onChange={e => setEditContent(e.target.value)}
                        autoFocus
                      />
                      <div className="edit-actions">
                        <button className="edit-save" onClick={() => handleEdit(msg.id)}>
                          <Check size={12} /> Save
                        </button>
                        <button className="edit-cancel" onClick={() => setEditingId(null)}>
                          <X size={12} /> Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="message-content">
                      <ReactMarkdown
                        components={{
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noopener noreferrer">
                              {children}
                            </a>
                          ),
                        }}
                      >{msg.content}</ReactMarkdown>
                    </div>
                  )}
                  {msg.role === 'assistant' && msg.content && !editingId && (
                    <div className="message-actions">
                      <button
                        className="message-action-btn"
                        onClick={() => { setEditingId(msg.id); setEditContent(msg.content); }}
                      >
                        <Edit3 size={10} /> Edit
                      </button>
                      {msg.is_edited && (
                        <button
                          className="message-action-btn"
                          onClick={() => {
                            setActiveSession(prev => {
                              if (!prev) return null;
                              return {
                                ...prev,
                                messages: prev.messages.map(m =>
                                  m.id === msg.id && m.original_content
                                    ? { ...m, content: m.original_content, is_edited: false }
                                    : m
                                ),
                              };
                            });
                          }}
                        >
                          <RotateCcw size={10} /> Revert
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isStreaming && (
              <div className="streaming-indicator">
                <div className="streaming-dot" />
                <div className="streaming-dot" />
                <div className="streaming-dot" />
                <span>{activeAgent === 'context-builder' ? 'Researching context...' : activeAgent === 'insights' ? 'Generating insights...' : 'Processing...'}</span>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
        </>
        )}

        {/* Input Area */}
        <div className="input-area">
          <div className="input-wrapper">
            <textarea
              ref={textareaRef}
              className="chat-input"
              placeholder="Ask about a customer, meeting, or strategic topic..."
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={isStreaming}
            />
            {isSupported && (
              <button
                className={`input-btn voice ${isListening ? 'listening' : ''}`}
                onClick={isListening ? stopListening : startListening}
                title={isListening ? 'Stop listening' : 'Start voice input'}
              >
                {isListening ? <MicOff size={18} /> : <Mic size={18} />}
              </button>
            )}
            {isStreaming ? (
              <button className="input-btn cancel" onClick={cancelStream} title="Cancel">
                <X size={18} />
              </button>
            ) : (
              <button
                className="input-btn send"
                onClick={handleSend}
                disabled={!input.trim()}
                title="Send message"
              >
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
