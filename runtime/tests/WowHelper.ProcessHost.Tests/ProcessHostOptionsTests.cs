namespace WowHelper.ProcessHost.Tests;

[TestClass]
public sealed class ProcessHostOptionsTests
{
    [TestMethod]
    public void ParsesACompleteInvocation()
    {
        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "wow-helper-runtime"));
        var result = ProcessHostOptions.TryParse(
            [
                "--mutex", "simc",
                "--state", Path.Combine(root, "state.json"),
                "--working-directory", root,
                "--timeout-seconds", "60",
                "--", "simc.exe", "profile.simc", "threads=1",
            ],
            out var options,
            out var error);

        Assert.IsTrue(result, error);
        Assert.IsNotNull(options);
        var parsed = options ?? throw new AssertFailedException("options should not be null");
        Assert.AreEqual("simc", parsed.MutexName);
        Assert.AreEqual(TimeSpan.FromSeconds(60), parsed.Timeout);
        Assert.AreEqual("simc.exe", parsed.Command);
        CollectionAssert.AreEqual(new[] { "profile.simc", "threads=1" }, parsed.CommandArguments.ToArray());
    }

    [TestMethod]
    public void RejectsUnsafeMutexNames()
    {
        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "wow-helper-runtime"));
        var result = ProcessHostOptions.TryParse(
            ["--mutex", "../shared", "--state", Path.Combine(root, "state.json"), "--working-directory", root, "--", "simc.exe"],
            out _,
            out var error);

        Assert.IsFalse(result);
        StringAssert.Contains(error, "mutex");
    }

    [TestMethod]
    public void RejectsOutOfRangeTimeout()
    {
        var root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "wow-helper-runtime"));
        var result = ProcessHostOptions.TryParse(
            ["--mutex", "simc", "--state", Path.Combine(root, "state.json"), "--working-directory", root, "--timeout-seconds", "0", "--", "simc.exe"],
            out _,
            out var error);

        Assert.IsFalse(result);
        StringAssert.Contains(error, "timeout-seconds");
    }
}
