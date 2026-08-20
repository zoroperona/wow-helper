using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace WowHelper.ProcessHost;

internal static class Program
{
    public static int Main(string[] args)
    {
        if (!ProcessHostOptions.TryParse(args, out var options, out var error))
        {
            Console.Error.WriteLine(error);
            return ExitCodes.ConfigurationInvalid;
        }
        if (!OperatingSystem.IsWindows())
        {
            Console.Error.WriteLine("WowHelper.ProcessHost 只允许在 Windows 正式环境运行");
            return ExitCodes.ConfigurationInvalid;
        }
        var parsedOptions = options!;

        try
        {
            using var hostLock = NamedMutexLease.TryAcquire(parsedOptions.MutexName);
            if (hostLock is null)
            {
                Console.Error.WriteLine($"任务锁已占用：{parsedOptions.MutexName}");
                return ExitCodes.LockBusy;
            }

            using var cancellation = new CancellationTokenSource(parsedOptions.Timeout);
            Console.CancelKeyPress += (_, eventArgs) =>
            {
                eventArgs.Cancel = true;
                cancellation.Cancel();
            };
            return RunChildAsync(parsedOptions, cancellation.Token).GetAwaiter().GetResult();
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception);
            return ExitCodes.Unknown;
        }
    }

    private static async Task<int> RunChildAsync(ProcessHostOptions options, CancellationToken cancellationToken)
    {
        var hostStartedAt = Process.GetCurrentProcess().StartTime.ToUniversalTime();
        await ProcessStateWriter.WriteAsync(options.StatePath, new(
            "starting", Environment.ProcessId, hostStartedAt, null, null, null));

        using var job = WindowsJobObject.Create(options.MutexName);
        using var child = new Process
        {
            StartInfo = BuildStartInfo(options),
            EnableRaisingEvents = true,
        };
        if (!child.Start())
        {
            throw new InvalidOperationException("无法启动子进程");
        }

        try
        {
            job.Assign(child);
            var childStartedAt = child.StartTime.ToUniversalTime();
            await ProcessStateWriter.WriteAsync(options.StatePath, new(
                "running", Environment.ProcessId, hostStartedAt, child.Id, childStartedAt, null));

            try
            {
                await child.WaitForExitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                job.Terminate(ExitCodes.TimeoutOrCancelled);
                await child.WaitForExitAsync(CancellationToken.None);
                await ProcessStateWriter.WriteAsync(options.StatePath, new(
                    "cancelled", Environment.ProcessId, hostStartedAt, child.Id, childStartedAt, ExitCodes.TimeoutOrCancelled));
                return ExitCodes.TimeoutOrCancelled;
            }

            await ProcessStateWriter.WriteAsync(options.StatePath, new(
                child.ExitCode == 0 ? "succeeded" : "failed",
                Environment.ProcessId,
                hostStartedAt,
                child.Id,
                childStartedAt,
                child.ExitCode));
            return child.ExitCode;
        }
        catch
        {
            if (!child.HasExited)
            {
                job.Terminate(ExitCodes.Unknown);
                await child.WaitForExitAsync(CancellationToken.None);
            }
            throw;
        }
    }

    private static ProcessStartInfo BuildStartInfo(ProcessHostOptions options)
    {
        var startInfo = new ProcessStartInfo(options.Command)
        {
            UseShellExecute = false,
            WorkingDirectory = options.WorkingDirectory,
        };
        foreach (var argument in options.CommandArguments)
        {
            startInfo.ArgumentList.Add(argument);
        }
        return startInfo;
    }
}

internal sealed record ProcessHostOptions(
    string MutexName,
    string StatePath,
    TimeSpan Timeout,
    string WorkingDirectory,
    string Command,
    IReadOnlyList<string> CommandArguments)
{
    private static readonly Regex SafeName = new("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", RegexOptions.CultureInvariant);

    public static bool TryParse(string[] args, out ProcessHostOptions? options, out string error)
    {
        options = null;
        error = "";
        var separator = Array.IndexOf(args, "--");
        if (separator < 0 || separator == args.Length - 1)
        {
            error = "用法：WowHelper.ProcessHost --mutex <name> --state <absolute.json> --working-directory <absolute-path> [--timeout-seconds <seconds>] -- <command> [args...]";
            return false;
        }

        string? mutex = null;
        string? state = null;
        string? workingDirectory = null;
        var timeoutSeconds = 1800;
        for (var index = 0; index < separator; index++)
        {
            var option = args[index];
            if (index + 1 >= separator)
            {
                error = $"参数缺少值：{option}";
                return false;
            }
            var value = args[++index];
            switch (option)
            {
                case "--mutex": mutex = value; break;
                case "--state": state = value; break;
                case "--working-directory": workingDirectory = value; break;
                case "--timeout-seconds" when int.TryParse(value, out var parsed): timeoutSeconds = parsed; break;
                default:
                    error = $"未知或无效参数：{option}";
                    return false;
            }
        }

        if (mutex is null || !SafeName.IsMatch(mutex))
        {
            error = "mutex 名称只能包含 1-64 位字母、数字、点、下划线或连字符";
            return false;
        }
        if (state is null || !Path.IsPathFullyQualified(state) || !state.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            error = "state 必须是绝对 JSON 路径";
            return false;
        }
        if (workingDirectory is null || !Path.IsPathFullyQualified(workingDirectory))
        {
            error = "working-directory 必须是绝对路径";
            return false;
        }
        if (timeoutSeconds is < 1 or > 43200)
        {
            error = "timeout-seconds 必须在 1-43200 之间";
            return false;
        }

        options = new(
            mutex,
            state,
            TimeSpan.FromSeconds(timeoutSeconds),
            workingDirectory,
            args[separator + 1],
            args[(separator + 2)..]);
        return true;
    }
}

internal static class ExitCodes
{
    internal const int Unknown = 1;
    internal const int ConfigurationInvalid = 40;
    internal const int LockBusy = 50;
    internal const int TimeoutOrCancelled = 60;
}

internal sealed record ProcessState(
    string Status,
    int HostPid,
    DateTime HostStartedAt,
    int? ChildPid,
    DateTime? ChildStartedAt,
    int? ExitCode);

internal static class ProcessStateWriter
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    internal static async Task WriteAsync(string path, ProcessState state)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException("状态路径缺少父目录");
        Directory.CreateDirectory(directory);
        var temporary = $"{path}.{Environment.ProcessId}.tmp";
        var json = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            status = state.Status,
            hostPid = state.HostPid,
            hostStartedAt = state.HostStartedAt,
            childPid = state.ChildPid,
            childStartedAt = state.ChildStartedAt,
            exitCode = state.ExitCode,
            updatedAt = DateTime.UtcNow,
        }, JsonOptions);
        await File.WriteAllTextAsync(temporary, json + Environment.NewLine);
        File.Move(temporary, path, true);
    }
}
