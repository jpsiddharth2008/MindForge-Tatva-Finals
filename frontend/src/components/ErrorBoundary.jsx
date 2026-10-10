import React from 'react';

/**
 * An unexpected error while rendering must never leave a blank white page. This shows a recovery screen instead.
 * It deliberately shows nothing from the error itself (messages and stacks can reveal internals); the details go to the console.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // the message and the component that failed: enough to debug, without dumping a whole stack into the console
    console.error('Interface error:', error?.message, info?.componentStack?.split('\n').find((l) => l.trim()));
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="min-h-screen bg-canvas flex items-center justify-center p-4 font-sans">
        <div className="bg-white sheet p-8 max-w-md text-center">
          <h1 className="mb-2 text-xl font-bold text-ink">Something went wrong</h1>
          <p className="text-ink-soft mb-6">
            The page hit an unexpected problem. Nothing you submitted was lost or changed by this. You can try again, or go back to the start.
          </p>
          <div className="flex gap-3 justify-center">
            <button onClick={this.reset} className="bg-ink text-white px-4 py-2 rounded-lg font-semibold hover:bg-black">Try again</button>
            <button onClick={() => window.location.assign('/')} className="btn-secondary px-4 py-2 rounded-lg font-semibold hover:bg-white">Go to the home page</button>
          </div>
        </div>
      </div>
    );
  }
}
