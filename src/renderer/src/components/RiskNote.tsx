import { useEffect, useMemo, useState } from 'react'
import { classifyCommand, needsSecondClick, RISK_TITLES, visibleRisks, whatIfPreview, type Risk } from '@shared/risk'
import { useStore } from '../state/store'

/**
 * What running a command typed on the user's behalf would risk, and whether it takes
 * a second click (audit R29; shared/risk.ts). Shared by every card that runs one.
 */
export function useCommandRisk(command: string): {
  risks: Risk[]
  /** Run is pressed twice: the first press arms it, and says so. */
  second: boolean
  armed: boolean
  arm: () => void
  /** The same command with -WhatIf, when that is sure to change nothing. */
  preview: string | null
} {
  const sensitivity = useStore((s) => s.settings.commandRiskLabels ?? 'all')
  const risks = useMemo(() => visibleRisks(classifyCommand(command), sensitivity), [command, sensitivity])
  const second = needsSecondClick(risks, window.ember.isAdmin === true)
  const [armed, setArmed] = useState(false)
  // A different command starts unarmed.
  useEffect(() => setArmed(false), [command])
  const preview = useMemo(() => (risks.length > 0 ? whatIfPreview(command) : null), [command, risks.length])
  return { risks, second, armed, arm: () => setArmed(true), preview }
}

/** The labels themselves: one per kind of risk, each saying why. */
export function RiskNote({ risks, armed }: { risks: Risk[]; armed: boolean }): React.JSX.Element | null {
  if (risks.length === 0) return null
  return (
    <div className="risk" role="note" aria-label="What this command risks">
      {risks.map((r) => (
        <span key={r.class} className={`risk__label risk__label--${r.class}`} title={`This command ${r.why}.`}>
          {RISK_TITLES[r.class]}
          <span className="risk__why"> — {r.why}</span>
        </span>
      ))}
      {armed && <span className="risk__armed">Press again to run it.</span>}
    </div>
  )
}

/** The question for a place with no card to label: a block's Run again. */
export function riskQuestion(command: string): string | null {
  const sensitivity = useStore.getState().settings.commandRiskLabels ?? 'all'
  const risks = visibleRisks(classifyCommand(command), sensitivity)
  if (!needsSecondClick(risks, window.ember.isAdmin === true)) return null
  const said = risks.map((r) => `• ${RISK_TITLES[r.class]}: it ${r.why}`).join('\n')
  const line = command.length > 120 ? `${command.slice(0, 117)}…` : command
  return `Run this again?\n\n  ${line}\n\n${said}`
}
