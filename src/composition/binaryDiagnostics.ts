import { RecordedCrashService } from "../application/binaryDiagnostics/RecordedCrashService.js";
import { PwntoolsRecordedCrashProvider } from "../native/pwntools/PwntoolsRecordedCrashProvider.js";
import { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import { PwntoolsLayoutProvider } from "../native/pwntools/PwntoolsLayoutProvider.js";
import { PeResourcesService } from "../application/binaryDiagnostics/PeResourcesService.js";
import { PeResourcesProvider } from "../native/pe/PeResourcesProvider.js";
import { WindowsMinidumpService } from "../application/binaryDiagnostics/WindowsMinidumpService.js";
import { WindowsMinidumpProvider } from "../native/minidump/WindowsMinidumpProvider.js";

/** Portable recorded minidump inspection; no debugger, symbols or live target. */
export const createWindowsMinidumpService = (): WindowsMinidumpService =>
  new WindowsMinidumpService(new WindowsMinidumpProvider());

/** Portable PE inspection with no engine, installation or target acquisition. */
export const createPeResourcesService = (): PeResourcesService =>
  new PeResourcesService(new PeResourcesProvider());

/** Compose the offline adapter without import-time I/O or dependency acquisition. */
export const createBinaryLayoutService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): BinaryLayoutService =>
  new BinaryLayoutService(new PwntoolsLayoutProvider(environment));

/** Compose recorded-core inspection without acquiring a debugger or toolchain. */
export const createRecordedCrashService = (
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): RecordedCrashService =>
  new RecordedCrashService(new PwntoolsRecordedCrashProvider(environment));
