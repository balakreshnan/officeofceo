import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Bold, Heading1, Heading2, List, ListOrdered, Quote, Save,
  Download, FileText, Sparkles, ClipboardList, Loader2, CheckCircle2,
  AlertCircle, TrendingUp, Eye, Pencil, Wand2, X, RefreshCw,
  ChevronDown, ChevronRight, BarChart3,
} from 'lucide-react';
import { Session, DraftEvaluation } from '../types';
import ChatCharts from './ChatCharts';

interface Props {
  session: Session;
  userName: string;
  scorecard?: any;
  onChange: (session: Session) => void;
}

type ViewMode = 'split' | 'edit' | 'preview';

export default function DocumentTab({ session, userName, scorecard, onChange }: Props) {
  const [content, setContent] = useState(session.draft?.content || '');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(session.draft?.updated_at || null);
  const [view, setView] = useState<ViewMode>('split');
  const [evaluating, setEvaluating] = useState(false);
  const [evaluation, setEvaluation] = useState<DraftEvaluation | null>(session.evaluation || null);
  const [evalCollapsed, setEvalCollapsed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<number | null>(null);

  // Rephrase (AI) state
  const [selRange, setSelRange] = useState<{ start: number; end: number; text: string } | null>(null);
  const [rephraseOpen, setRephraseOpen] = useState(false);
  const [rephraseLoading, setRephraseLoading] = useState(false);
  const [rephraseResult, setRephraseResult] = useState('');
  const [rephraseInstruction, setRephraseInstruction] = useState('');
  const [rephraseTokens, setRephraseTokens] = useState<number | null>(null);

  // Sync when switching sessions
  useEffect(() => {
    setContent(session.draft?.content || '');
    setEvaluation(session.evaluation || null);
    setSavedAt(session.draft?.updated_at || null);
    setDirty(false);
  }, [session.id]);

  const persist = useCallback(async (text: string) => {
    setSaving(true);
    try {
      const res = await fetch(`/api/sessions/${session.id}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, user_name: userName }),
      });
      if (res.ok) {
        const draft = await res.json();
        setSavedAt(draft.updated_at);
        setDirty(false);
        onChange({ ...session, draft });
      }
    } catch { /* no-op */ }
    setSaving(false);
  }, [session, userName, onChange]);

  // Debounced autosave
  useEffect(() => {
    if (!dirty) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => persist(content), 1200);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [content, dirty, persist]);

  function update(text: string) {
    setContent(text);
    setDirty(true);
  }

  function insertMarkdown(before: string, after = '', placeholder = '') {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = content.slice(start, end) || placeholder;
    const next = content.slice(0, start) + before + selected + after + content.slice(end);
    update(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + before.length + selected.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  function trackSelection() {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (end > start) {
      setSelRange({ start, end, text: content.slice(start, end) });
    } else {
      setSelRange(null);
    }
  }

  async function runRephrase(instruction = rephraseInstruction) {
    if (!selRange) return;
    setRephraseLoading(true);
    setRephraseResult('');
    setRephraseTokens(null);
    try {
      const res = await fetch('/api/rephrase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: selRange.text, instruction }),
      });
      if (res.ok) {
        const data = await res.json();
        setRephraseResult(data.text || '');
        setRephraseTokens(data.usage?.total_tokens ?? null);
      }
    } catch { /* no-op */ }
    setRephraseLoading(false);
  }

  function openRephrase() {
    if (!selRange) return;
    setRephraseInstruction('');
    setRephraseResult('');
    setRephraseTokens(null);
    setRephraseOpen(true);
    runRephrase('');
  }

  function acceptRephrase() {
    if (!selRange || !rephraseResult) return;
    const next = content.slice(0, selRange.start) + rephraseResult + content.slice(selRange.end);
    update(next);
    setRephraseOpen(false);
    setSelRange(null);
  }

  function scorecardToMarkdown(sc: any): string {
    if (!sc) return '';
    const fmtMoney = (v: any) => {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
      if (isNaN(n) || n === 0) return null;
      return n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n}`;
    };
    const has = (v: any) => v !== null && v !== undefined && v !== '' && v !== 0 && String(v).toLowerCase() !== 'n/a';
    const rows: [string, string][] = [];
    if (has(sc.health_score)) rows.push(['Account Health', `${sc.health_score} / 100${sc.health_status ? ` (${sc.health_status})` : ''}`]);
    const rev = fmtMoney(sc.revenue);
    if (rev) rows.push(['Revenue (YTD)', `${rev}${has(sc.revenue_growth) ? ` (${sc.revenue_growth})` : ''}`]);
    if (has(sc.margin)) rows.push(['Margin', String(sc.margin)]);
    const pipe = fmtMoney(sc.pipeline_value);
    if (pipe) rows.push(['Open Pipeline', `${pipe}${has(sc.deal_count) ? ` (${sc.deal_count} deals)` : ''}`]);
    if (has(sc.csat)) rows.push(['CSAT', `${sc.csat}${has(sc.csat_prior) ? ` (prior ${sc.csat_prior})` : ''}`]);
    if (has(sc.nps)) rows.push(['NPS', String(sc.nps)]);
    if (has(sc.qoq_growth)) rows.push(['QoQ Consumption Growth', String(sc.qoq_growth)]);
    if (has(sc.active_seats)) rows.push(['Active Seats', String(sc.active_seats)]);
    if (has(sc.open_p1)) rows.push(['Open P1 Incidents', String(sc.open_p1)]);
    if (has(sc.renewal_status)) rows.push(['Renewal Status', String(sc.renewal_status)]);
    if (rows.length === 0) return '';
    const title = sc.account_name && sc.account_name !== 'Unknown Account' ? ` — ${sc.account_name}` : '';
    let md = `## 📊 Account Scorecard${title}\n\n| Metric | Value |\n| --- | --- |\n`;
    for (const [k, v] of rows) md += `| ${k} | ${v} |\n`;
    return md;
  }

  function pullVisuals() {
    const md = scorecardToMarkdown(scorecard);
    if (!md) return;
    const merged = content.trim() ? `${content.trim()}\n\n${md}` : md;
    update(merged);
  }

  function pullInsightsAndVisuals() {
    const insightMsgs = session.messages.filter(
      m => m.role === 'assistant' && m.agent === 'insights' && m.content.trim()
    );
    const source = insightMsgs.length > 0
      ? insightMsgs
      : session.messages.filter(m => m.role === 'assistant' && m.content.trim());
    const latest = source.length > 0 ? source[source.length - 1].content : '';
    const visuals = scorecardToMarkdown(scorecard);
    if (!latest && !visuals) return;
    const heading = `# ${session.title || 'Executive Briefing'}\n\n`;
    const blocks = [latest, visuals].filter(Boolean).join('\n\n');
    const merged = content.trim()
      ? `${content.trim()}\n\n---\n\n${blocks}`
      : heading + blocks;
    update(merged);
  }

  function downloadMarkdown() {
    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(session.title || 'briefing').replace(/[^\w\- ]/g, '').trim().replace(/\s+/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function downloadWord() {
    if (dirty) await persist(content);
    const res = await fetch(`/api/sessions/${session.id}/draft/export/docx`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(session.title || 'briefing').replace(/[^\w\- ]/g, '').trim().replace(/\s+/g, '_')}.docx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function runEvaluation() {
    if (!content.trim()) return;
    if (dirty) await persist(content);
    setEvaluating(true);
    try {
      const res = await fetch(`/api/sessions/${session.id}/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        const evalResult: DraftEvaluation = await res.json();
        setEvaluation(evalResult);
        setEvalCollapsed(false);
        onChange({ ...session, evaluation: evalResult });
      }
    } catch { /* no-op */ }
    setEvaluating(false);
  }

  const scoreColor = (pct: number) => pct >= 75 ? 'green' : pct >= 50 ? 'amber' : 'red';
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;

  return (
    <div className="doc-container">
      {/* Toolbar */}
      <div className="doc-toolbar">
        <div className="doc-toolbar-group">
          <button className="doc-tool-btn" onClick={() => insertMarkdown('**', '**', 'bold')} title="Bold"><Bold size={15} /></button>
          <button className="doc-tool-btn" onClick={() => insertMarkdown('# ', '', 'Heading')} title="Heading 1"><Heading1 size={15} /></button>
          <button className="doc-tool-btn" onClick={() => insertMarkdown('## ', '', 'Subheading')} title="Heading 2"><Heading2 size={15} /></button>
          <button className="doc-tool-btn" onClick={() => insertMarkdown('- ', '', 'item')} title="Bullet list"><List size={15} /></button>
          <button className="doc-tool-btn" onClick={() => insertMarkdown('1. ', '', 'item')} title="Numbered list"><ListOrdered size={15} /></button>
          <button className="doc-tool-btn" onClick={() => insertMarkdown('> ', '', 'quote')} title="Quote"><Quote size={15} /></button>
        </div>

        <div className="doc-toolbar-group">
          <div className="doc-view-toggle">
            <button className={`doc-view-btn ${view === 'edit' ? 'active' : ''}`} onClick={() => setView('edit')} title="Editor only"><Pencil size={13} /></button>
            <button className={`doc-view-btn ${view === 'split' ? 'active' : ''}`} onClick={() => setView('split')} title="Split view"><FileText size={13} /></button>
            <button className={`doc-view-btn ${view === 'preview' ? 'active' : ''}`} onClick={() => setView('preview')} title="Preview only"><Eye size={13} /></button>
          </div>
        </div>

        <div className="doc-toolbar-group doc-toolbar-actions">
          <button className="doc-action-btn primary" onClick={pullInsightsAndVisuals} title="Pull the latest insights and scorecard visuals into the draft">
            <Sparkles size={14} /> Pull insights + visuals
          </button>
          <button className="doc-action-btn" onClick={pullVisuals} disabled={!scorecard} title="Pull only the scorecard metrics table into the draft">
            <BarChart3 size={14} /> Pull visuals
          </button>
          <button className="doc-action-btn" onClick={downloadMarkdown} title="Export as Markdown">
            <Download size={14} /> Markdown
          </button>
          <button className="doc-action-btn" onClick={downloadWord} title="Export as Word document">
            <FileText size={14} /> Word
          </button>
          <button className="doc-action-btn eval" onClick={runEvaluation} disabled={evaluating || !content.trim()} title="Score the draft against the executive rubric">
            {evaluating ? <Loader2 size={14} className="spin" /> : <ClipboardList size={14} />} Evaluate
          </button>
        </div>
      </div>

      {/* Status row */}
      <div className="doc-status-row">
        <span>{wordCount} words</span>
        <span className="doc-status-sep">•</span>
        <span>
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : savedAt ? `Saved ${new Date(savedAt).toLocaleTimeString()}` : 'Not saved yet'}
          {!saving && !dirty && savedAt && <CheckCircle2 size={12} style={{ marginLeft: 4, verticalAlign: 'middle', color: 'var(--accent-green, #22c55e)' }} />}
        </span>
        {session.draft?.updated_by && (
          <>
            <span className="doc-status-sep">•</span>
            <span>Last edited by {session.draft.updated_by}</span>
          </>
        )}
        <button className="doc-save-now" onClick={() => persist(content)} disabled={!dirty || saving}>
          <Save size={12} /> Save now
        </button>
      </div>

      {/* Visual insights from chat */}
      {scorecard && (
        <div className="doc-visuals-panel">
          <ChatCharts scorecard={scorecard} />
        </div>
      )}

      {/* Editor + Preview */}
      <div className={`doc-workspace view-${view}`}>
        {view !== 'preview' && (
          <div className="doc-editor-pane">
            <textarea
              ref={textareaRef}
              className="doc-editor"
              value={content}
              onChange={e => update(e.target.value)}
              onSelect={trackSelection}
              onMouseUp={trackSelection}
              onKeyUp={trackSelection}
              placeholder="Start writing your executive briefing, or click 'Pull from insights' to import the latest agent output…"
              spellCheck
            />
            {selRange && !rephraseOpen && (
              <button className="doc-rephrase-fab" onClick={openRephrase} title="Rephrase selection with AI">
                <Pencil size={16} />
                <span>Rephrase</span>
              </button>
            )}
          </div>
        )}
        {view !== 'edit' && (
          <div className="doc-preview-pane">
            {content.trim() ? (
              <div className="doc-preview markdown-body">
                <ReactMarkdown
                  components={{
                    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
                  }}
                >{content}</ReactMarkdown>
              </div>
            ) : (
              <div className="doc-preview-empty">Preview will appear here.</div>
            )}
          </div>
        )}
      </div>

      {/* Rubric evaluation */}
      {evaluation && (
        <div className="rubric-panel">
          <div className="rubric-header rubric-header-toggle" onClick={() => setEvalCollapsed(c => !c)}>
            <div className="rubric-title">
              {evalCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
              <ClipboardList size={16} /> Draft Quality Evaluation
            </div>
            <div className={`rubric-overall ${scoreColor(evaluation.overall_score)}`}>
              <div className="rubric-overall-score">{Math.round(evaluation.overall_score)}</div>
              <div className="rubric-overall-label">/ 100</div>
            </div>
          </div>

          {!evalCollapsed && <>
          {evaluation.summary && <p className="rubric-summary">{evaluation.summary}</p>}

          <div className="rubric-criteria">
            {evaluation.criteria.map((c, i) => {
              const pct = (c.score / (c.max_score || 5)) * 100;
              return (
                <div className="rubric-criterion" key={i}>
                  <div className="rubric-criterion-head">
                    <span className="rubric-criterion-name">{c.name}</span>
                    <span className={`rubric-criterion-score ${scoreColor(pct)}`}>{c.score} / {c.max_score || 5}</span>
                  </div>
                  <div className="rubric-bar">
                    <div className={`rubric-bar-fill ${scoreColor(pct)}`} style={{ width: `${pct}%` }} />
                  </div>
                  {c.rationale && <div className="rubric-rationale">{c.rationale}</div>}
                </div>
              );
            })}
          </div>

          <div className="rubric-feedback">
            {evaluation.strengths.length > 0 && (
              <div className="rubric-feedback-col">
                <div className="rubric-feedback-title green"><CheckCircle2 size={14} /> Strengths</div>
                <ul>{evaluation.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
            {evaluation.improvements.length > 0 && (
              <div className="rubric-feedback-col">
                <div className="rubric-feedback-title amber"><TrendingUp size={14} /> Improvements</div>
                <ul>{evaluation.improvements.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
          </div>
          </>}
        </div>
      )}

      {!evaluation && content.trim() && (
        <div className="rubric-hint">
          <AlertCircle size={14} /> Click <strong>Evaluate</strong> to score this draft against the executive briefing rubric.
        </div>
      )}

      {rephraseOpen && (
        <div className="rephrase-overlay" onClick={() => setRephraseOpen(false)}>
          <div className="rephrase-modal" onClick={e => e.stopPropagation()}>
            <div className="rephrase-head">
              <div className="rephrase-title"><Wand2 size={16} /> AI Rephrase <span className="rephrase-model">gpt-5.4-mini</span></div>
              <button className="rephrase-close" onClick={() => setRephraseOpen(false)}><X size={16} /></button>
            </div>

            <div className="rephrase-section">
              <div className="rephrase-label">Original</div>
              <div className="rephrase-original">{selRange?.text}</div>
            </div>

            <div className="rephrase-section">
              <div className="rephrase-label">Suggestion</div>
              {rephraseLoading ? (
                <div className="rephrase-loading"><Loader2 size={16} className="spin" /> Rephrasing…</div>
              ) : (
                <textarea
                  className="rephrase-result"
                  value={rephraseResult}
                  onChange={e => setRephraseResult(e.target.value)}
                  rows={4}
                />
              )}
              {rephraseTokens !== null && !rephraseLoading && (
                <div className="rephrase-tokens">{rephraseTokens} tokens used</div>
              )}
            </div>

            <div className="rephrase-instruction-row">
              <input
                className="rephrase-instruction"
                placeholder="Optional: e.g. 'make it more concise' or 'more formal tone'"
                value={rephraseInstruction}
                onChange={e => setRephraseInstruction(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runRephrase(); }}
              />
              <button className="rephrase-regen" onClick={() => runRephrase()} disabled={rephraseLoading}>
                <RefreshCw size={14} /> Regenerate
              </button>
            </div>

            <div className="rephrase-actions">
              <button className="rephrase-cancel" onClick={() => setRephraseOpen(false)}>Cancel</button>
              <button className="rephrase-accept" onClick={acceptRephrase} disabled={rephraseLoading || !rephraseResult.trim()}>
                <CheckCircle2 size={14} /> Replace selection
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
