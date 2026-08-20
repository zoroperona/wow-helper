using Microsoft.Data.Sqlite;
using WowDb.Services;

namespace WowDb.Tests;

[TestClass]
public sealed class GameTableServiceTests
{
    [TestMethod]
    public async Task ExportAsyncWritesNormalizedGameTables()
    {
        var root = Path.Combine(Path.GetTempPath(), "wow-db-gametables-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new SnapshotStateStore(root);
            store.EnsureDirectories();
            await File.WriteAllTextAsync(store.GameTablePath("CombatRatingsMultByILvl"),
                "Item Level\tArmor Multiplier\tWeapon Multiplier\tTrinket Multiplier\tJewelry Multiplier\n321\t0.856210407\t0.856210407\t0.856210407\t1.201698816\n");
            await File.WriteAllTextAsync(store.GameTablePath("StaminaMultByILvl"),
                "Item Level\tArmor Multiplier\tWeapon Multiplier\tTrinket Multiplier\tJewelry Multiplier\n321\t13.44269711\t13.44269711\t13.44269711\t13.44269711\n");
            await File.WriteAllTextAsync(store.GameTablePath("ItemSocketCostPerLevel"),
                "5.0 Level\tSocket Cost\n321\t8\n");

            await new GameTableService(store).ExportAsync("12.1.0.69283", "zhCN", CancellationToken.None);

            await using (var connection = new SqliteConnection($"Data Source={store.DatabasePath}"))
            {
                await connection.OpenAsync();
                await using (var command = connection.CreateCommand())
                {
                    command.CommandText = "SELECT ArmorMultiplier FROM CombatRatingsMultByILvl WHERE ID = 321";
                    Assert.AreEqual(0.856210407, Convert.ToDouble(await command.ExecuteScalarAsync()), 0.000000001);
                    command.CommandText = "SELECT SocketCost FROM ItemSocketCostPerLevel WHERE ID = 321";
                    Assert.AreEqual(8.0, Convert.ToDouble(await command.ExecuteScalarAsync()));
                }
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            if (Directory.Exists(root))
                Directory.Delete(root, recursive: true);
        }
    }
}
