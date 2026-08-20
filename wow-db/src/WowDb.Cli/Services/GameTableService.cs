using System.Globalization;

namespace WowDb.Services;

internal sealed record GameTableDefinition(
    string TableName,
    uint FileDataId,
    IReadOnlyList<string> SourceColumns,
    IReadOnlyList<string> SqliteColumns);

internal sealed class GameTableService
{
    private const string SchemaVersion = "gametable-v1";

    internal static readonly IReadOnlyList<GameTableDefinition> Definitions =
    [
        new(
            "CombatRatingsMultByILvl",
            1391670,
            ["Item Level", "Armor Multiplier", "Weapon Multiplier", "Trinket Multiplier", "Jewelry Multiplier"],
            ["ID", "ArmorMultiplier", "WeaponMultiplier", "TrinketMultiplier", "JewelryMultiplier"]),
        new(
            "StaminaMultByILvl",
            1980632,
            ["Item Level", "Armor Multiplier", "Weapon Multiplier", "Trinket Multiplier", "Jewelry Multiplier"],
            ["ID", "ArmorMultiplier", "WeaponMultiplier", "TrinketMultiplier", "JewelryMultiplier"]),
        new(
            "ItemSocketCostPerLevel",
            1391643,
            ["5.0 Level", "Socket Cost"],
            ["ID", "SocketCost"])
    ];

    private readonly SnapshotStateStore store;

    public GameTableService(SnapshotStateStore store) => this.store = store;

    public async Task ExtractAsync(TactClient client, CancellationToken cancellationToken)
    {
        foreach (var definition in Definitions)
        {
            if (!client.FileExists(definition.FileDataId))
                throw new FileNotFoundException($"GameTable {definition.TableName} ({definition.FileDataId}) is not present in the client build.");

            var bytes = client.ReadFile(definition.FileDataId);
            Validate(bytes, definition);
            await AtomicFiles.WriteBytesAsync(store.GameTablePath(definition.TableName), bytes, cancellationToken);
            Console.WriteLine($"[gt ok]    {definition.TableName} ({bytes.LongLength:N0} bytes)");
        }
    }

    public async Task ExportAsync(string build, string locale, CancellationToken cancellationToken)
    {
        await using var writer = new SqliteTableWriter(store.DatabasePath);
        await writer.InitializeAsync(cancellationToken);
        foreach (var definition in Definitions)
        {
            var path = store.GameTablePath(definition.TableName);
            if (!File.Exists(path))
                throw new FileNotFoundException($"Raw GameTable {definition.TableName} is missing; run the raw phase first.", path);

            var rawSha256 = await AtomicFiles.Sha256FileAsync(path, cancellationToken);
            if (await writer.IsCurrentAsync(definition.TableName, build, locale, rawSha256, SchemaVersion, cancellationToken))
            {
                Console.WriteLine($"[gt skip]  {definition.TableName}");
                continue;
            }

            var rows = Parse(path, definition).ToArray();
            var columns = definition.SqliteColumns.Select((name, index) =>
                new ExportColumn(name, index == 0 ? typeof(int) : typeof(double))).ToArray();
            await writer.ReplaceTableAsync(
                definition.TableName,
                columns,
                rows,
                build,
                locale,
                rawSha256,
                SchemaVersion,
                0,
                cancellationToken);
            Console.WriteLine($"[gt sql]   {definition.TableName} ({rows.Length:N0} rows)");
        }
    }

    private static IEnumerable<ExportRow> Parse(string path, GameTableDefinition definition)
    {
        using var reader = new StreamReader(path);
        var header = reader.ReadLine()?.TrimStart('\uFEFF').Split('\t')
            ?? throw new InvalidDataException($"GameTable {definition.TableName} is empty.");
        if (!header.SequenceEqual(definition.SourceColumns))
            throw new InvalidDataException($"GameTable {definition.TableName} has an unexpected header: {string.Join(", ", header)}");

        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
                continue;
            var fields = line.Split('\t');
            if (fields.Length != definition.SourceColumns.Count ||
                !int.TryParse(fields[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var id))
                throw new InvalidDataException($"GameTable {definition.TableName} has an invalid row: {line}");

            var values = new object?[fields.Length];
            values[0] = id;
            for (var index = 1; index < fields.Length; index++)
            {
                if (!double.TryParse(fields[index], NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
                    throw new InvalidDataException($"GameTable {definition.TableName} has an invalid number: {fields[index]}");
                values[index] = value;
            }
            yield return new ExportRow(id, values);
        }
    }

    private static void Validate(byte[] bytes, GameTableDefinition definition)
    {
        if (bytes.Length == 0)
            throw new InvalidDataException($"GameTable {definition.TableName} is empty.");
        using var reader = new StreamReader(new MemoryStream(bytes));
        var header = reader.ReadLine()?.TrimStart('\uFEFF').Split('\t');
        if (header is null || !header.SequenceEqual(definition.SourceColumns))
            throw new InvalidDataException($"GameTable {definition.TableName} has an unexpected format.");
    }
}
