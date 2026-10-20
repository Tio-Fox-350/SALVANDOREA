import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisCancelledError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { SafeOutputSourceFailure } from "./SafeOutputSourceFailure.js";
import { AnalysisCleanupLeaseGroup } from "./AnalysisCleanupLease.js";
import {
  ArtifactFileCleanupFailure,
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "./ArtifactFileOperation.js";

/** Translate one artifact boundary failure while retaining cleanup evidence. */
export const translateArtifactFailure = (
  operation: ArtifactOperationError["operation"],
  cause: unknown,
): AnalysisError => {
  if (cause instanceof ArtifactReaderFailure) {
    const error = new ArtifactOperationError(
      operation,
      cause.reason,
      cause.details,
      cause.message,
      {
        cause:
          cause.reason === "cancelled"
            ? artifactFileCancellationCause(cause)
            : cause,
        ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
        ...(cause.partialObservation === undefined
          ? {}
          : { partialObservation: cause.partialObservation }),
      },
    );
    if (cause instanceof SafeOutputSourceFailure) {
      // Mixed authority has no aggregate lease. Follow each live owner instead
      // of freezing its resources into the parent's historical observation.
      const primary = translateOwnedArtifactFailure(operation, cause.cause);
      const secondary = cause.sourceFailures.map((failure) =>
        translateOwnedArtifactFailure(operation, failure),
      );
      for (const failure of secondary) error.retainSecondaryFailure(failure);
      error.bindCleanupDependencies([primary, ...secondary]);
    } else if (cause instanceof ArtifactFileCleanupFailure) {
      // A failed outer close owns only its exact file. Inherited source errors
      // keep their independent cleanup dependencies across this wrapper too.
      const physical = cause.fileCleanupFailure;
      const observation = ArtifactReaderFailure.cleanupObservation(
        physical.cleanupCause,
        physical.path,
      );
      const cleanup = new ArtifactOperationError(
        operation,
        "io",
        undefined,
        observation.reason,
        { cause: physical.cleanupCause, cleanup: observation },
      );
      new AnalysisCleanupLeaseGroup(cleanup, [cause.cleanupLease]);
      const inherited =
        physical.outcome.kind === "failed"
          ? [translateOwnedArtifactFailure(operation, physical.outcome.cause)]
          : [];
      error.bindCleanupDependencies([cleanup, ...inherited]);
    } else bindArtifactFileCleanup(cause, error);
    return error;
  }
  // Caller-selection and unsupported-target failures are already typed; keep
  // their correction details instead of reducing them to an I/O failure.
  if (
    cause instanceof AnalysisInputError ||
    cause instanceof AnalysisCancelledError ||
    cause instanceof AnalysisUnsupportedTargetError
  )
    return cause;
  return new ArtifactOperationError(operation, "io");
};

/** A domain error already owns its live cleanup state; only classify raw errors. */
const translateOwnedArtifactFailure = (
  operation: ArtifactOperationError["operation"],
  cause: unknown,
): AnalysisError =>
  cause instanceof AnalysisError
    ? cause
    : translateArtifactFailure(operation, ArtifactReaderFailure.from(cause));
