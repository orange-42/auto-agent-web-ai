function readBooleanFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export const FEATURE_FLAGS = {
  ENABLE_PHASE_ARTIFACTS: readBooleanFlag("ENABLE_PHASE_ARTIFACTS", true),
  ENABLE_STRUCTURED_EDIT: readBooleanFlag("ENABLE_STRUCTURED_EDIT", true),
  ENABLE_AST_GATE: readBooleanFlag("ENABLE_AST_GATE", true),
  ENABLE_TEST_CASES_V2: readBooleanFlag("ENABLE_TEST_CASES_V2", true),
  ENABLE_HERMES_EVOLUTION: readBooleanFlag("ENABLE_HERMES_EVOLUTION", true),
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

export function isFeatureEnabled(name: FeatureFlagName): boolean {
  return FEATURE_FLAGS[name];
}

export function getFeatureFlagSnapshot(): Record<FeatureFlagName, boolean> {
  return { ...FEATURE_FLAGS };
}
