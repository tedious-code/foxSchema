import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches render-time exceptions so one bad panel can't blank the whole app. */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('UI render error:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-3 bg-slate-950">
          <AlertTriangle className="w-10 h-10 text-rose-400" />
          <h2 className="text-sm font-bold text-slate-200">Something went wrong rendering this view</h2>
          <pre className="max-w-2xl text-xs text-rose-300 font-mono whitespace-pre-wrap break-words bg-rose-950/20 border border-rose-500/20 rounded-lg p-4">
            {this.state.error.message}
          </pre>
          <button data-testid="app-error-boundary-dismiss"
            onClick={() => this.setState({ error: null })}
            className="mt-2 px-4 py-2 text-xs font-semibold text-slate-200 border border-slate-700 hover:border-slate-500 rounded-md transition"
          >
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
