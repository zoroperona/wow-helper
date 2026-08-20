using WowDb.Cli;
using WowDb.Services;

namespace WowDb;

internal static class Program
{
    public static async Task<int> Main(string[] args)
    {
        using var cancellation = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cancellation.Cancel();
            Console.WriteLine("Cancellation requested; the current table will roll back.");
        };

        try
        {
            var options = CliParser.Parse(args);
            switch (options.Command)
            {
                case CommandKind.Help:
                    CliParser.PrintHelp();
                    return 0;
                case CommandKind.Doctor:
                    RunDoctor(options.ClientPath!);
                    return 0;
                case CommandKind.Snapshot:
                    var result = await new SnapshotRunner(options).RunAsync(cancellation.Token);
                    Console.WriteLine($"Done: total={result.Total:N0}, raw={result.Extracted:N0}, sqlite={result.Exported:N0}, not-addressable={result.NotAddressable:N0}, not-present={result.NotPresent:N0}, failed={result.Failed:N0}");
                    return result.Failed == 0 ? 0 : 2;
                default:
                    throw new ArgumentOutOfRangeException();
            }
        }
        catch (OperationCanceledException)
        {
            Console.Error.WriteLine("Cancelled. Re-run the same command to resume.");
            return 130;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine("Fatal: " + exception.GetBaseException().Message);
            return 1;
        }
    }

    private static void RunDoctor(string clientPath)
    {
        var root = BuildInfoReader.ResolveClientRoot(clientPath);
        var products = BuildInfoReader.Read(root);
        Console.WriteLine($"Client root: {root}");
        Console.WriteLine($"CASC data:   {(Directory.Exists(Path.Combine(root, "Data", "data")) ? "found" : "missing")}");
        Console.WriteLine("Installed products:");
        foreach (var product in products.OrderBy(item => item.Product, StringComparer.OrdinalIgnoreCase))
            Console.WriteLine($"  {product.Product,-22} {product.Version,-18} branch={product.Branch} folder={product.Folder} active={product.Active}");

        var drive = new DriveInfo(Path.GetPathRoot(root)!);
        Console.WriteLine($"Free space:  {drive.AvailableFreeSpace / 1024d / 1024d / 1024d:N1} GiB");
    }
}
