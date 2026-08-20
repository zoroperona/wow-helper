using DBCD;
using DBCD.IO;
using DBCD.Providers;
using WowDb.Models;

namespace WowDb.Services;

internal sealed class DbcParserService : IAsyncDisposable
{
    private readonly SnapshotStateStore store;
    private readonly string build;
    private readonly string locale;
    private readonly string definitionsSha256;
    private readonly string? hotfixSha256;
    private readonly HotfixReader? hotfixReader;
    private readonly DBCD.DBCD dbcd;
    private readonly SqliteTableWriter writer;

    public DbcParserService(
        SnapshotStateStore store,
        string definitionsPath,
        string definitionsSha256,
        string build,
        string locale,
        string? hotfixPath = null,
        string? hotfixSha256 = null)
    {
        this.store = store;
        this.build = build;
        this.locale = locale;
        this.definitionsSha256 = definitionsSha256;
        this.hotfixSha256 = hotfixSha256;
        if (hotfixPath is not null)
            hotfixReader = new HotfixReader(hotfixPath);
        using var definitions = File.OpenRead(definitionsPath);
        dbcd = new DBCD.DBCD(new FilesystemDBCProvider(store.RawDirectory), definitions);
        writer = new SqliteTableWriter(store.DatabasePath);
    }

    public Task InitializeAsync(CancellationToken cancellationToken) => writer.InitializeAsync(cancellationToken);

    public async Task ExportAsync(TableState table, bool force, CancellationToken cancellationToken)
    {
        if (table.RawStatus != TableStatus.Extracted || string.IsNullOrWhiteSpace(table.RawSha256))
        {
            if (table.RawStatus is TableStatus.NotAddressable or TableStatus.NotPresent)
                table.SqliteStatus = table.RawStatus;
            else if (table.RawStatus == TableStatus.Failed)
                table.SqliteStatus = TableStatus.Skipped;
            else
            {
                table.SqliteStatus = TableStatus.Failed;
                table.Error = "Raw DB2 is not available; run the raw phase first.";
                Console.WriteLine($"[sql fail] {table.TableName}: {table.Error}");
            }
            await store.SaveTableAsync(table, cancellationToken);
            return;
        }

        if (!force && await writer.IsCurrentAsync(table.TableName, build, locale, table.RawSha256, definitionsSha256, cancellationToken, hotfixSha256))
        {
            table.SqliteStatus = TableStatus.Exported;
            table.ParsedRawSha256 = table.RawSha256;
            table.ParsedDefinitionsSha256 = definitionsSha256;
            table.ParsedHotfixSha256 = hotfixSha256;
            table.Error = null;
            Console.WriteLine($"[sql skip] {table.TableName}");
            await store.SaveTableAsync(table, cancellationToken);
            return;
        }

        table.ParseAttempts++;
        table.Error = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var storage = dbcd.Load(table.TableName, build, ParseLocale(locale));
            if (hotfixReader is not null)
                storage.ApplyingHotfixes(hotfixReader);
            var rowType = storage.GetType().GetGenericArguments().Single();
            var columns = storage.AvailableColumns.Select(name =>
            {
                var field = rowType.GetField(name) ?? throw new InvalidDataException($"DBCD did not expose field {table.TableName}.{name}.");
                return new ExportColumn(name, field.FieldType);
            }).ToArray();

            IEnumerable<ExportRow> Rows()
            {
                foreach (var pair in ((IDictionary<int, DBCDRow>)storage).OrderBy(item => item.Key))
                {
                    object?[] values = columns.Select(column => pair.Value[column.Name]).ToArray();
                    yield return new ExportRow(pair.Key, values);
                }
            }

            var count = await writer.ReplaceTableAsync(
                table.TableName,
                columns,
                Rows(),
                build,
                locale,
                table.RawSha256,
                definitionsSha256,
                storage.LayoutHash,
                cancellationToken,
                hotfixSha256);

            table.SqliteStatus = TableStatus.Exported;
            table.RowCount = count;
            table.ParsedRawSha256 = table.RawSha256;
            table.ParsedDefinitionsSha256 = definitionsSha256;
            table.ParsedHotfixSha256 = hotfixSha256;
            table.SqliteCompletedAt = DateTimeOffset.UtcNow;
            Console.WriteLine($"[sql ok]   {table.TableName} ({count:N0} rows)");
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            table.SqliteStatus = TableStatus.Failed;
            table.Error = RawExtractor.CompactError(exception);
            Console.WriteLine($"[sql fail] {table.TableName}: {table.Error}");
        }
        finally
        {
            await store.SaveTableAsync(table, CancellationToken.None);
        }
    }

    internal static Locale ParseLocale(string value) => value.ToLowerInvariant() switch
    {
        "enus" or "engb" => Locale.EnUS,
        "kokr" => Locale.KoKR,
        "frfr" => Locale.FrFR,
        "dede" => Locale.DeDE,
        "zhcn" => Locale.ZhCN,
        "zhtw" => Locale.ZhTW,
        "eses" => Locale.EsES,
        "esmx" => Locale.EsMX,
        "ruru" => Locale.RuRU,
        "ptbr" or "ptpt" => Locale.PtBR,
        "itit" => Locale.ItIT,
        _ => throw new ArgumentException($"Unsupported locale: {value}")
    };

    public async ValueTask DisposeAsync() => await writer.DisposeAsync();
}
