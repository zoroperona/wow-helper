import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconCache } from "../src/icon-cache.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("persistent icon cache", () => {
  it("reuses a downloaded icon after creating a new cache instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wow-icon-cache-"));
    cleanupPaths.push(directory);
    const source = Buffer.from("image bytes");
    const download = vi.fn(async () => new Response(source));

    const first = new IconCache(directory, download as typeof fetch);
    await expect(first.fetch("file:12345", "https://example.test/icon.jpg")).resolves.toEqual(source);
    expect(download).toHaveBeenCalledOnce();

    const offline = vi.fn(async () => {
      throw new Error("network should not be used");
    });
    const second = new IconCache(directory, offline as typeof fetch);
    await expect(second.fetch("file:12345", "https://example.test/icon.jpg")).resolves.toEqual(source);
    expect(offline).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent downloads for the same icon", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wow-icon-cache-"));
    cleanupPaths.push(directory);
    const download = vi.fn(async () => new Response(Buffer.from("same image")));
    const cache = new IconCache(directory, download as typeof fetch);

    const [first, second] = await Promise.all([
      cache.fetch("item:99", "https://example.test/icon.jpg"),
      cache.fetch("item:99", "https://example.test/icon.jpg"),
    ]);
    expect(first).toEqual(second);
    expect(download).toHaveBeenCalledOnce();
  });
});
