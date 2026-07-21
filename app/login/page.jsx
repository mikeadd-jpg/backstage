'use client';
import { useState } from 'react';

export default function Login() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) { window.location.href = '/'; }
      else { const d = await res.json().catch(() => ({})); setError(d.error || 'Incorrect password'); }
    } catch { setError('Something went wrong. Try again.'); }
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="wordmark" style={{ marginBottom: 6 }}>Backstage<small>SUPPORT TRIAGE</small></div>
        <p className="login-sub">Enter the team password to continue.</p>
        <input
          className="login-input"
          type="password"
          value={password}
          autoFocus
          placeholder="Password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <div className="login-error">{error}</div>}
        <button className="btn btn-primary login-btn" onClick={submit} disabled={busy}>
          {busy ? 'Checking...' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
