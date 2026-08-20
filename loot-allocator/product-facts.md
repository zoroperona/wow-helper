# Product facts

Verified on 2026-08-17. These are observed integration facts, not a public API
contract from DPSWOW.

## DPSWOW

- The site is a client-rendered Nuxt application.
- API base URL: `https://api.dpswow.com`.
- Public asset base URL: `https://public.dpswow.com`.
- A result can be read without an authenticated session through
  `GET /app/simc/userSimcRecord/info?id={resultId}`.
- The result metadata includes a `rawResultUrl`. Its report contains
  `sim.players[0].scale_factors` and the SimulationCraft DBC version/build.
- A CN character can be queried without an authenticated session through
  `GET /open/character/character/query?realm_slug={slug}&role_name={name}`.
- The character response includes current equipment, active specialization,
  talents, item levels, bonus lists, and item stats.
- Realm names and slugs are available from
  `https://public.dpswow.com/wow/data/wow_servers.json`.
- Raid, encounter, item, and specialization reference JSON is exposed under
  `https://public.dpswow.com/wow/data/`.
- The site UI warns that CN armory data is not synchronized in real time.
- The inspected site bundle contains a guest simulation endpoint, but the
  endpoint and its request contract are undocumented and may change.

## Integration policy

- Loot allocation reads only local normalized snapshots.
- DPSWOW access is isolated behind an adapter.
- A result link import must remain usable even if scheduled simulation is not.
- Source result ID, timestamps, game version/build, and compressed source
  payload are retained for audit and future reparsing.

## Official CN armory

- The character site reads `https://webapi.blizzard.cn/wow-armory-server/api`.
- `GET /index?realm_slug={slug}&role_name={name}` returns the character summary,
  available resources, and a short-lived character token.
- `GET /do?api=equipment&token={token}` returns the equipped items.
- An expired Battle.net web session returns business code `20000` with message
  `用户未登录`; the HTTP response itself remains 200.
- The site API is private and may change without notice. Its session is kept in
  a dedicated local Chromium profile and credentials are never stored by this
  application.

## Guild roster import

- Import guild members with `scripts/import-guild-roster.mjs`.
- Run `node scripts/import-guild-roster.mjs` first to audit the roster without
  changing the local database.
- After the audit reports no field risks, run
  `node scripts/import-guild-roster.mjs --commit` to back up the database,
  import eligible members, and refresh their armory equipment snapshots.
- The default guild is `暮色之末` on `kelthuzad`; the default average item-level
  range is 289 through 300, inclusive.
- Existing members are skipped using the unique identity of character name plus
  realm slug. Do not deduplicate on character name alone because the guild can
  contain cross-realm characters.
- The authenticated guild browser profile is stored at
  `artifacts/guild-browser-profile`. A Battle.net login may be required again
  when that session expires.
