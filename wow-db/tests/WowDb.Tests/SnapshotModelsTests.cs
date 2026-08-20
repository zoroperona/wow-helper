using System.Text.Json;
using WowDb.Models;
using WowDb.Services;

namespace WowDb.Tests;

[TestClass]
public sealed class SnapshotModelsTests
{
    [TestMethod]
    public void ReportSerializesNotPresentSeparatelyFromFailures()
    {
        var result = new SnapshotResult(
            "all",
            Total: 2,
            Extracted: 1,
            Exported: 1,
            Failed: 0,
            NotAddressable: 0,
            NotPresent: 1,
            Failures: [],
            NotAddressableTables: [],
            NotPresentTables: ["LegacyTable"]);

        var json = JsonSerializer.Serialize(result, AtomicFiles.JsonOptions);

        StringAssert.Contains(json, "\"notPresent\": 1");
        StringAssert.Contains(json, "\"notPresentTables\":");
        StringAssert.Contains(json, "\"LegacyTable\"");
        StringAssert.Contains(json, "\"failures\": []");
    }
}
