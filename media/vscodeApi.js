/**
 * Returns the VS Code webview API when running inside a webview, or a mock
 * when running in a plain browser (the dev/ harness). The mock logs outgoing
 * messages and, if the harness registered `window.__dbxMockResponder`, replays
 * its fixture events back through the normal `window.message` channel — so the
 * webview code runs identically in both environments.
 *
 * Browser ≠ webview: the harness is MORE permissive than a real webview
 * (no strict CSP, dialogs like confirm() work, acquireVsCodeApi can only be
 * called once in-host). Always re-verify risky changes in the Extension
 * Development Host.
 */
export function getVsCodeApi() {
  if (typeof acquireVsCodeApi === 'function') {
    return acquireVsCodeApi();
  }

  const STATE_KEY = 'dbxHarnessState';

  return {
    postMessage(message) {
      console.log(`[harness] → extension: ${JSON.stringify(message)}`);
      const responder = window.__dbxMockResponder;
      if (typeof responder !== 'function') {
        return;
      }

      const events = responder(message) || [];
      for (const event of events) {
        setTimeout(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: { requestId: message.requestId, ...event },
            }),
          );
        }, 0);
      }
    },
    getState() {
      try {
        const raw = sessionStorage.getItem(STATE_KEY);
        return raw ? JSON.parse(raw) : undefined;
      } catch {
        return undefined;
      }
    },
    setState(state) {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
      return state;
    },
  };
}
