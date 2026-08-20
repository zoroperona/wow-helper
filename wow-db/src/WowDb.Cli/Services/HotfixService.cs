using DBCD.IO;

namespace WowDb.Services;

internal sealed record HotfixBundle(string Path, string Build, string Sha256, int FormatVersion);

internal static class HotfixService
{
    public static async Task<HotfixBundle?> PrepareAsync(
        string? sourcePath,
        SnapshotStateStore store,
        string clientBuild,
        CancellationToken cancellationToken)
    {
        if (sourcePath is null)
            return null;
        if (!File.Exists(sourcePath))
            throw new FileNotFoundException("Hotfix cache was not found.", sourcePath);

        HotfixReader reader;
        try
        {
            reader = new HotfixReader(sourcePath);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            throw new InvalidDataException($"Unable to parse hotfix cache: {exception.GetBaseException().Message}", exception);
        }

        var expectedBuild = ParseBuildNumber(clientBuild);
        if (reader.BuildId != expectedBuild)
            throw new InvalidDataException($"Hotfix build {reader.BuildId} does not match client build {expectedBuild}.");

        var sha256 = await AtomicFiles.Sha256FileAsync(sourcePath, cancellationToken);
        if (!Path.GetFullPath(sourcePath).Equals(Path.GetFullPath(store.HotfixPath), StringComparison.OrdinalIgnoreCase))
        {
            var bytes = await File.ReadAllBytesAsync(sourcePath, cancellationToken);
            await AtomicFiles.WriteBytesAsync(store.HotfixPath, bytes, cancellationToken);
        }

        return new HotfixBundle(store.HotfixPath, reader.BuildId.ToString(), sha256, reader.Version);
    }

    internal static int ParseBuildNumber(string build)
    {
        var segment = build.Split('.').LastOrDefault();
        return int.TryParse(segment, out var value)
            ? value
            : throw new InvalidDataException($"Unable to read build number from {build}.");
    }
}
