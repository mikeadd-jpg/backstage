'use client';
import { useEffect, useState } from 'react';

// Sign-in is Google only. There is no password to get wrong, so the only thing this
// screen has to handle well is explaining why someone was turned away.
export default function Login() {
  const [error, setError] = useState('');
  const [next, setNext] = useState('/');

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get('error')) setError(sp.get('error'));
    if (sp.get('next')) setNext(sp.get('next'));
  }, []);

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="wordmark" style={{ marginBottom: 6 }}>Backstage</div>
        <p className="login-sub">Sign in with your Google account to continue.</p>

        <a className="btn btn-primary login-btn google-btn"
           href={'/api/auth/google/start?next=' + encodeURIComponent(next)}>
          <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.7-.4-3.9H24v7.1h12.1c-.2 1.8-1.6 4.6-4.5 6.4l6.9 5.4c4.1-3.8 6.6-9.4 6.6-15z"/>
            <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7.1 5.5C8.1 41.1 15.5 46 24 46z"/>
            <path fill="#FBBC05" d="M11.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4l-7.1-5.5C2.9 17 2 20.4 2 24s.9 7 2.4 9.9l7.1-5.5z"/>
            <path fill="#EA4335" d="M24 10.5c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.4 29.9 2 24 2 15.5 2 8.1 6.9 4.4 14.1l7.1 5.5c1.8-5.3 6.7-9.1 12.5-9.1z"/>
          </svg>
          Sign in with Google
        </a>

        {error && <div className="login-error" style={{ marginTop: 12 }}>{error}</div>}
        <p className="login-sub" style={{ marginTop: 16, marginBottom: 0, fontSize: 12 }}>
          Access is by invitation. If your account is not on the list, ask an admin to add you.
        </p>
      </div>
    </div>
  );
}
