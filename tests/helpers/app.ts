import { createApp } from "../../src/app";
import { registerDependencies } from "../../src/bootstrap";
import { createInternalApp } from "../../src/internal-app";
import type { BuildTestAppsOptions, TestApps } from "./types";

/** The real wiring — integration tests never mock services or repositories. */
export function buildTestApps(options?: BuildTestAppsOptions): TestApps {
  const scope = registerDependencies(options?.overrides);

  return {
    publicApp: createApp({ extraApiRouter: options?.extraApiRouter, scope }),
    internalApp: createInternalApp({ extraInternalRouter: options?.extraInternalRouter, scope }),
  };
}
