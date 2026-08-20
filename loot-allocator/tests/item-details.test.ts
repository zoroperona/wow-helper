import { describe, expect, it } from "vitest";
import { parseWowheadItemDetails } from "../src/app.js";

describe("Wowhead item details", () => {
  it("expands two-stat and three-stat adaptive primary attributes", () => {
    const xml = `
      <item>
        <htmlTooltip><![CDATA[
          <span>+1,234 [力量 or 敏捷 or 智力]</span>
          <span>+456 [Strength or Agility]</span>
          <span>+321 急速</span>
        ]]></htmlTooltip>
      </item>`;

    expect(parseWowheadItemDetails(xml).statValues).toEqual({
      力量: 1234,
      敏捷: 1234,
      智力: 1234,
      Strength: 456,
      Agility: 456,
      急速: 321,
    });
  });
});
