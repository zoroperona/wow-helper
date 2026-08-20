using System.Net.Http.Headers;
using System.Text.Json;
using WowDb.Models;

namespace WowDb.Services;

internal sealed class MetadataService : IDisposable
{
    private const string ReleasesApi = "https://api.github.com/repos/wowdev/WoWDBDefs/releases/latest";
    private const string KeysUrl = "https://raw.githubusercontent.com/wowdev/TACTKeys/master/WoW.txt";
    private readonly HttpClient client = new();

    public MetadataService()
    {
        client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("wow-db", "0.1.1"));
    }

    public async Task<MetadataBundle> PrepareDefinitionsAsync(
        SnapshotStateStore store,
        string cacheRoot,
        bool refresh,
        bool offline,
        CancellationToken cancellationToken)
    {
        var pinnedManifest = Path.Combine(store.MetadataDirectory, "manifest.json");
        var pinnedDefinitions = Path.Combine(store.MetadataDirectory, "all.bdbd");
        var pinnedVersion = Path.Combine(store.MetadataDirectory, "version.txt");
        if (!refresh && File.Exists(pinnedManifest) && File.Exists(pinnedDefinitions) && File.Exists(pinnedVersion))
            return await BundleFromFilesAsync((await File.ReadAllTextAsync(pinnedVersion, cancellationToken)).Trim(), pinnedManifest, pinnedDefinitions, cancellationToken);

        MetadataBundle cachedBundle;
        if (offline)
        {
            cachedBundle = await FindLatestCachedDefinitionsAsync(cacheRoot, cancellationToken)
                ?? throw new FileNotFoundException("No cached WoWDBDefs release is available in offline mode.");
        }
        else
        {
            try
            {
                cachedBundle = await DownloadLatestDefinitionsAsync(cacheRoot, cancellationToken);
            }
            catch (Exception exception) when (!refresh && exception is not OperationCanceledException)
            {
                cachedBundle = await FindLatestCachedDefinitionsAsync(cacheRoot, cancellationToken)
                    ?? throw new InvalidOperationException("Unable to download WoWDBDefs and no cached release is available.", exception);
                Console.WriteLine($"Metadata download failed; using cached WoWDBDefs {cachedBundle.Tag}.");
            }
        }

        await CopyAtomicallyAsync(cachedBundle.ManifestPath, pinnedManifest, cancellationToken);
        await CopyAtomicallyAsync(cachedBundle.DefinitionsPath, pinnedDefinitions, cancellationToken);
        await AtomicFiles.WriteBytesAsync(pinnedVersion, System.Text.Encoding.UTF8.GetBytes(cachedBundle.Tag + Environment.NewLine), cancellationToken);
        var sourceNotice = $"""
            WoWDBDefs release: {cachedBundle.Tag}
            Source: https://github.com/wowdev/WoWDBDefs
            Definitions license: CC BY-SA 4.0
            Code license: BSD-3-Clause
            Retrieved: {DateTimeOffset.UtcNow:O}
            """;
        await AtomicFiles.WriteBytesAsync(
            Path.Combine(store.MetadataDirectory, "SOURCE.txt"),
            System.Text.Encoding.UTF8.GetBytes(sourceNotice + Environment.NewLine),
            cancellationToken);
        return await BundleFromFilesAsync(cachedBundle.Tag, pinnedManifest, pinnedDefinitions, cancellationToken);
    }

    public async Task<(string Path, string Sha256)?> PrepareKeysAsync(string cacheRoot, bool offline, CancellationToken cancellationToken)
    {
        var path = Path.Combine(cacheRoot, "tactkeys", "WoW.txt");
        var shouldRefresh = !offline && (!File.Exists(path) || File.GetLastWriteTimeUtc(path) < DateTime.UtcNow.AddDays(-1));
        if (shouldRefresh)
        {
            try
            {
                var bytes = await client.GetByteArrayAsync(KeysUrl, cancellationToken);
                await AtomicFiles.WriteBytesAsync(path, bytes, cancellationToken);
            }
            catch (Exception exception) when (File.Exists(path) && exception is not OperationCanceledException)
            {
                Console.WriteLine("TACTKeys refresh failed; using cached keys.");
            }
        }

        if (!File.Exists(path))
            return null;
        return (path, await AtomicFiles.Sha256FileAsync(path, cancellationToken));
    }

    private async Task<MetadataBundle> DownloadLatestDefinitionsAsync(string cacheRoot, CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync(ReleasesApi, cancellationToken);
        response.EnsureSuccessStatusCode();
        await using var responseStream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var release = await JsonDocument.ParseAsync(responseStream, cancellationToken: cancellationToken);
        var root = release.RootElement;
        var tag = root.GetProperty("tag_name").GetString() ?? throw new InvalidDataException("WoWDBDefs release has no tag_name.");
        var assets = root.GetProperty("assets").EnumerateArray().ToDictionary(
            asset => asset.GetProperty("name").GetString() ?? string.Empty,
            asset => asset.GetProperty("browser_download_url").GetString() ?? string.Empty,
            StringComparer.OrdinalIgnoreCase);

        if (!assets.TryGetValue("manifest.json", out var manifestUrl) || !assets.TryGetValue("all.bdbd", out var definitionsUrl))
            throw new InvalidDataException($"WoWDBDefs release {tag} is missing required assets.");

        var directory = Path.Combine(cacheRoot, "wowdbdefs", tag);
        var manifestPath = Path.Combine(directory, "manifest.json");
        var definitionsPath = Path.Combine(directory, "all.bdbd");
        if (!File.Exists(manifestPath))
            await AtomicFiles.WriteBytesAsync(manifestPath, await client.GetByteArrayAsync(manifestUrl, cancellationToken), cancellationToken);
        if (!File.Exists(definitionsPath))
            await AtomicFiles.WriteBytesAsync(definitionsPath, await client.GetByteArrayAsync(definitionsUrl, cancellationToken), cancellationToken);

        return await BundleFromFilesAsync(tag, manifestPath, definitionsPath, cancellationToken);
    }

    private static async Task<MetadataBundle?> FindLatestCachedDefinitionsAsync(string cacheRoot, CancellationToken cancellationToken)
    {
        var root = Path.Combine(cacheRoot, "wowdbdefs");
        if (!Directory.Exists(root))
            return null;
        foreach (var directory in Directory.EnumerateDirectories(root).OrderByDescending(Path.GetFileName, StringComparer.Ordinal))
        {
            var manifest = Path.Combine(directory, "manifest.json");
            var definitions = Path.Combine(directory, "all.bdbd");
            if (File.Exists(manifest) && File.Exists(definitions))
                return await BundleFromFilesAsync(Path.GetFileName(directory), manifest, definitions, cancellationToken);
        }
        return null;
    }

    private static async Task<MetadataBundle> BundleFromFilesAsync(string tag, string manifest, string definitions, CancellationToken cancellationToken) =>
        new(tag, manifest, definitions,
            await AtomicFiles.Sha256FileAsync(manifest, cancellationToken),
            await AtomicFiles.Sha256FileAsync(definitions, cancellationToken));

    private static async Task CopyAtomicallyAsync(string source, string destination, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.Read, 1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        var temporaryPath = destination + ".partial";
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        await using (var output = new FileStream(temporaryPath, FileMode.Create, FileAccess.Write, FileShare.None, 1024 * 1024, FileOptions.Asynchronous | FileOptions.WriteThrough))
        {
            await stream.CopyToAsync(output, cancellationToken);
            await output.FlushAsync(cancellationToken);
            output.Flush(flushToDisk: true);
        }
        File.Move(temporaryPath, destination, overwrite: true);
    }

    public void Dispose() => client.Dispose();
}
