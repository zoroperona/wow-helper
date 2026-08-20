namespace WowDb.Cli;

internal enum CommandKind
{
    Help,
    Doctor,
    Snapshot
}

internal enum SnapshotPhase
{
    All,
    Raw,
    Sqlite
}

internal sealed class CliOptions
{
    public CommandKind Command { get; init; } = CommandKind.Help;
    public string? ClientPath { get; init; }
    public string Product { get; init; } = "wow";
    public string Region { get; init; } = "cn";
    public string Locale { get; init; } = "zhCN";
    public string OutputRoot { get; init; } = Path.GetFullPath("output");
    public string CacheRoot { get; init; } = Path.GetFullPath("cache");
    public SnapshotPhase Phase { get; init; } = SnapshotPhase.All;
    public bool Force { get; init; }
    public bool RefreshMetadata { get; init; }
    public bool Offline { get; init; }
    public bool VerifyExisting { get; init; }
    public string? HotfixPath { get; init; }
    public IReadOnlySet<string> Tables { get; init; } = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
}
