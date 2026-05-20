// Module-scoped accessor for the app's ConvexReactClient.
//
// Most code talks to Convex through React hooks (`useConvex`, `useQuery`),
// but the sync flow in preferences-sync.ts runs inside passkey ceremonies
// — plain async functions outside the React tree. This file exposes the
// single client instance for those callers.
//
// Set once during router setup; read by non-React modules.

import type { ConvexReactClient } from "convex/react";

let client: ConvexReactClient | null = null;

export function setConvexClient(c: ConvexReactClient): void {
  client = c;
}

export function getConvexClient(): ConvexReactClient | null {
  return client;
}
