import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

/** Capture before asynchronous preparation; schema renewal cannot revive a revoked physical owner. */
export function captureExecApprovalsReadAuthority(context: OpenClawStateWorkerContext): () => void {
  const lifetime = context.stateIntegrity?.lifetime;
  const signal = getAsyncWorkSignal();
  return () => {
    signal?.throwIfAborted();
    getAsyncWorkSignal()?.throwIfAborted();
    context.maintenanceScope?.assertReadAdmission();
    context.admission.assertCurrent();
    if (lifetime && Atomics.load(new BigInt64Array(lifetime.revision), 0) !== lifetime.epoch) {
      throw new Error("Exec approval integrity admission changed before execution");
    }
  };
}
