import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "plist";
import { describe, expect } from "vitest";
import { z } from "zod";

import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { execFileOutput } from "../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const HDIUTIL = "/usr/bin/hdiutil";

const attachedDevices = (stdout: string): string[] =>
  z
    .object({
      "system-entities": z.array(z.object({ "dev-entry": z.string() })),
    })
    .parse(parse(stdout))
    ["system-entities"].map(({ "dev-entry": device }) => device);

const imageAttached = async (imagePath: string): Promise<boolean> =>
  z
    .object({
      images: z.array(z.object({ "image-path": z.string().optional() })),
    })
    .parse(parse((await execFileOutput(HDIUTIL, ["info", "-plist"])).stdout))
    .images.some((image) => image["image-path"] === imagePath);

describe.skipIf(process.platform !== "darwin")(
  "DMG inspection with a preexisting attachment",
  () => {
    cliTest(
      "retains root observations and leaves another owner's attachment alone",
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-dmg-preexisting-");
        const source = join(root, "source");
        const mountRoot = join(root, "foreign-mounts");
        const imagePath = join(root, "fixture.dmg");
        await mkdir(source);
        await mkdir(mountRoot);
        await writeFile(join(source, "file.txt"), "fixture\n");
        await execFileOutput(HDIUTIL, [
          "create",
          "-quiet",
          "-srcfolder",
          source,
          "-volname",
          "PreexistingFixture",
          "-format",
          "UDZO",
          imagePath,
        ]);
        const devices = attachedDevices(
          (
            await execFileOutput(HDIUTIL, [
              "attach",
              "-readonly",
              "-nobrowse",
              "-plist",
              "-mountroot",
              mountRoot,
              imagePath,
            ])
          ).stdout,
        );
        try {
          const inspected = await cli.run({
            arguments: ["inspect-artifact", imagePath, "--json"],
          });
          expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(
            0,
          );
          const inspection = artifactInspectionResultSchema.parse(
            parseEvidence(inspected.json).normalized_result,
          );
          const inventoryEvidence = inspection.substeps[0]?.evidence;
          if (inventoryEvidence === undefined)
            throw new Error("CLI inspection did not retain DMG inventory");
          const inventory = artifactInventoryResultSchema.parse(
            inventoryEvidence.normalized_result,
          );
          expect(inventory.manifest).toMatchObject({
            root_format: "dmg",
            occurrence_count: 1,
          });
          expect(inventory.manifest.root_sha256).toBe(
            createHash("sha256")
              .update(await readFile(imagePath))
              .digest("hex"),
          );
          expect(inventory.coverage).toEqual({
            scope: "container-entries",
            status: "unknown",
          });
          expect(inventory.limitations).toEqual([
            expect.stringMatching(
              /^DMG child inventory is unknown: hdiutil refused a private read-only attachment .*release it and retry/u,
            ),
          ]);
          expect(inventory.provenance).toContainEqual(
            expect.objectContaining({
              arguments: expect.arrayContaining(["attach", imagePath]),
              exit_code: expect.any(Number),
              effects: ["read"],
            }),
          );
          expect(inspection.limitations).toEqual(
            expect.arrayContaining(inventory.limitations),
          );
          expect(await imageAttached(imagePath)).toBe(true);
        } finally {
          const wholeDisk =
            devices.find((device) => /^\/dev\/disk\d+$/u.test(device)) ??
            devices[0];
          if (wholeDisk !== undefined)
            await execFileOutput(HDIUTIL, ["detach", wholeDisk]);
        }
        expect(await imageAttached(imagePath)).toBe(false);
      },
      120_000,
    );
  },
);
