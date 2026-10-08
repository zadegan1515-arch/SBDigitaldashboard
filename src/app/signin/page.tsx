'use client'

import { signIn } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

// What went wrong, in words (Oct 8 2026: every error used to read "doesn't
// have access", even when Google never finished signing in).
function problem(code: string, email: string | null): string {
  if (code === 'AccessDenied') {
    return email
      ? `Google signed you in as ${email}, and that address isn\u2019t on the list. Ask Leo to add it (Operations \u2192 Team).`
      : 'That account doesn\u2019t have access. Ask Leo to add your email.'
  }
  if (code === 'OAuthCallback' || code === 'OAuthSignin' || code === 'Callback') {
    return 'Google didn\u2019t finish signing you in. Try again. If Google said your organization blocks this app, the sboyagency.com Google admin has to allow it.'
  }
  if (code === 'Unavailable') return 'The dashboard couldn\u2019t check the list just now. Try again in a minute.'
  return `Sign-in didn\u2019t work (${code}). Try again.`
}

function SignInBox() {
  const params = useSearchParams()
  const denied = params.get('error')
  const email = params.get('email')

  return (
    <div style={{
      minHeight: '100vh', display: 'grid', placeItems: 'center',
      background: '#f4f4f2',
      fontFamily: '-apple-system, BlinkMacSystemFont, Inter, Segoe UI, Helvetica, Arial, sans-serif',
      color: '#14140f',
    }}>
      <div style={{
        background: '#fff', border: '1px solid #e7e6e2', borderRadius: 12,
        padding: '34px 38px', width: 360, textAlign: 'center',
        boxShadow: '0 1px 3px rgba(20,20,15,.05)',
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10, background: '#e5533d', color: '#fff',
          display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 14,
          margin: '0 auto 16px',
        }}>SB</div>

        <h1 style={{ fontSize: 19, fontWeight: 600, letterSpacing: '-.02em' }}>
          Command Center
        </h1>
        <p style={{ fontSize: 13.5, color: '#56554e', marginTop: 5 }}>
          Sponsor outreach for SB Agency
        </p>

        {denied && (
          <div style={{
            marginTop: 18, padding: '10px 12px', borderRadius: 8,
            background: '#f6eceb', color: '#8f342f', fontSize: 12.5, lineHeight: 1.5,
          }}>
            {problem(denied, email)}
          </div>
        )}

        <button
          onClick={() => signIn('google', { callbackUrl: '/app.html' })}
          style={{
            marginTop: 22, width: '100%', padding: '10px 16px', borderRadius: 8,
            border: '1px solid #e7e6e2', background: '#fff', cursor: 'pointer',
            fontSize: 14, fontWeight: 600, fontFamily: 'inherit', color: '#14140f',
          }}
        >
          Sign in with Google
        </button>
      </div>
    </div>
  )
}

export default function SignIn() {
  return (
    <Suspense fallback={null}>
      <SignInBox />
    </Suspense>
  )
}
