import type { MultiPublishBridge } from './bridge';

/** Sending content requires a live connector; setup never creates a publishing task. */
export function requireBrowserConnection(
  bridge: MultiPublishBridge,
  openConnector: () => void,
  reconnect = false,
): boolean {
  if (!reconnect && bridge.getConnectionState().connected) return true;
  openConnector();
  return false;
}
