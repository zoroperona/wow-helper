using System.Diagnostics;

namespace WowHelper.ProcessHost.Tests;

[TestClass]
public sealed class WindowsProcessControlTests
{
    [TestMethod]
    public async Task NamedMutexRejectsASecondThread()
    {
        var name = $"mutex-test-{Guid.NewGuid():N}";
        using var first = NamedMutexLease.TryAcquire(name);
        Assert.IsNotNull(first);

        var secondAcquired = await Task.Run(() =>
        {
            using var second = NamedMutexLease.TryAcquire(name);
            return second is not null;
        });

        Assert.IsFalse(secondAcquired);
    }

    [TestMethod]
    public void JobObjectTerminatesAChildProcess()
    {
        using var process = Process.Start(new ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = "/d /c ping 127.0.0.1 -n 30 >NUL",
            UseShellExecute = false,
            CreateNoWindow = true,
        });
        Assert.IsNotNull(process);
        using var job = WindowsJobObject.Create($"job-test-{Guid.NewGuid():N}");
        job.Assign(process);

        job.Terminate(60);

        Assert.IsTrue(process.WaitForExit(5_000), "Job Object 终止后子进程仍在运行");
        Assert.AreNotEqual(0, process.ExitCode);
    }
}
