using WowDb.Services;

namespace WowDb.Tests;

[TestClass]
public sealed class BuildInfoReaderTests
{
    [TestMethod]
    public void ReadsNamedColumnsWithoutDependingOnColumnOrder()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            File.WriteAllText(Path.Combine(root, ".build.info"), """
                Product!STRING:0|Version!STRING:0|CDN Path!STRING:0|Build Key!HEX:16|Active!DEC:1|CDN Key!HEX:16|Branch!STRING:0|CDN Hosts!STRING:0
                wow|12.1.0.69299|tpr/wow|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|1|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|wow|cdn1.example cdn2.example

                """);
            var flavor = Path.Combine(root, "_retail_");
            Directory.CreateDirectory(flavor);
            File.WriteAllText(Path.Combine(flavor, ".flavor.info"), "Product\nwow\n");

            var product = BuildInfoReader.Read(root).Single();

            Assert.AreEqual("wow", product.Product);
            Assert.AreEqual("12.1.0.69299", product.Version);
            Assert.AreEqual("_retail_", product.Folder);
            Assert.AreEqual(2, product.CdnHosts.Count);
            Assert.IsTrue(product.Active);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [TestMethod]
    public void ResolvesRootFromProductSubdirectory()
    {
        var root = CreateTemporaryDirectory();
        try
        {
            File.WriteAllText(Path.Combine(root, ".build.info"), "header\n");
            var product = Path.Combine(root, "_retail_");
            Directory.CreateDirectory(product);

            Assert.AreEqual(root, BuildInfoReader.ResolveClientRoot(product));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static string CreateTemporaryDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "wow-db-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}

