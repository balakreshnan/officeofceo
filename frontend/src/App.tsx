import { useState, useEffect, useRef, useCallback } from 'react';
import { Session, SessionSummary, ChatMessage, StreamEvent, TokenUsage } from './types';
import { useStreamingChat } from './hooks/useStreamingChat';
import { useVoiceInput } from './hooks/useVoiceInput';
import ReactMarkdown from 'react-markdown';
import { Send, Mic, MicOff, Plus, MessageSquare, Zap, X, Edit3, Check, RotateCcw, GitBranch } from 'lucide-react';
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
  const [activeTab, setActiveTab] = useState<'chat' | 'graph'>('chat');
  const [graphData, setGraphData] = useState<GraphData | null>(null);
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
            </div>
          </div>
          <div className="token-counter">
            <Zap size={14} />
            Session Tokens: <span className="token-value">{cumulativeTokens.toLocaleString()}</span>
          </div>
        </header>

        {/* Tab Content */}
        {activeTab === 'graph' && graphData ? (
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
