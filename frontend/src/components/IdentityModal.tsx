import { useState } from 'react';
import { User } from 'lucide-react';

interface Props {
  onSubmit: (name: string) => void;
}

export default function IdentityModal({ onSubmit }: Props) {
  const [name, setName] = useState('');

  function submit() {
    if (name.trim()) onSubmit(name.trim());
  }

  return (
    <div className="identity-overlay">
      <div className="identity-modal">
        <div className="identity-icon"><User size={28} /></div>
        <h2>Welcome to the Office of CEO</h2>
        <p>Enter your name so collaborators can see who's editing the briefing.</p>
        <input
          className="identity-input"
          placeholder="Your name (e.g. Jordan Lee)"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
          autoFocus
        />
        <button className="identity-btn" onClick={submit} disabled={!name.trim()}>
          Continue
        </button>
      </div>
    </div>
  );
}
