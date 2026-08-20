using WowDb.Models;

namespace WowDb.Services;

internal sealed class RawExtractor(
    SnapshotStateStore store,
    Lazy<TactClient> client,
    bool force,
    bool verifyExisting)
{
    public async Task<bool> AdoptExistingAsync(TableState table, CancellationToken cancellationToken)
    {
        if (!table.FileDataId.HasValue)
        {
            table.RawStatus = TableStatus.NotAddressable;
            table.SqliteStatus = TableStatus.NotAddressable;
            await store.SaveTableAsync(table, cancellationToken);
            return false;
        }

        var adopted = !force && await TryAdoptExistingAsync(table, store.RawPath(table.TableName), cancellationToken);
        if (adopted)
            await store.SaveTableAsync(table, cancellationToken);
        return adopted;
    }

    public async Task ExtractAsync(TableState table, CancellationToken cancellationToken)
    {
        if (!table.FileDataId.HasValue)
        {
            table.RawStatus = TableStatus.NotAddressable;
            table.SqliteStatus = TableStatus.NotAddressable;
            await store.SaveTableAsync(table, cancellationToken);
            return;
        }

        var rawPath = store.RawPath(table.TableName);
        if (await AdoptExistingAsync(table, cancellationToken))
        {
            Console.WriteLine($"[raw skip] {table.TableName}");
            return;
        }

        cancellationToken.ThrowIfCancellationRequested();
        if (!client.Value.FileExists(table.FileDataId.Value))
        {
            table.RawStatus = TableStatus.NotPresent;
            table.SqliteStatus = TableStatus.NotPresent;
            table.RawBytes = null;
            table.RawSha256 = null;
            table.RawCompletedAt = DateTimeOffset.UtcNow;
            table.Error = null;
            Console.WriteLine($"[raw absent] {table.TableName}");
            await store.SaveTableAsync(table, cancellationToken);
            return;
        }

        table.RawAttempts++;
        table.Error = null;
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            var bytes = client.Value.ReadFile(table.FileDataId.Value);
            ValidateDbFile(bytes, table.TableName);
            await AtomicFiles.WriteBytesAsync(rawPath, bytes, cancellationToken);
            table.RawStatus = TableStatus.Extracted;
            table.RawBytes = bytes.LongLength;
            table.RawSha256 = AtomicFiles.Sha256(bytes);
            table.RawCompletedAt = DateTimeOffset.UtcNow;
            Console.WriteLine($"[raw ok]   {table.TableName} ({bytes.LongLength:N0} bytes)");
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception exception)
        {
            table.RawStatus = TableStatus.Failed;
            table.Error = CompactError(exception);
            Console.WriteLine($"[raw fail] {table.TableName}: {table.Error}");
        }
        finally
        {
            await store.SaveTableAsync(table, CancellationToken.None);
        }
    }

    private async Task<bool> TryAdoptExistingAsync(TableState table, string rawPath, CancellationToken cancellationToken)
    {
        if (!File.Exists(rawPath))
            return false;
        var info = new FileInfo(rawPath);
        if (info.Length <= 4 || !HasDbMagic(rawPath))
            return false;
        if (table.RawStatus == TableStatus.Extracted && table.RawBytes == info.Length && !verifyExisting)
            return true;

        var hash = await AtomicFiles.Sha256FileAsync(rawPath, cancellationToken);
        if (table.RawStatus == TableStatus.Extracted && table.RawSha256 is not null && !hash.Equals(table.RawSha256, StringComparison.OrdinalIgnoreCase))
            return false;

        table.RawStatus = TableStatus.Extracted;
        table.RawBytes = info.Length;
        table.RawSha256 = hash;
        table.RawCompletedAt ??= info.LastWriteTimeUtc;
        table.Error = null;
        return true;
    }

    private static void ValidateDbFile(ReadOnlySpan<byte> bytes, string tableName)
    {
        if (bytes.Length <= 4)
            throw new InvalidDataException($"{tableName} is empty or truncated.");
        if (!IsDbMagic(bytes[..4]))
            throw new InvalidDataException($"{tableName} has unsupported magic {Convert.ToHexString(bytes[..4])}.");
    }

    private static bool HasDbMagic(string path)
    {
        Span<byte> magic = stackalloc byte[4];
        using var stream = File.OpenRead(path);
        return stream.Read(magic) == 4 && IsDbMagic(magic);
    }

    internal static bool IsDbMagic(ReadOnlySpan<byte> magic) =>
        magic.SequenceEqual("WDBC"u8) ||
        (magic.Length == 4 && magic[0] == (byte)'W' && magic[1] == (byte)'D' &&
         magic[2] is (byte)'B' or (byte)'C' && char.IsAsciiDigit((char)magic[3]));

    internal static string CompactError(Exception exception)
    {
        var message = exception.GetBaseException().Message.ReplaceLineEndings(" ").Trim();
        return message.Length <= 1000 ? message : message[..1000];
    }
}
