import { useState } from 'react';
import { Users, UserPlus, Link2, X, Check, Crown } from 'lucide-react';
import { Session, Collaborator } from '../types';

interface Props {
  session: Session;
  onChange: (session: Session) => void;
}

export default function CollaborationPanel({ session, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);

  const collaborators = session.collaborators || [];

  async function addCollaborator() {
    if (!name.trim() || !email.trim()) return;
    const res = await fetch(`/api/sessions/${session.id}/collaborators`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), email: email.trim(), role: 'editor' }),
    });
    if (res.ok) {
      const collab: Collaborator = await res.json();
      const exists = collaborators.some(c => c.id === collab.id);
      onChange({
        ...session,
        collaborators: exists ? collaborators : [...collaborators, collab],
      });
      setName('');
      setEmail('');
    }
  }

  async function removeCollaborator(id: string) {
    const res = await fetch(`/api/sessions/${session.id}/collaborators/${id}`, { method: 'DELETE' });
    if (res.ok) {
      onChange({
        ...session,
        collaborators: collaborators.filter(c => c.id !== id),
        assignee: session.assignee === id ? null : session.assignee,
      });
    }
  }

  async function assign(collaboratorId: string | null) {
    const res = await fetch(`/api/sessions/${session.id}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collaborator_id: collaboratorId }),
    });
    if (res.ok) {
      onChange({ ...session, assignee: collaboratorId });
    }
  }

  function copyShareLink() {
    const url = `${window.location.origin}${window.location.pathname}?session=${session.id}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => { /* no-op */ });
  }

  return (
    <div className="collab-wrap">
      <button className="collab-trigger" onClick={() => setOpen(o => !o)} title="Collaborators">
        <Users size={14} />
        <span>{collaborators.length}</span>
        {collaborators.slice(0, 3).map(c => (
          <span key={c.id} className="collab-avatar" title={c.name}>
            {c.name.charAt(0).toUpperCase()}
          </span>
        ))}
      </button>

      {open && (
        <>
          <div className="collab-backdrop" onClick={() => setOpen(false)} />
          <div className="collab-popover">
            <div className="collab-pop-header">
              <h4>Collaborators</h4>
              <button className="collab-close" onClick={() => setOpen(false)}><X size={14} /></button>
            </div>

            <div className="collab-list">
              {collaborators.length === 0 ? (
                <div className="collab-empty">No collaborators yet. Invite someone below.</div>
              ) : collaborators.map(c => (
                <div className="collab-item" key={c.id}>
                  <div className="collab-item-avatar">{c.name.charAt(0).toUpperCase()}</div>
                  <div className="collab-item-info">
                    <div className="collab-item-name">
                      {c.name}
                      {session.assignee === c.id && <span className="collab-owner-badge"><Crown size={10} /> Assigned</span>}
                    </div>
                    <div className="collab-item-email">{c.email}</div>
                  </div>
                  <div className="collab-item-actions">
                    <button
                      className={`collab-assign-btn ${session.assignee === c.id ? 'active' : ''}`}
                      onClick={() => assign(session.assignee === c.id ? null : c.id)}
                      title={session.assignee === c.id ? 'Unassign' : 'Assign owner'}
                    >
                      {session.assignee === c.id ? <Check size={12} /> : <Crown size={12} />}
                    </button>
                    <button className="collab-remove-btn" onClick={() => removeCollaborator(c.id)} title="Remove">
                      <X size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="collab-invite">
              <div className="collab-invite-title"><UserPlus size={12} /> Invite</div>
              <input
                className="collab-input"
                placeholder="Name"
                value={name}
                onChange={e => setName(e.target.value)}
              />
              <input
                className="collab-input"
                placeholder="Email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addCollaborator(); }}
              />
              <button className="collab-invite-btn" onClick={addCollaborator} disabled={!name.trim() || !email.trim()}>
                Add collaborator
              </button>
            </div>

            <button className="collab-share-btn" onClick={copyShareLink}>
              <Link2 size={13} /> {copied ? 'Link copied!' : 'Copy share link'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
