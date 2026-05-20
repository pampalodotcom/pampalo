// Typed errors thrown by the auth and sync flows. Extracted from
// auth-flow.ts so other modules (preferences-sync.ts in particular) can
// throw them without creating a circular import.

export class PrfNotSupportedError extends Error {
  readonly kind = "prf-not-supported" as const;
  constructor() {
    super(
      "Your passkey provider doesn’t support the encryption extension Pampalo needs.",
    );
    this.name = "PrfNotSupportedError";
  }
}

export class UnknownCredentialError extends Error {
  readonly kind = "unknown-credential" as const;
  constructor() {
    super(
      "The passkey you picked isn’t registered with Pampalo on this account.",
    );
    this.name = "UnknownCredentialError";
  }
}
