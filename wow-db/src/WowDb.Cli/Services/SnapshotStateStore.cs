using System.Text.Json;
using WowDb.Models;

namespace WowDb.Services;

internal sealed class SnapshotStateStore
{
    private readonly string stateRoot;
    private readonly string snapshotPath;

    public string SnapshotRoot { get; }
    public string RawDirectory { get; }
    public string GameTableDirectory { get; }
    public string MetadataDirectory { get; }
    public string DatabasePath { get; }
    public string HotfixPath => Path.Combine(SnapshotRoot, "raw", "DBCache.bin");

    public SnapshotStateStore(string snapshotRoot)
    {
        SnapshotRoot = snapshotRoot;
        stateRoot = Path.Combine(snapshotRoot, "state", "tables");
        snapshotPath = Path.Combine(snapshotRoot, "snapshot.json");
        RawDirectory = Path.Combine(snapshotRoot, "raw", "db2");
        GameTableDirectory = Path.Combine(snapshotRoot, "raw", "gametables");
        MetadataDirectory = Path.Combine(snapshotRoot, "metadata");
        DatabasePath = Path.Combine(snapshotRoot, "parsed", "wow.sqlite");
    }

    public void EnsureDirectories()
    {
        Directory.CreateDirectory(stateRoot);
        Directory.CreateDirectory(RawDirectory);
        Directory.CreateDirectory(GameTableDirectory);
        Directory.CreateDirectory(MetadataDirectory);
        Directory.CreateDirectory(Path.GetDirectoryName(DatabasePath)!);
        Directory.CreateDirectory(Path.Combine(SnapshotRoot, "logs"));
    }

    public async Task<SnapshotMetadata?> LoadSnapshotAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(snapshotPath))
            return null;
        await using var stream = File.OpenRead(snapshotPath);
        return await JsonSerializer.DeserializeAsync<SnapshotMetadata>(stream, AtomicFiles.JsonOptions, cancellationToken);
    }

    public Task SaveSnapshotAsync(SnapshotMetadata snapshot, CancellationToken cancellationToken)
    {
        snapshot.UpdatedAt = DateTimeOffset.UtcNow;
        return AtomicFiles.WriteJsonAsync(snapshotPath, snapshot, cancellationToken);
    }

    public async Task<TableState> LoadOrCreateTableAsync(DbDefinitionManifest definition, CancellationToken cancellationToken)
    {
        var path = GetTableStatePath(definition);
        if (File.Exists(path))
        {
            await using var stream = File.OpenRead(path);
            var existing = await JsonSerializer.DeserializeAsync<TableState>(stream, AtomicFiles.JsonOptions, cancellationToken);
            if (existing is not null)
                return existing;
        }

        return new TableState
        {
            TableName = definition.TableName,
            TableHash = definition.TableHash,
            FileDataId = definition.Db2FileDataId,
            RawStatus = definition.Db2FileDataId.HasValue ? TableStatus.Pending : TableStatus.NotAddressable,
            SqliteStatus = definition.Db2FileDataId.HasValue ? TableStatus.Pending : TableStatus.NotAddressable
        };
    }

    public Task SaveTableAsync(TableState table, CancellationToken cancellationToken) =>
        AtomicFiles.WriteJsonAsync(GetTableStatePath(table.FileDataId, table.TableName), table, cancellationToken);

    public string RawPath(string tableName) => Path.Combine(RawDirectory, tableName + ".db2");

    public string GameTablePath(string tableName) => Path.Combine(GameTableDirectory, tableName + ".txt");

    private string GetTableStatePath(DbDefinitionManifest definition) => GetTableStatePath(definition.Db2FileDataId, definition.TableName);

    private string GetTableStatePath(uint? fileDataId, string tableName)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var safeName = new string(tableName.Select(character => invalid.Contains(character) ? '_' : character).ToArray());
        return Path.Combine(stateRoot, $"{fileDataId?.ToString() ?? "no-fdid"}-{safeName}.json");
    }
}
