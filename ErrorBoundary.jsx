import { Component } from 'react'

// Catches a crash anywhere below it and shows a recoverable message
// instead of leaving the screen blank. Without this, any unhandled
// error in a child component unmounts the whole React tree and the
// person sees nothing — no message, nothing to tap, just white.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null, showDetails: false, copied: false }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Caught by ErrorBoundary:', error, info)
    this.setState({ info })
  }

  copyDetails = () => {
    const text = [
      this.state.error?.message || String(this.state.error),
      this.state.error?.stack || '',
      this.state.info?.componentStack || '',
    ].filter(Boolean).join('\n\n')
    navigator.clipboard?.writeText(text).then(() => {
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    })
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-dvh flex flex-col items-center justify-center px-6 text-center gap-4">
          <p className="text-lg font-bold">Something went wrong.</p>
          <p className="text-dim max-w-xs">
            The screen hit an error and couldn't continue. Reloading usually
            fixes it — nothing you entered before this should be lost.
          </p>
          <button onClick={() => window.location.reload()}
            className="h-14 px-6 rounded-2xl bg-amber text-bg font-bold">
            Reload
          </button>
          <button onClick={() => this.setState(s => ({ showDetails: !s.showDetails }))}
            className="text-dim text-sm underline mt-2">
            {this.state.showDetails ? 'Hide details' : 'Show details (for support)'}
          </button>
          {this.state.showDetails && (
            <div className="w-full max-w-sm text-left">
              <pre className="text-xs text-dim bg-surface border border-line rounded-xl p-3 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                {this.state.error?.message || String(this.state.error)}
                {this.state.error?.stack ? '\n\n' + this.state.error.stack : ''}
                {this.state.info?.componentStack ? '\n\n' + this.state.info.componentStack : ''}
              </pre>
              <button onClick={this.copyDetails}
                className="mt-2 w-full h-11 rounded-xl border border-line text-sm font-semibold">
                {this.state.copied ? 'Copied' : 'Copy details to send'}
              </button>
            </div>
          )}
        </div>
      )
    }
    return this.props.children
  }
}
