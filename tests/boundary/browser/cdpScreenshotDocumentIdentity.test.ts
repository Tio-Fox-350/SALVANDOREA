import { describe, expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
describe("screenshot visual viewport capture", () => {
  it("uses the reported viewport clip and page scale", async () => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics"
          ? {
              visualViewport: {
                pageX: 12,
                pageY: 34,
                clientWidth: 640,
                clientHeight: 360,
                scale: 2,
              },
            }
          : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result.ok).toBe(true);
    const layoutMetrics = browser.commands.findIndex(
      ({ method }) => method === "Page.getLayoutMetrics",
    );
    const screenshotIndex = browser.commands.findIndex(
      ({ method }) => method === "Page.captureScreenshot",
    );
    expect(layoutMetrics).toBeGreaterThanOrEqual(0);
    expect(screenshotIndex).toBeGreaterThan(layoutMetrics);
    expect(browser.commands[screenshotIndex]?.params).toMatchObject({
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 12, y: 34, width: 640, height: 360, scale: 2 },
    });
  });

  it.each([
    ["missing metrics", {}],
    [
      "non-numeric coordinates",
      {
        visualViewport: {
          pageX: "unknown",
          pageY: 0,
          clientWidth: 10,
          clientHeight: 10,
          scale: 1,
        },
      },
    ],
    [
      "non-finite coordinates",
      {
        visualViewport: {
          pageX: Number.POSITIVE_INFINITY,
          pageY: 0,
          clientWidth: 10,
          clientHeight: 10,
          scale: 1,
        },
      },
    ],
    [
      "non-positive dimensions",
      {
        visualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 0,
          clientHeight: 10,
          scale: 1,
        },
      },
    ],
    [
      "non-positive scale",
      {
        visualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 10,
          clientHeight: 10,
          scale: 0,
        },
      },
    ],
  ])("rejects %s before screenshot capture", async (_label, metrics) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.getLayoutMetrics" ? metrics : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
    expect(
      browser.commands.some(
        ({ method }) => method === "Page.captureScreenshot",
      ),
    ).toBe(false);
  });
});

describe("screenshot committed document identity", () => {
  it.each([
    ["missing screenshot data", {}],
    ["invalid base64 screenshot data", { data: "not base64%%%" }],
  ])("reports %s as a protocol error", async (_label, result) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot" ? result : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const observation = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(observation).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });

  it.each([
    { offset: 8, value: 14 },
    { offset: 16, value: 0x8000_0000 },
    { offset: 20, value: 0x8000_0000 },
  ])("rejects invalid screenshot IHDR metadata", async ({ offset, value }) => {
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv4sAAAAASUVORK5CYII=",
      "base64",
    );
    bytes.writeUInt32BE(value, offset);
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Page.captureScreenshot"
          ? { data: bytes.toString("base64") }
          : undefined,
    });
    onTestFinished(async () => {
      await browser.close();
    });
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  });
  it.each(["loader-main", "loader-reloaded"])(
    "distinguishes %s for the same URL",
    async (screenshotDocumentLoader) => {
      const browser = await startFakeCdpBrowser({ screenshotDocumentLoader });
      onTestFinished(async () => {
        await browser.close();
      });
      const result = await new CdpBrowserProvider().captureScreenshot(
        captureWebScreenshotInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
        }),
      );
      if (screenshotDocumentLoader === "loader-main")
        expect(result.ok).toBe(true);
      else
        expect(result).toMatchObject({
          ok: false,
          error: { reason: "target_changed" },
        });
    },
  );
});
