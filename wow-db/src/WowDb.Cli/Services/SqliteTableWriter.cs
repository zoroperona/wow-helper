using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace WowDb.Services;

internal sealed record ExportColumn(string Name, Type Type);
internal sealed record ExportRow(long Id, IReadOnlyList<object?> Values);

internal sealed class SqliteTableWriter(string databasePath) : IAsyncDisposable
{
    private readonly SqliteConnection connection = new(new SqliteConnectionStringBuilder
    {
        DataSource = databasePath,
        Mode = SqliteOpenMode.ReadWriteCreate,
        Cache = SqliteCacheMode.Private,
        Pooling = false
    }.ToString());

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(databasePath)!);
        await connection.OpenAsync(cancellationToken);
        await ExecuteAsync("PRAGMA journal_mode=WAL;", cancellationToken);
        await ExecuteAsync("PRAGMA synchronous=NORMAL;", cancellationToken);
        await ExecuteAsync("PRAGMA temp_store=FILE;", cancellationToken);
        await ExecuteAsync("""
            CREATE TABLE IF NOT EXISTS "__wowdb_tables" (
                "table_name" TEXT PRIMARY KEY,
                "build" TEXT NOT NULL,
                "locale" TEXT NOT NULL,
                "raw_sha256" TEXT NOT NULL,
                "definitions_sha256" TEXT NOT NULL,
                "layout_hash" TEXT NOT NULL,
                "row_count" INTEGER NOT NULL,
                "completed_at" TEXT NOT NULL,
                "hotfix_sha256" TEXT
            );
            """, cancellationToken);
        try
        {
            await ExecuteAsync("ALTER TABLE \"__wowdb_tables\" ADD COLUMN \"hotfix_sha256\" TEXT;", cancellationToken);
        }
        catch (SqliteException exception) when (exception.Message.Contains("duplicate column", StringComparison.OrdinalIgnoreCase))
        {
            // Existing snapshots created before hotfix support.
        }
    }

    public async Task<bool> IsCurrentAsync(string tableName, string build, string locale, string rawSha256, string definitionsSha256, CancellationToken cancellationToken, string? hotfixSha256 = null)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT 1 FROM "__wowdb_tables"
            WHERE "table_name" = $table AND "build" = $build AND "locale" = $locale
              AND "raw_sha256" = $raw AND "definitions_sha256" = $definitions
              AND ("hotfix_sha256" = $hotfix OR ("hotfix_sha256" IS NULL AND $hotfix IS NULL))
              AND EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = $table)
            LIMIT 1;
            """;
        command.Parameters.AddWithValue("$table", tableName);
        command.Parameters.AddWithValue("$build", build);
        command.Parameters.AddWithValue("$locale", locale);
        command.Parameters.AddWithValue("$raw", rawSha256);
        command.Parameters.AddWithValue("$definitions", definitionsSha256);
        command.Parameters.AddWithValue("$hotfix", (object?)hotfixSha256 ?? DBNull.Value);
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    public async Task<long> ReplaceTableAsync(
        string tableName,
        IReadOnlyList<ExportColumn> columns,
        IEnumerable<ExportRow> rows,
        string build,
        string locale,
        string rawSha256,
        string definitionsSha256,
        uint layoutHash,
        CancellationToken cancellationToken,
        string? hotfixSha256 = null)
    {
        var stagingName = "__wowdb_stage_" + Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(tableName)))[..16];
        var idName = "__id";
        while (columns.Any(column => column.Name.Equals(idName, StringComparison.OrdinalIgnoreCase)))
            idName = "_" + idName;

        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await ExecuteAsync($"DROP TABLE IF EXISTS {Quote(stagingName)};", transaction, cancellationToken);
        var columnSql = string.Join(", ", columns.Select(column => $"{Quote(column.Name)} {SqlType(column.Type)}"));
        await ExecuteAsync($"CREATE TABLE {Quote(stagingName)} ({Quote(idName)} INTEGER PRIMARY KEY{(columns.Count > 0 ? ", " + columnSql : string.Empty)});", transaction, cancellationToken);

        await using var insert = connection.CreateCommand();
        insert.Transaction = (SqliteTransaction)transaction;
        var parameterNames = Enumerable.Range(0, columns.Count + 1).Select(index => "$p" + index).ToArray();
        insert.CommandText = $"INSERT INTO {Quote(stagingName)} VALUES ({string.Join(",", parameterNames)});";
        foreach (var parameterName in parameterNames)
            insert.Parameters.Add(new SqliteParameter(parameterName, null));
        insert.Prepare();

        long count = 0;
        foreach (var row in rows)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (row.Values.Count != columns.Count)
                throw new InvalidDataException($"Row {row.Id} in {tableName} has {row.Values.Count} values; expected {columns.Count}.");
            insert.Parameters[0].Value = row.Id;
            for (var index = 0; index < columns.Count; index++)
                insert.Parameters[index + 1].Value = ToSqliteValue(row.Values[index], columns[index].Type);
            await insert.ExecuteNonQueryAsync(cancellationToken);
            count++;
        }

        await ExecuteAsync($"DROP TABLE IF EXISTS {Quote(tableName)};", transaction, cancellationToken);
        await ExecuteAsync($"ALTER TABLE {Quote(stagingName)} RENAME TO {Quote(tableName)};", transaction, cancellationToken);

        await using var registry = connection.CreateCommand();
        registry.Transaction = (SqliteTransaction)transaction;
        registry.CommandText = """
            INSERT INTO "__wowdb_tables"
              ("table_name", "build", "locale", "raw_sha256", "definitions_sha256", "layout_hash", "row_count", "completed_at", "hotfix_sha256")
            VALUES ($table, $build, $locale, $raw, $definitions, $layout, $count, $completed, $hotfix)
            ON CONFLICT("table_name") DO UPDATE SET
              "build"=excluded."build", "locale"=excluded."locale", "raw_sha256"=excluded."raw_sha256",
              "definitions_sha256"=excluded."definitions_sha256", "layout_hash"=excluded."layout_hash",
              "row_count"=excluded."row_count", "completed_at"=excluded."completed_at", "hotfix_sha256"=excluded."hotfix_sha256";
            """;
        registry.Parameters.AddWithValue("$table", tableName);
        registry.Parameters.AddWithValue("$build", build);
        registry.Parameters.AddWithValue("$locale", locale);
        registry.Parameters.AddWithValue("$raw", rawSha256);
        registry.Parameters.AddWithValue("$definitions", definitionsSha256);
        registry.Parameters.AddWithValue("$layout", layoutHash.ToString("X8", CultureInfo.InvariantCulture));
        registry.Parameters.AddWithValue("$count", count);
        registry.Parameters.AddWithValue("$completed", DateTimeOffset.UtcNow.ToString("O", CultureInfo.InvariantCulture));
        registry.Parameters.AddWithValue("$hotfix", (object?)hotfixSha256 ?? DBNull.Value);
        await registry.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return count;
    }

    private async Task ExecuteAsync(string sql, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task ExecuteAsync(string sql, System.Data.Common.DbTransaction transaction, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = (SqliteTransaction)transaction;
        command.CommandText = sql;
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static string Quote(string identifier) => '"' + identifier.Replace("\"", "\"\"") + '"';

    private static string SqlType(Type type)
    {
        type = Nullable.GetUnderlyingType(type) ?? type;
        if (type.IsArray || type == typeof(string) || type == typeof(char) || type == typeof(ulong) || type == typeof(decimal))
            return "TEXT";
        if (type == typeof(float) || type == typeof(double))
            return "REAL";
        if (type.IsEnum || type == typeof(bool) || type == typeof(byte) || type == typeof(sbyte) ||
            type == typeof(short) || type == typeof(ushort) || type == typeof(int) || type == typeof(uint) || type == typeof(long))
            return "INTEGER";
        return "TEXT";
    }

    private static object ToSqliteValue(object? value, Type declaredType)
    {
        if (value is null)
            return DBNull.Value;
        var type = Nullable.GetUnderlyingType(declaredType) ?? declaredType;
        if (type.IsArray)
            return JsonSerializer.Serialize(value, type);
        if (type.IsEnum)
            return Convert.ToInt64(value, CultureInfo.InvariantCulture);
        if (type == typeof(bool))
            return (bool)value ? 1L : 0L;
        if (type == typeof(ulong) || type == typeof(decimal))
            return Convert.ToString(value, CultureInfo.InvariantCulture) ?? string.Empty;
        if (type == typeof(uint) || type == typeof(ushort) || type == typeof(byte))
            return Convert.ToInt64(value, CultureInfo.InvariantCulture);
        return value;
    }

    public async ValueTask DisposeAsync() => await connection.DisposeAsync();
}
