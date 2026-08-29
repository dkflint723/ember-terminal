import { useEffect, useState } from 'react'

/**
 * A verification seam, and nothing else: dispatching `ember:boom` on window
 * makes this component throw on its next render, which is the only honest way
 * to prove the error boundary above it actually catches a render crash. It
 * renders nothing, costs one listener, and cannot fire by accident — no user
 * gesture dispatches the event.
 */
export function Detonator(): null {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    const arm = (): void => setArmed(true)
    window.addEventListener('ember:boom', arm)
    return () => window.removeEventListener('ember:boom', arm)
  }, [])

  if (armed) throw new Error('ember:boom — deliberate render failure for verification')
  return null
}
