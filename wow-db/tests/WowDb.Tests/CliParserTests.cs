using WowDb.Cli;

namespace WowDb.Tests;

[TestClass]
public sealed class CliParserTests
{
    [TestMethod]
    public void SnapshotDefaultsAreChinaRetail()
    {
        var options = CliParser.Parse(["snapshot", "--client", "/tmp/WoW"]);

        Assert.AreEqual(CommandKind.Snapshot, options.Command);
        Assert.AreEqual("wow", options.Product);
        Assert.AreEqual("cn", options.Region);
        Assert.AreEqual("zhCN", options.Locale);
        Assert.AreEqual(SnapshotPhase.All, options.Phase);
    }

    [TestMethod]
    public void TableOptionAcceptsRepeatedAndCommaSeparatedValues()
    {
        var options = CliParser.Parse([
            "snapshot", "--client", "/tmp/WoW",
            "--table", "Map,SpellName",
            "--table", "ItemSparse",
            "--phase", "raw"
        ]);

        CollectionAssert.AreEquivalent(new[] { "Map", "SpellName", "ItemSparse" }, options.Tables.ToArray());
        Assert.AreEqual(SnapshotPhase.Raw, options.Phase);
    }

    [TestMethod]
    public void HotfixOptionIsAnAbsolutePath()
    {
        var options = CliParser.Parse(["snapshot", "--client", "/tmp/WoW", "--hotfix", "cache/DBCache.bin"]);

        Assert.AreEqual(Path.GetFullPath("cache/DBCache.bin"), options.HotfixPath);
    }
}
