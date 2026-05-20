// Dev convenience route — wipe all client-side state that flags "this
// browser has registered before" so the next visit to / lands in the
// fresh "Get started" flow. Clears:
//   - the HttpOnly session cookie (via POST /auth/signout)
//   - the non-HttpOnly wallet_known_device cookie (via document.cookie)
//   - any pampalo:* localStorage keys (the cached addresses signal)
//   - the in-memory keystore
//
// Safe to expose in any environment — it only nukes the caller's own
// state and is functionally equivalent to a hard sign-out + cache clear.

import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check, Loader2 } from 'lucide-react'
import { PrimaryButton } from '@/components/pampalo/PrimaryButton'
import { signOut } from '@/lib/auth-flow'
import { clearAll } from '@/lib/keystore'
import { wipePrefsCompletely } from '@/lib/preferences'

export const Route = createFileRoute('/clear')({ component: Clear })

type Status = 'working' | 'done' | 'error'

function Clear() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<Status>('working')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        // 1. Server-side signout — invalidates the session row and clears
        //    the HttpOnly pampalo_session cookie via Set-Cookie Max-Age=0.
        //    Best-effort: if there's no session this throws and that's
        //    fine, we still want to nuke local state.
        try {
          await signOut()
        } catch {
          /* no session / network error — keep going */
        }

        // 2. Client-cookie: wipe the known-device flag. The attributes
        //    must match the original Set-Cookie so the browser matches
        //    and removes it (Path/SameSite/Secure).
        document.cookie =
          'wallet_known_device=; Path=/; Max-Age=0; SameSite=Lax; Secure'

        // 3. localStorage — pampalo:addresses is the device-known
        //    fallback signal; sweep the whole pampalo: prefix in case
        //    we add more keys later.
        try {
          const keys = Object.keys(localStorage).filter((k) =>
            k.startsWith('pampalo:'),
          )
          for (const k of keys) localStorage.removeItem(k)
        } catch {
          /* private mode etc — ignore */
        }

        // 4. In-memory keystore.
        clearAll()

        // 5. IDB preferences record. signOut() above only clears the
        //    in-memory cache so cross-sign-in prefs persist; /clear is
        //    the explicit "nuke everything" path so we wipe IDB too.
        await wipePrefsCompletely()

        setStatus('done')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong.')
        setStatus('error')
      }
    })()
  }, [])

  return (
    <main className="phone-shell flex min-h-dvh flex-col">
      <div className="phone-column flex flex-1 flex-col justify-center">
        <section className="mx-4 rounded-3xl card-cream px-5 pt-6 pb-5">
          <p className="eyebrow mb-3">Dev · Reset</p>
          <h1 className="font-serif text-[26px] font-bold leading-tight text-ink mb-3">
            Clear local state
          </h1>
          <p className="mb-5 text-[14px] leading-relaxed text-ink-soft">
            Wipes your session cookie, the “known device” cookie, the cached
            wallet addresses in this browser, and any in-memory keys. Useful
            for testing the registration flow over and over.
          </p>

          <div className="mb-5 rounded-2xl bg-paper-lo border border-line px-3.5 py-3 text-[13px] leading-relaxed text-ink-soft">
            {status === 'working' && (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Clearing…
              </span>
            )}
            {status === 'done' && (
              <span className="inline-flex items-center gap-2 text-ink">
                <Check className="size-4" />
                Cleared. The next visit to / will be a fresh registration.
              </span>
            )}
            {status === 'error' && (
              <span className="text-destructive">
                {error ?? 'Something went wrong.'}
              </span>
            )}
          </div>

          <PrimaryButton
            disabled={status === 'working'}
            onClick={() => void navigate({ to: '/' })}
          >
            Back to home
          </PrimaryButton>
        </section>
      </div>
    </main>
  )
}
