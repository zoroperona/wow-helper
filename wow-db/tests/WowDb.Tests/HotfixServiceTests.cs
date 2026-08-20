using WowDb.Services;

namespace WowDb.Tests;

[TestClass]
public sealed class HotfixServiceTests
{
    [TestMethod]
    public void ParseBuildNumberReadsClientBuildSuffix()
    {
        Assert.AreEqual(69299, HotfixService.ParseBuildNumber("12.1.0.69299"));
    }

    [TestMethod]
    public void ParseBuildNumberRejectsInvalidBuild()
    {
        Assert.Throws<InvalidDataException>(() => HotfixService.ParseBuildNumber("unknown"));
    }
}
