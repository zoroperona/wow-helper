using System.Text.Json.Serialization;

namespace WowDb.Models;

[JsonConverter(typeof(JsonStringEnumConverter<TableStatus>))]
internal enum TableStatus
{
    Pending,
    Extracted,
    Exported,
    Skipped,
    NotAddressable,
    NotPresent,
    Failed
}

internal sealed class SnapshotMetadata
{
    public int SchemaVersion { get; init; } = 1;
    public required string ToolVersion { get; set; }
    public required string Product { get; init; }
    public required string Build { get; init; }
    public required string Branch { get; init; }
    public required string Region { get; init; }
    public required string Locale { get; init; }
    public required string ClientPath { get; init; }
    public required string BuildConfig { get; init; }
    public required string CdnConfig { get; init; }
    public required string DefinitionsTag { get; set; }
    public required string DefinitionsSha256 { get; set; }
    public required string DefinitionsManifestSha256 { get; set; }
    public string? TactKeysSha256 { get; set; }
    public string? HotfixBuild { get; set; }
    public int? HotfixFormatVersion { get; set; }
    public string? HotfixSha256 { get; set; }
    public DateTimeOffset StartedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? CompletedAt { get; set; }
}

internal sealed class TableState
{
    public required string TableName { get; init; }
    public required string TableHash { get; init; }
    public uint? FileDataId { get; init; }
    public TableStatus RawStatus { get; set; } = TableStatus.Pending;
    public long? RawBytes { get; set; }
    public string? RawSha256 { get; set; }
    public int RawAttempts { get; set; }
    public DateTimeOffset? RawCompletedAt { get; set; }
    public TableStatus SqliteStatus { get; set; } = TableStatus.Pending;
    public long? RowCount { get; set; }
    public string? ParsedRawSha256 { get; set; }
    public string? ParsedDefinitionsSha256 { get; set; }
    public string? ParsedHotfixSha256 { get; set; }
    public int ParseAttempts { get; set; }
    public DateTimeOffset? SqliteCompletedAt { get; set; }
    public string? Error { get; set; }
}

internal sealed record MetadataBundle(
    string Tag,
    string ManifestPath,
    string DefinitionsPath,
    string ManifestSha256,
    string DefinitionsSha256);

internal sealed record TableFailure(string TableName, TableStatus RawStatus, TableStatus SqliteStatus, string? Error);

internal sealed record SnapshotResult(
    string Phase,
    int Total,
    int Extracted,
    int Exported,
    int Failed,
    int NotAddressable,
    int NotPresent,
    IReadOnlyList<TableFailure> Failures,
    IReadOnlyList<string> NotAddressableTables,
    IReadOnlyList<string> NotPresentTables,
    string? HotfixBuild = null,
    int? HotfixFormatVersion = null,
    string? HotfixSha256 = null);
