import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ChevronRight, Edit3, Check, X, RotateCcw, BookOpen, Volume2, Loader2, Square } from 'lucide-react';
import { ChatMessage } from '../types';

interface Props {
  msg: ChatMessage;
  editingId: string | null;
  editContent: string;
  setEditContent: (v: string) => void;
  onStartEdit: (msg: ChatMessage) => void;
  onSaveEdit: (id: string) => void;
  onCancelEdit: () => void;
  onRevert: (id: string) => void;
  onSpeak: (text: string, id: string) => void;
  speakingId: string | null;
  loadingId: string | null;
}

const AGENT_META: Record<string, { label: string; icon: string; cls: string }> = {
  'context-builder': { label: 'Context Builder', icon: '🔍', cls: 'context-builder' },
  'customer-data': { label: 'Customer Data', icon: '📊', cls: 'customer-data' },
  'insights': { label: 'Insights', icon: '💡', cls: 'insights' },
};

/** Strip markdown syntax to readable plain text for speech synthesis. */
function toPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_>#|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a message body from its trailing "Sources" section. */
function splitSources(content: string): { body: string; sources: string[] } {
  const re = /\n*(?:---\s*\n)?#{1,4}\s*📚\s*(?:Data\s+)?Sources\s*\n/i;
  const m = content.match(re);
  if (!m || m.index === undefined) return { body: content, sources: [] };
  const body = content.slice(0, m.index).replace(/\n*---\s*$/, '').trim();
  const tail = content.slice(m.index + m[0].length);
  const sources = tail
    .split('\n')
    .map(l => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
  return { body, sources };
}

export default function ChatMessageCard({
  msg, editingId, editContent, setEditContent, onStartEdit, onSaveEdit, onCancelEdit, onRevert,
  onSpeak, speakingId, loadingId,
}: Props) {
  const isAssistant = msg.role === 'assistant';
  const meta = msg.agent ? AGENT_META[msg.agent] : undefined;
  // Insights expanded by default; intermediate agents collapsed.
  const [open, setOpen] = useState(msg.agent ? msg.agent === 'insights' : true);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  // Plain user messages keep the simple bubble.
  if (!isAssistant) {
    return (
      <div className={`message ${msg.role}`}>
        <div className="message-avatar">You</div>
        <div className="message-bubble">
          <div className="message-content">
            <ReactMarkdown>{msg.content}</ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  const editing = editingId === msg.id;
  const { body, sources } = splitSources(msg.content);

  return (
    <div className="message assistant">
      <div className="message-avatar">AI</div>
      <div className="message-bubble agent-card">
        <div className="agent-card-header" onClick={() => !editing && setOpen(o => !o)}>
          <span className="agent-card-toggle">
            {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </span>
          <span className={`message-agent-badge ${meta?.cls || ''}`}>
            {meta ? `${meta.icon} ${meta.label}` : '🤖 Assistant'}
          </span>
          {!open && body && <span className="agent-card-peek">{body.replace(/[#*`>-]/g, '').slice(0, 70).trim()}…</span>}
          {sources.length > 0 && <span className="agent-card-srccount"><BookOpen size={11} /> {sources.length}</span>}
          {body && (
            <button
              className={`agent-card-speak ${speakingId === msg.id ? 'active' : ''}`}
              title={speakingId === msg.id ? 'Stop reading' : 'Read aloud'}
              onClick={(e) => { e.stopPropagation(); onSpeak(toPlainText(body), msg.id); }}
            >
              {loadingId === msg.id ? <Loader2 size={13} className="spin" />
                : speakingId === msg.id ? <Square size={13} />
                : <Volume2 size={13} />}
            </button>
          )}
        </div>

        {open && (
          <div className="agent-card-body">
            {editing ? (
              <div>
                <textarea
                  className="edit-textarea"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  autoFocus
                />
                <div className="edit-actions">
                  <button className="edit-save" onClick={() => onSaveEdit(msg.id)}><Check size={12} /> Save</button>
                  <button className="edit-cancel" onClick={onCancelEdit}><X size={12} /> Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="message-content">
                  <ReactMarkdown
                    components={{
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                      ),
                    }}
                  >{body}</ReactMarkdown>
                </div>

                {sources.length > 0 && (
                  <div className="agent-sources">
                    <div className="agent-sources-header" onClick={() => setSourcesOpen(s => !s)}>
                      {sourcesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      <BookOpen size={13} /> Sources ({sources.length})
                    </div>
                    {sourcesOpen && (
                      <ul className="agent-sources-list">
                        {sources.map((s, i) => (
                          <li key={i}><ReactMarkdown components={{
                            a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
                            p: ({ children }) => <>{children}</>,
                          }}>{s}</ReactMarkdown></li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {msg.content && (
                  <div className="message-actions">
                    <button className="message-action-btn" onClick={() => onStartEdit(msg)}>
                      <Edit3 size={10} /> Edit
                    </button>
                    {msg.is_edited && (
                      <button className="message-action-btn" onClick={() => onRevert(msg.id)}>
                        <RotateCcw size={10} /> Revert
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
