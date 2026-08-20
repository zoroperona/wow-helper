using System.Text.Json.Serialization;

namespace WowDb.Models;

internal sealed class DbDefinitionManifest
{
    [JsonPropertyName("tableName")]
    public required string TableName { get; init; }

    [JsonPropertyName("tableHash")]
    public required string TableHash { get; init; }

    [JsonPropertyName("db2FileDataID")]
    public uint? Db2FileDataId { get; init; }
}

