using Microsoft.Data.Sqlite;
using WowDb.Services;

namespace WowDb.Tests;

[TestClass]
public sealed class SqliteTableWriterTests
{
    [TestMethod]
    public async Task ReplacesOneTableAndRegistersItsInputHashes()
    {
        var root = Path.Combine(Path.GetTempPath(), "wow-db-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        var database = Path.Combine(root, "wow.sqlite");
        try
        {
            await using (var writer = new SqliteTableWriter(database))
            {
                await writer.InitializeAsync(CancellationToken.None);
                var count = await writer.ReplaceTableAsync(
                    "Map",
                    [new ExportColumn("Name", typeof(string)), new ExportColumn("Flags", typeof(uint)), new ExportColumn("Values", typeof(int[]))],
                    [new ExportRow(1, ["Azeroth", 7u, new[] { 1, 2 }])],
                    "12.1.0.69299",
                    "zhCN",
                    "raw-hash",
                    "definitions-hash",
                    0x12345678,
                    CancellationToken.None,
                    "hotfix-hash");
                Assert.AreEqual(1, count);
                Assert.IsTrue(await writer.IsCurrentAsync("Map", "12.1.0.69299", "zhCN", "raw-hash", "definitions-hash", CancellationToken.None, "hotfix-hash"));
                Assert.IsFalse(await writer.IsCurrentAsync("Map", "12.1.0.69299", "zhCN", "raw-hash", "definitions-hash", CancellationToken.None));
            }

            await using (var connection = new SqliteConnection($"Data Source={database}"))
            {
                await connection.OpenAsync();
                await using var command = connection.CreateCommand();
                command.CommandText = "SELECT \"Name\", \"Flags\", \"Values\" FROM \"Map\" WHERE \"__id\" = 1";
                await using var reader = await command.ExecuteReaderAsync();
                Assert.IsTrue(await reader.ReadAsync());
                Assert.AreEqual("Azeroth", reader.GetString(0));
                Assert.AreEqual(7L, reader.GetInt64(1));
                Assert.AreEqual("[1,2]", reader.GetString(2));
            }
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            Directory.Delete(root, recursive: true);
        }
    }
}
