import type {
  PackageActivationOptions,
  PackageUpdateTransaction,
} from "../../infra/package-update-swap-contract.js";
import type { UpdateDatabaseBackup } from "../../infra/update-database-backup.js";
import type { UpdateDoctorConfigChange } from "../../infra/update-doctor-config.js";
import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";
import type { UpdateRecoveryBaselineRef } from "../../infra/update-recovery-baseline-capture.js";
import type { UpdateRequester } from "../../infra/update-requester-authority.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateStepProgress } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import type { UpdateConfigSnapshot } from "./update-command-config-snapshot.js";

type PackageDoctorContext = {
  runId: string;
  executorFence: UpdateRecoveryFence;
  requester?: Readonly<UpdateRequester>;
  inputHash: string;
  changes: UpdateDoctorConfigChange[];
  databaseBackup?: UpdateDatabaseBackup;
  originalRecoveryCapture?: UpdateRecoveryBaselineRef;
  assertCurrent: () => void;
  assertBoundChildCurrent: () => void;
  onStateHandoff?: () => void;
};

export type PackageDoctorOptions = {
  root: string;
  restart?: boolean;
  timeoutMs?: number;
  /** Null leaves forward work unbounded; omission retains the caller's timeout. */
  workTimeoutMs?: number | null;
  progress: UpdateStepProgress;
  assertCurrent?: () => void;
  results?: UpdateStepResult[];
  managedServiceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  nodeRunner?: string;
  onConfigSnapshot?: (snapshot: UpdateConfigSnapshot) => void;
  getDoctorContext?: () => PackageDoctorContext | undefined;
};

export type PackageInstallUpdateParams = Omit<PackageDoctorOptions, "results"> & {
  reapplyLocalOverrides?: boolean;
  requirePackageReplacement?: boolean;
  installKind: "git" | "package" | "unknown";
  tag: string;
  installSpec?: string;
  packageTarget?: import("../../../packages/gateway-protocol/src/schema/config.js").PackageUpdateTarget;
  timeoutMs: number;
  startedAt: number;
  honorPackageRoot?: boolean;
  resolveLifecycleNodeRunner?: () => string | undefined;
  installEnv?: NodeJS.ProcessEnv;
  installTarget?: ResolvedGlobalInstallTarget;
  beforeVerifyCandidate?: (root: string) => Promise<void>;
  validateCandidate: (root: string) => Promise<UpdateStepResult[]>;
  beforeActivate: () => Promise<void>;
  reserveInstallSlot?: (root: string) => void;
  onTransaction: (transaction: PackageUpdateTransaction) => void | Promise<void>;
  getActivation?: () => PackageActivationOptions | undefined;
};
