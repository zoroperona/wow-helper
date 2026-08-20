import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

type Fetcher = typeof fetch;

export class IconCache {
  private readonly memory = new Map<string, Buffer>();
  private readonly pending = new Map<string, Promise<Buffer>>();

  constructor(
    private readonly directory: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async get(key: string): Promise<Buffer | null> {
    const cached = this.memory.get(key);
    if (cached) return cached;
    try {
      const body = await readFile(this.pathFor(key));
      this.memory.set(key, body);
      return body;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }
  }

  async fetch(key: string, source: string): Promise<Buffer> {
    const cached = await this.get(key);
    if (cached) return cached;
    const active = this.pending.get(key);
    if (active) return active;

    const request = this.download(key, source).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  private async download(key: string, source: string): Promise<Buffer> {
    const result = await this.fetcher(source, { signal: AbortSignal.timeout(20_000) });
    if (!result.ok) throw new Error(`Icon returned ${result.status}`);
    const body = Buffer.from(await result.arrayBuffer());
    if (!body.length) throw new Error("Icon returned an empty response");

    await mkdir(this.directory, { recursive: true });
    const destination = this.pathFor(key);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body);
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
    this.memory.set(key, body);
    return body;
  }

  private pathFor(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex");
    return join(this.directory, `${digest}.jpg`);
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
