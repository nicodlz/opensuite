import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ChallengeInputs,
  FactorSummary,
} from "../src/auth/security-controls.tsx";

describe("account security controls", () => {
  it("shows the authenticator state and remaining recovery codes", () => {
    const panel = renderToStaticMarkup(
      React.createElement(FactorSummary, { totp: false, count: 3 }),
    );
    expect(panel).toContain("Authenticator app: ");
    expect(panel).toContain("off");
    expect(panel).toContain("Backup codes remaining: ");
    expect(panel).toContain("3");
  });
  it("offers only available challenge methods and explains unsupported browsers", () => {
    const props = {
      methods: { totp: false, backup: true, securityKey: true },
      backup: true,
      code: "",
      busy: false,
      onCode: () => {},
      onToggle: () => {},
      onKey: () => {},
    };
    const supported = renderToStaticMarkup(
      React.createElement(ChallengeInputs, { ...props, supported: true }),
    );
    expect(supported).toContain("Backup code");
    expect(supported).toContain("Use security key");
    expect(supported).not.toContain("Authenticator code");
    const unsupported = renderToStaticMarkup(
      React.createElement(ChallengeInputs, { ...props, supported: false }),
    );
    expect(unsupported).toContain(
      "Security keys are not supported by this browser.",
    );
    expect(unsupported).not.toContain("Use security key");
  });
});
