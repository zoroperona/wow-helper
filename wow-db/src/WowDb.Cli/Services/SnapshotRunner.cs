using System.Reflection;
using System.Text.Json;
using WowDb.Cli;
using WowDb.Models;

namespace WowDb.Services;

internal sealed class SnapshotRunner(CliOptions options)
{
    public async Task<SnapshotResult> RunAsync(CancellationToken cancellationToken)
    {
        var clientRoot = BuildInfoReader.ResolveClientRoot(options.ClientPath!);
        var products = BuildInfoReader.Read(clientRoot);
        var product = products
            .Where(item => item.Product.Equals(options.Product, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(item => item.Active)
            .FirstOrDefault()
            ?? throw new ArgumentException($"Product {options.Product} is not installed. Available: {string.Join(", ", products.Select(item => item.Product).Distinct())}");

        if (string.IsNullOrWhiteSpace(product.Version))
            throw new InvalidDataException($"Product {product.Product} has no version in .build.info.");
        if (product.BuildConfig.Length != 32 || product.CdnConfig.Length != 32)
            throw new InvalidDataException($"Product {product.Product} has invalid build/CDN keys in .build.info.");

        _ = TactClient.ParseLocale(options.Locale);
        _ = DbcParserService.ParseLocale(options.Locale);

        var snapshotRoot = Path.Combine(
            options.OutputRoot,
            SafeSegment(product.Product),
            SafeSegment(product.Version),
            SafeSegment(options.Region + "-" + options.Locale));
        var store = new SnapshotStateStore(snapshotRoot);
        store.EnsureDirectories();
        var existingSnapshot = await store.LoadSnapshotAsync(cancellationToken);
        if (existingSnapshot is not null)
            ValidateExistingSnapshot(existingSnapshot, product, options);
        var hotfixSource = options.HotfixPath;
        if (hotfixSource is null && existingSnapshot?.HotfixSha256 is not null)
        {
            if (!File.Exists(store.HotfixPath))
                throw new FileNotFoundException("Existing snapshot requires its DBCache.bin, but the cached file is missing.", store.HotfixPath);
            hotfixSource = store.HotfixPath;
        }
        var hotfix = await HotfixService.PrepareAsync(hotfixSource, store, product.Version, cancellationToken);

        using var metadataService = new MetadataService();
        var metadata = await metadataService.PrepareDefinitionsAsync(
            store,
            options.CacheRoot,
            options.RefreshMetadata,
            options.Offline,
            cancellationToken);
        var keys = await metadataService.PrepareKeysAsync(options.CacheRoot, options.Offline, cancellationToken);

        var toolVersion = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.2.0";
        var snapshot = existingSnapshot ?? new SnapshotMetadata
        {
            ToolVersion = toolVersion,
            Product = product.Product,
            Build = product.Version,
            Branch = product.Branch,
            Region = options.Region,
            Locale = options.Locale,
            ClientPath = clientRoot,
            BuildConfig = product.BuildConfig,
            CdnConfig = product.CdnConfig,
            DefinitionsTag = metadata.Tag,
            DefinitionsSha256 = metadata.DefinitionsSha256,
            DefinitionsManifestSha256 = metadata.ManifestSha256
        };
        snapshot.ToolVersion = toolVersion;
        snapshot.DefinitionsTag = metadata.Tag;
        snapshot.DefinitionsSha256 = metadata.DefinitionsSha256;
        snapshot.DefinitionsManifestSha256 = metadata.ManifestSha256;
        snapshot.TactKeysSha256 = keys?.Sha256;
        snapshot.HotfixBuild = hotfix?.Build;
        snapshot.HotfixFormatVersion = hotfix?.FormatVersion;
        snapshot.HotfixSha256 = hotfix?.Sha256;
        snapshot.CompletedAt = null;
        await store.SaveSnapshotAsync(snapshot, cancellationToken);

        var definitions = await ReadManifestAsync(metadata.ManifestPath, cancellationToken);
        var selected = SelectDefinitions(definitions, options.Tables);
        Console.WriteLine($"Snapshot: {snapshotRoot}");
        Console.WriteLine($"Tables: {selected.Count:N0}; WoWDBDefs: {metadata.Tag}; phase: {options.Phase.ToString().ToLowerInvariant()}");

        var states = new List<TableState>(selected.Count);
        foreach (var definition in selected)
        {
            var state = await store.LoadOrCreateTableAsync(definition, cancellationToken);
            if (!definition.Db2FileDataId.HasValue)
                await store.SaveTableAsync(state, cancellationToken);
            states.Add(state);
        }

        var tactClient = new Lazy<TactClient>(() => new TactClient(
            clientRoot,
            product,
            options.Region,
            options.Locale,
            options.CacheRoot,
            options.Offline,
            keys?.Path));
        var gameTables = new GameTableService(store);

        if (options.Phase is SnapshotPhase.All or SnapshotPhase.Raw)
        {
            var extractor = new RawExtractor(store, tactClient, options.Force, options.VerifyExisting);
            foreach (var state in states)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await extractor.ExtractAsync(state, cancellationToken);
            }
            await gameTables.ExtractAsync(tactClient.Value, cancellationToken);
        }
        else
        {
            var adopter = new RawExtractor(
                store,
                new Lazy<TactClient>(() => throw new InvalidOperationException("CASC is unavailable in sqlite-only mode.")),
                force: false,
                options.VerifyExisting);
            foreach (var state in states)
                await adopter.AdoptExistingAsync(state, cancellationToken);
        }

        if (options.Phase is SnapshotPhase.All or SnapshotPhase.Sqlite)
        {
            {
                await using var parser = new DbcParserService(
                    store,
                    metadata.DefinitionsPath,
                    metadata.DefinitionsSha256,
                    product.Version,
                    options.Locale,
                    hotfix?.Path,
                    hotfix?.Sha256);
                await parser.InitializeAsync(cancellationToken);
                var index = 0;
                foreach (var state in states)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    await parser.ExportAsync(state, options.Force, cancellationToken);
                    if (++index % 50 == 0)
                        GC.Collect(2, GCCollectionMode.Optimized, blocking: false);
                }
            }
            await gameTables.ExportAsync(product.Version, options.Locale, cancellationToken);
        }

        bool IsFailure(TableState state) => options.Phase switch
        {
            SnapshotPhase.Raw => state.RawStatus == TableStatus.Failed,
            SnapshotPhase.Sqlite => state.RawStatus == TableStatus.Failed || state.SqliteStatus == TableStatus.Failed,
            _ => state.RawStatus == TableStatus.Failed || state.SqliteStatus == TableStatus.Failed
        };
        var result = new SnapshotResult(
            options.Phase.ToString().ToLowerInvariant(),
            states.Count,
            states.Count(state => state.RawStatus == TableStatus.Extracted),
            states.Count(state => state.SqliteStatus == TableStatus.Exported),
            states.Count(IsFailure),
            states.Count(state => state.RawStatus == TableStatus.NotAddressable),
            states.Count(state => state.RawStatus == TableStatus.NotPresent),
            states
                .Where(IsFailure)
                .Select(state => new TableFailure(state.TableName, state.RawStatus, state.SqliteStatus, state.Error))
                .ToArray(),
            states.Where(state => state.RawStatus == TableStatus.NotAddressable).Select(state => state.TableName).ToArray(),
            states.Where(state => state.RawStatus == TableStatus.NotPresent).Select(state => state.TableName).ToArray(),
            hotfix?.Build,
            hotfix?.FormatVersion,
            hotfix?.Sha256);
        snapshot.CompletedAt = DateTimeOffset.UtcNow;
        await store.SaveSnapshotAsync(snapshot, cancellationToken);
        await AtomicFiles.WriteJsonAsync(Path.Combine(snapshotRoot, "report.json"), result, cancellationToken);
        return result;
    }

    private static async Task<List<DbDefinitionManifest>> ReadManifestAsync(string path, CancellationToken cancellationToken)
    {
        await using var stream = File.OpenRead(path);
        return await JsonSerializer.DeserializeAsync<List<DbDefinitionManifest>>(stream, cancellationToken: cancellationToken)
            ?? throw new InvalidDataException($"Unable to parse {path}");
    }

    private static List<DbDefinitionManifest> SelectDefinitions(
        IReadOnlyList<DbDefinitionManifest> definitions,
        IReadOnlySet<string> requested)
    {
        if (requested.Count == 0)
            return definitions.OrderBy(item => item.TableName, StringComparer.OrdinalIgnoreCase).ToList();
        var selected = definitions.Where(item => requested.Contains(item.TableName)).OrderBy(item => item.TableName, StringComparer.OrdinalIgnoreCase).ToList();
        var missing = requested.Except(selected.Select(item => item.TableName), StringComparer.OrdinalIgnoreCase).ToArray();
        if (missing.Length > 0)
            throw new ArgumentException($"Unknown table(s): {string.Join(", ", missing)}");
        return selected;
    }

    private static string SafeSegment(string value)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var safe = new string(value.Select(character => invalid.Contains(character) ? '_' : character).ToArray()).Trim();
        if (safe.Length == 0 || safe is "." or "..")
            throw new InvalidDataException($"Unsafe output path segment: {value}");
        return safe;
    }

    private static void ValidateExistingSnapshot(SnapshotMetadata snapshot, BuildProductInfo product, CliOptions current)
    {
        if (!snapshot.Product.Equals(product.Product, StringComparison.OrdinalIgnoreCase) ||
            !snapshot.Build.Equals(product.Version, StringComparison.OrdinalIgnoreCase) ||
            !snapshot.Region.Equals(current.Region, StringComparison.OrdinalIgnoreCase) ||
            !snapshot.Locale.Equals(current.Locale, StringComparison.OrdinalIgnoreCase) ||
            !snapshot.BuildConfig.Equals(product.BuildConfig, StringComparison.OrdinalIgnoreCase) ||
            !snapshot.CdnConfig.Equals(product.CdnConfig, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("Existing snapshot identity does not match the selected client build. Use a different output root instead of mixing snapshots.");
        }
    }
}
