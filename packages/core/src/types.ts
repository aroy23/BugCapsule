export type PackageManager = "npm" | "pnpm" | "yarn" | "unknown";
export type TestRunner = "vitest" | "jest" | "playwright" | "unknown";
export type Framework = "next" | "vite" | "node" | "unknown";
export type MockMode = "auto" | "manual" | "fixture" | "empty" | "passthrough" | "fail";

export type ProjectInfo = {
  rootPath: string;
  packageManager: PackageManager;
  testRunner: TestRunner;
  framework: Framework;
  tsconfigPath?: string;
  packageJsonPath: string;
};

export type StackFrame = {
  file: string;
  line?: number;
  column?: number;
  functionName?: string;
  isUserCode: boolean;
};

export type CapsuleFileKind = "source" | "test" | "fixture" | "runtime_repro" | "generated_mock" | "config" | "package";

export type CapsuleFileMapping = {
  capsulePath: string;
  originalPath: string;
  kind: CapsuleFileKind;
  hashAtCapture: string;
  originalHashAtCapture?: string;
  editable: boolean;
};

export type CapsuleMock = {
  moduleName: string;
  mode: "auto" | "fixture" | "empty" | "manual";
  generatedPath: string;
  reason: string;
};

export type CapsuleFixture = {
  path: string;
  source: "captured" | "generated" | "copied";
  description: string;
};

export type BugCapsuleManifest = {
  schemaVersion: "0.1";
  capsuleId: string;
  name: string;
  createdAt: string;
  originalRepo: {
    rootPath: string;
    gitCommit?: string;
    gitBranch?: string;
    packageManager: PackageManager;
    language: "typescript";
  };
  originalRepro: {
    command: string;
    exitCode: number;
    stdoutPath: string;
    stderrPath: string;
    failureSummary: string;
    stackTrace: StackFrame[];
  };
  capsule: {
    path: string;
    installCommand: string;
    runCommand: string;
    expectedInitialStatus: "failing";
    testFramework: TestRunner;
  };
  files: CapsuleFileMapping[];
  mocks: CapsuleMock[];
  fixtures: CapsuleFixture[];
  metrics: {
    originalFileCount: number;
    capsuleFileCount: number;
    contextReductionPercent: number;
    originalApproxTokens?: number;
    capsuleApproxTokens?: number;
  };
  apply: {
    strategy: "file-map-patch";
    requireCleanGitWorktree: boolean;
    verifyOriginalCommand: boolean;
  };
};

export type BugCapsuleReport = {
  capsuleId: string;
  status: CreateCapsuleResult["status"];
  originalFileCount: number;
  capsuleFileCount: number;
  contextReductionPercent: number;
  failureMessage: string;
  includedFiles: Array<{ path: string; reason: string }>;
  mocks: CapsuleMock[];
};

export type CreateCapsuleOptions = {
  repoPath: string;
  command: string;
  capsuleId?: string;
  capsuleName?: string;
  maxFiles?: number;
  maxDepth?: number;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  mockPolicy?: Record<string, MockMode>;
  installDependencies?: boolean;
  verifyCapsule?: boolean;
  outputFormat?: "text" | "json";
  additionalFiles?: AdditionalCapsuleFile[];
};

export type AdditionalCapsuleFile = {
  capsulePath: string;
  originalPath?: string;
  kind: CapsuleFileKind;
  content: string;
  editable?: boolean;
};

export type SuggestReproOptions = {
  repoPath: string;
  bugDescription?: string;
  url?: string;
  errorText?: string;
};

export type ReproCandidate = {
  command: string;
  kind: "test" | "runtime_probe" | "runtime_script" | "package_script" | "dev_server" | "manual_browser";
  confidence: number;
  reason: string;
  canCreateCapsule: boolean;
  nextAction: string;
};

export type SuggestReproResult = {
  status: "ready" | "needs_repro";
  repoPath: string;
  bugDescription?: string;
  url?: string;
  candidates: ReproCandidate[];
  relatedFiles: Array<{
    path: string;
    reason: string;
    score: number;
  }>;
  agentWorkflow: Array<{
    step: number;
    action: string;
    detail: string;
  }>;
};

export type CreateCapsuleResult = {
  capsuleId: string;
  capsulePath: string;
  status:
    | "created_failing"
    | "created_not_reproduced"
    | "failed_original_passed"
    | "failed_capture_error";
  manifest: BugCapsuleManifest;
  report: BugCapsuleReport;
};

export type RuntimeProbeOptions = {
  repoPath: string;
  url: string;
  bugDescription?: string;
  interactionHint?: string;
};

export type RuntimeInteraction = {
  method: string;
  url: string;
  source: "html_fetch" | "page_get";
  reason: string;
};

export type RuntimeFailure = {
  method: string;
  url: string;
  statusCode: number;
  errorMessage: string;
  stack?: string;
  responseBody: string;
  stackTrace: StackFrame[];
};

export type RuntimeProbeResult = {
  status: "failure_found" | "no_failure_found" | "probe_failed";
  repoPath: string;
  url: string;
  attemptedInteractions: Array<RuntimeInteraction & {
    statusCode?: number;
    outcome: "failure" | "passed" | "error";
    message?: string;
  }>;
  failure?: RuntimeFailure;
  relatedFiles: Array<{
    path: string;
    reason: string;
  }>;
  message?: string;
};

export type CreateCapsuleFromRuntimeOptions = Omit<CreateCapsuleOptions, "command" | "additionalFiles"> & {
  url: string;
  bugDescription?: string;
  interactionHint?: string;
};

export type RuntimeGeneratedRepro = {
  path: string;
  command: string;
  targetExport: {
    file: string;
    name: string;
  };
  inputSource: string;
};

export type CreateCapsuleFromRuntimeResult =
  | {
    status: "runtime_probe_failed" | "no_runtime_failure_found" | "runtime_repro_unavailable";
    repoPath: string;
    url: string;
    message: string;
    probe: RuntimeProbeResult;
  }
  | (CreateCapsuleResult & {
    probe: RuntimeProbeResult;
    generatedRepro: RuntimeGeneratedRepro;
  });

export type RunCapsuleOptions = {
  repoPath: string;
  capsuleId: string;
  command?: string;
};

export type RunCapsuleResult = {
  status: "passed" | "failed" | "error";
  exitCode: number;
  stdout: string;
  stderr: string;
  failureSummary?: string;
};

export type ApplyCapsuleOptions = {
  repoPath: string;
  capsuleId: string;
  dryRun?: boolean;
  verify?: boolean;
  allowDirty?: boolean;
};

export type ApplyCapsuleResult = {
  status: "applied_verified" | "applied_unverified" | "dry_run" | "conflict" | "failed";
  modifiedOriginalFiles: string[];
  patchPath?: string;
  verification?: VerifyCapsuleResult;
  message?: string;
};

export type VerifyCapsuleOptions = {
  repoPath: string;
  capsuleId: string;
  runFullProjectTests?: boolean;
};

export type VerifyCapsuleResult = {
  status: "passed" | "failed" | "error";
  checks: Array<{
    name: string;
    status: "passed" | "failed" | "skipped" | "error";
    command?: string;
    stdout?: string;
    stderr?: string;
  }>;
};

export type InspectCapsuleOptions = {
  repoPath: string;
  capsuleId: string;
};

export type ListCapsulesOptions = {
  repoPath: string;
};

export type ListCapsulesResult = {
  capsules: Array<{
    capsuleId: string;
    status: CreateCapsuleResult["status"] | "fixed_pending" | "unknown";
    createdAt: string;
    capsulePath: string;
    fileCount: number;
  }>;
};

export type BugCapsuleConfig = {
  project?: {
    language?: "typescript";
    packageManager?: PackageManager | "auto";
    testRunner?: TestRunner | "auto";
  };
  create?: {
    defaultMaxFiles?: number;
    defaultMaxDepth?: number;
    verifyAfterCreate?: boolean;
  };
  slicing?: {
    forceInclude?: string[];
    forceExclude?: string[];
    preferMockFor?: string[];
  };
  mocks?: {
    defaultMode?: MockMode;
  };
  apply?: {
    requireCleanGitWorktree?: boolean;
    createPatchFile?: boolean;
    verifyOriginalCommand?: boolean;
  };
  telemetry?: {
    enabled?: boolean;
  };
};

export type CapturedFailure = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  failureSummary: string;
  stackTrace: StackFrame[];
};
