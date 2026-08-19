import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * The last thing between a render error and a blank window.
 *
 * React unmounts the whole tree when a render throws and nothing catches it, so a
 * single bad component took the terminal, the editors and the panel with it and
 * left an empty black rectangle — with the shells still running underneath,
 * unreachable, and the session file still holding the workspace. There was no way
 * to tell that from the app having hung.
 *
 * It cannot put the tree back: the error happened during render and the state that
 * caused it is still there, so re-rendering the same thing would throw again. What
 * it can do is say so, show what broke, and offer the reload that does rebuild
 * everything from the session — which is exactly what the user would otherwise be
 * doing by hand, without knowing that is what was needed.
 */
export class Boom extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept in the console rather than swallowed: the stack is the only thing that
    // says which component threw, and the message below is deliberately not it.
    console.error('Ember: a component failed to render', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="boom" role="alert">
        <div className="boom__title">Ember stopped drawing.</div>
        <p className="boom__note">
          Something in the interface failed while rendering. Your shells are still
          running and the workspace is still saved — reloading rebuilds the window
          from it.
        </p>
        <pre className="boom__error">{error.message}</pre>
        <button className="btn btn--primary" onClick={() => window.location.reload()}>
          Reload the window
        </button>
      </div>
    )
  }
}
