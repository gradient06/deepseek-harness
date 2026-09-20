/**
 * Web application entry: thin bootstrap over the shell library. Everything —
 * module-table seeding, the boot page, and the UI-renderer handoff — lives
 * in @deepseek-ai/dsh-client-web; this file only finds the mount point and,
 * on an authenticated session, exposes a logout affordance.
 */
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')

/**
 * Mount the logout affordance at the shell edge. The server serves this shell
 * only to an authenticated session (unauthenticated `/` redirects to `/login`),
 * so the button clears the session cookie and returns to the login entry.
 * Deliberately framework-free: the app chrome is slot-composed by client
 * plugins, and this first increment keeps the affordance outside that work.
 */
function mountLogoutAffordance(): void {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Déconnexion'
  // Position a small pill at the top-right corner, clear of the center column.
  Object.assign(button.style, {
    position: 'fixed',
    top: '12px',
    right: '12px',
    zIndex: '2147483000',
    padding: '6px 12px',
    fontSize: '12px',
    lineHeight: '1',
    borderRadius: '999px',
    border: '1px solid rgba(127, 127, 127, 0.35)',
    background: 'rgba(255, 255, 255, 0.92)',
    color: '#333333',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>)
  button.addEventListener('click', async () => {
    button.disabled = true
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } finally {
      window.location.replace('/login')
    }
  })
  document.body.appendChild(button)
}

mountLogoutAffordance()
void new AppWebEntry(el).run()
