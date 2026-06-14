/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import {
  BUNDLED_TRANSFER_EXTERNAL_VK_HASH,
  isRetiredDeploymentWithdrawable,
} from "./retired-vk";

// ADR 0022 — a retired deployment is withdrawable iff its archived
// transfer_external vk matches the circuit this build bundles. Anything else
// (mismatch from a circuit-breaking redeploy, or missing because it was
// archived before ADR 0022) must fall back to read-only.

describe("isRetiredDeploymentWithdrawable", () => {
  test("matching vk → withdrawable", () => {
    expect(
      isRetiredDeploymentWithdrawable({
        circuitVkHash: BUNDLED_TRANSFER_EXTERNAL_VK_HASH,
      }),
    ).toBe(true);
  });

  test("match is case-insensitive", () => {
    expect(
      isRetiredDeploymentWithdrawable({
        circuitVkHash: BUNDLED_TRANSFER_EXTERNAL_VK_HASH.toUpperCase(),
      }),
    ).toBe(true);
  });

  test("mismatched vk (circuit-breaking bump) → read-only", () => {
    expect(
      isRetiredDeploymentWithdrawable({
        circuitVkHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    ).toBe(false);
  });

  test("missing vk (archived pre-ADR-0022) → read-only", () => {
    expect(isRetiredDeploymentWithdrawable({})).toBe(false);
    expect(isRetiredDeploymentWithdrawable({ circuitVkHash: undefined })).toBe(
      false,
    );
    expect(isRetiredDeploymentWithdrawable({ circuitVkHash: null })).toBe(false);
  });
});
