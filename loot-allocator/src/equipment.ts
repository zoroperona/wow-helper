import type { EquipmentSetInfo, EquippedItem } from "./types.js";

export interface NormalizedCharacterEquipment {
  level: number;
  averageItemLevel: number;
  equippedItemLevel: number;
  items: EquippedItem[];
}

export function normalizeCharacterEquipment(payload: unknown): NormalizedCharacterEquipment {
  const root = asRecord(payload);
  const summary = asRecord(root.character_summary);
  const equipment = asRecord(root.equipment);
  const equippedItems = Array.isArray(equipment.equipped_items)
    ? equipment.equipped_items
    : [];

  return {
    level: numberValue(summary.level),
    averageItemLevel: numberValue(summary.average_item_level),
    equippedItemLevel: numberValue(summary.equipped_item_level),
    items: equippedItems.map(normalizeItem).filter((item): item is EquippedItem => item !== null),
  };
}

function normalizeItem(value: unknown): EquippedItem | null {
  const item = asRecord(value);
  const media = asRecord(item.media);
  const slot = asRecord(item.slot);
  const itemId = numberValue(media.id);
  const slotType = textValue(slot.type);
  if (!itemId || !slotType) {
    return null;
  }

  return {
    itemId,
    name: textValue(item.name) || `物品 ${itemId}`,
    itemLevel: numberValue(asRecord(item.level).value),
    slotType,
    slotName: textValue(slot.name) || slotType,
    inventoryType: textValue(asRecord(item.inventory_type).type),
    quality: textValue(asRecord(item.quality).type) || "UNKNOWN",
    bonusList: Array.isArray(item.bonus_list)
      ? item.bonus_list.map(numberValue).filter((entry) => entry > 0)
      : [],
    enchantments: Array.isArray(item.enchantments)
      ? item.enchantments.map((entry) => {
          const enchantment = asRecord(entry);
          return {
            id: nullableNumber(enchantment.enchantment_id),
            displayString: textValue(enchantment.display_string),
          };
        })
      : [],
    sockets: Array.isArray(item.sockets)
      ? item.sockets.map((entry) => {
          const socket = asRecord(entry);
          const socketItem = asRecord(socket.item);
          return {
            type: textValue(asRecord(socket.socket_type).type),
            itemId: nullableNumber(asRecord(socket.media).id),
            itemName: nullableText(socketItem.name),
            displayString: textValue(socket.display_string),
          };
        })
      : [],
    set: normalizeItemSet(item.set),
    // Remote armory icons are deliberately not persisted. wow-db will resolve these later.
    iconUrl: null,
  };
}

function normalizeItemSet(value: unknown): EquipmentSetInfo | null {
  const set = asRecord(value);
  const name = textValue(asRecord(set.item_set).name);
  const displayString = textValue(set.display_string);
  const effects = Array.isArray(set.effects)
    ? set.effects.map((value) => {
        const effect = asRecord(value);
        return {
          displayString: textValue(effect.display_string),
          requiredCount: numberValue(effect.required_count),
          isActive: effect.is_active === true,
        };
      }).filter((effect) => effect.displayString && effect.requiredCount > 0)
    : [];
  return name || displayString || effects.length ? { name, displayString, effects } : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  return textValue(value) || null;
}

function numberValue(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  const number = numberValue(value);
  return number > 0 ? number : null;
}
