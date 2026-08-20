using System.Text;
using WowDb.Services;

namespace WowDb.Tests;

[TestClass]
public sealed class RawExtractorTests
{
    [TestMethod]
    [DataRow("WDBC")]
    [DataRow("WDC5")]
    [DataRow("WDC6")]
    [DataRow("WDB7")]
    public void AcceptsKnownAndFutureVersionedDatabaseMagic(string magic)
    {
        Assert.IsTrue(RawExtractor.IsDbMagic(Encoding.ASCII.GetBytes(magic)));
    }

    [TestMethod]
    [DataRow("HTML")]
    [DataRow("BLTE")]
    [DataRow("WDCX")]
    public void RejectsNonDatabaseMagic(string magic)
    {
        Assert.IsFalse(RawExtractor.IsDbMagic(Encoding.ASCII.GetBytes(magic)));
    }
}
