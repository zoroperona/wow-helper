import { chmod, mkdir } from "node:fs/promises";
import type { APIRequestContext, BrowserContext } from "playwright";
import { chromium } from "playwright";
import type { CharacterLookup } from "./dpswow.js";
import { IntegrationError } from "./dpswow.js";
import { normalizeCharacterEquipment } from "./equipment.js";

const armoryApiBaseUrl = "https://webapi.blizzard.cn/wow-armory-server/api";
const armoryPageBaseUrl = "https://wow.blizzard.cn/character/#";
const successCode = 0;
const notLoggedInCode = 20_000;

interface ArmoryEnvelope {
  code: number;
  message?: string;
  data?: unknown;
}

export class ArmoryLoginRequiredError extends IntegrationError {
  constructor() {
    super("战网登录已失效，需要在官方页面重新登录", 401, "ARMORY_LOGIN_REQUIRED");
  }
}

export class BlizzardArmoryClient {
  private sessionQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sessionPath: string,
    private readonly loginTimeoutMs = 5 * 60_000,
  ) {}

  lookupCharacter(realmSlug: string, characterName: string): Promise<CharacterLookup> {
    return this.withSession(async () => {
      const context = await this.launch(false);
      try {
        return await this.readCharacter(context.request, realmSlug, characterName);
      } finally {
        await context.close();
      }
    });
  }

  login(realmSlug: string, characterName: string): Promise<void> {
    return this.withSession(async () => {
      const context = await this.launch(true);
      let closed = false;
      context.once("close", () => {
        closed = true;
      });
      try {
        const page = context.pages()[0] || await context.newPage();
        await page.goto(characterPageUrl(realmSlug, characterName), {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.bringToFront();

        const deadline = Date.now() + this.loginTimeoutMs;
        while (!closed && Date.now() < deadline) {
          if (context.pages().length === 0) {
            closed = true;
            break;
          }
          try {
            await this.readIndex(context.request, realmSlug, characterName);
            return;
          } catch (error) {
            if (!(error instanceof ArmoryLoginRequiredError)) throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        throw new IntegrationError(
          closed ? "战网登录窗口已关闭" : "等待战网登录超时，请重新刷新角色",
          408,
          "ARMORY_LOGIN_TIMEOUT",
        );
      } finally {
        if (!closed) await context.close();
      }
    });
  }

  private async launch(headed: boolean): Promise<BrowserContext> {
    await mkdir(this.sessionPath, { recursive: true, mode: 0o700 });
    await chmod(this.sessionPath, 0o700);
    try {
      return await chromium.launchPersistentContext(this.sessionPath, {
        headless: !headed,
        viewport: { width: 1280, height: 850 },
        locale: "zh-CN",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = message.includes("Executable doesn't exist")
        ? "请先在 loot-allocator 目录运行 npx playwright install chromium。"
        : "";
      throw new IntegrationError(
        `无法启动英雄榜登录浏览器：${message}${hint ? ` ${hint}` : ""}`,
      );
    }
  }

  private async readCharacter(
    request: APIRequestContext,
    realmSlug: string,
    characterName: string,
  ): Promise<CharacterLookup> {
    const indexData = await this.readIndex(request, realmSlug, characterName);
    const token = textValue(indexData.token);
    if (!token) {
      throw new IntegrationError("国服英雄榜没有返回角色访问令牌");
    }
    const equipmentUrl = new URL(`${armoryApiBaseUrl}/do`);
    equipmentUrl.searchParams.set("api", "equipment");
    equipmentUrl.searchParams.set("token", token);
    const equipmentEnvelope = await this.getEnvelope(request, equipmentUrl);
    assertSuccessful(equipmentEnvelope);
    return normalizeArmoryCharacter(indexData, equipmentEnvelope.data);
  }

  private async readIndex(
    request: APIRequestContext,
    realmSlug: string,
    characterName: string,
  ): Promise<Record<string, unknown>> {
    const indexUrl = new URL(`${armoryApiBaseUrl}/index`);
    indexUrl.searchParams.set("realm_slug", realmSlug);
    indexUrl.searchParams.set("role_name", characterName);
    const envelope = await this.getEnvelope(request, indexUrl);
    assertSuccessful(envelope);
    const data = asRecord(envelope.data);
    if (!Object.keys(data).length) {
      throw new IntegrationError("国服英雄榜返回了空角色资料", 404);
    }
    return data;
  }

  private async getEnvelope(request: APIRequestContext, url: URL): Promise<ArmoryEnvelope> {
    let response;
    try {
      response = await request.get(url.toString(), {
        headers: {
          Accept: "application/json",
          Referer: "https://wow.blizzard.cn/character/",
        },
        timeout: 30_000,
      });
    } catch (error) {
      throw new IntegrationError(
        `无法访问国服英雄榜：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok()) {
      throw new IntegrationError(`国服英雄榜返回 HTTP ${response.status()}`);
    }
    try {
      return await response.json() as ArmoryEnvelope;
    } catch {
      throw new IntegrationError("国服英雄榜返回了无效数据");
    }
  }

  private withSession<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sessionQueue.then(operation, operation);
    this.sessionQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function normalizeArmoryCharacter(
  indexPayload: unknown,
  equipmentPayload: unknown,
): CharacterLookup {
  const index = asRecord(indexPayload);
  const summary = asRecord(index.character_summary);
  const realm = asRecord(summary.realm);
  const characterClass = asRecord(summary.character_class);
  const activeSpec = asRecord(summary.active_spec);
  const name = textValue(summary.name);
  const realmSlug = textValue(realm.slug);
  if (!name || !realmSlug) {
    throw new IntegrationError("国服英雄榜角色资料缺少名称或服务器", 502);
  }
  const rawPayload = {
    character_summary: summary,
    equipment: asRecord(equipmentPayload),
  };
  const equipment = normalizeCharacterEquipment(rawPayload);
  return {
    name,
    realmName: textValue(realm.name),
    realmSlug,
    className: textValue(characterClass.name),
    specialization: textValue(activeSpec.name),
    level: equipment.level,
    averageItemLevel: equipment.averageItemLevel,
    equippedItemLevel: equipment.equippedItemLevel,
    equipment: equipment.items,
    rawPayload,
  };
}

export function characterPageUrl(realmSlug: string, characterName: string): string {
  return `${armoryPageBaseUrl}/${encodeURIComponent(realmSlug)}/${encodeURIComponent(characterName)}`;
}

function assertSuccessful(envelope: ArmoryEnvelope): void {
  if (envelope.code === notLoggedInCode) throw new ArmoryLoginRequiredError();
  if (envelope.code !== successCode) {
    throw new IntegrationError(envelope.message || `国服英雄榜查询失败 (${envelope.code})`, 502);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
