namespace WowDb.Cli;

internal static class CliParser
{
    public static CliOptions Parse(string[] args)
    {
        if (args.Length == 0 || args[0] is "help" or "--help" or "-h")
            return new CliOptions();

        var command = args[0].ToLowerInvariant() switch
        {
            "doctor" => CommandKind.Doctor,
            "snapshot" => CommandKind.Snapshot,
            _ => throw new ArgumentException($"Unknown command: {args[0]}")
        };

        string? client = null;
        var product = "wow";
        var region = "cn";
        var locale = "zhCN";
        var output = Path.GetFullPath("output");
        var cache = Path.GetFullPath("cache");
        var phase = SnapshotPhase.All;
        var force = false;
        var refreshMetadata = false;
        var offline = false;
        var verifyExisting = false;
        string? hotfix = null;
        var tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        for (var i = 1; i < args.Length; i++)
        {
            var arg = args[i];
            string NextValue()
            {
                if (++i >= args.Length)
                    throw new ArgumentException($"Missing value for {arg}");
                return args[i];
            }

            switch (arg)
            {
                case "--client": client = Path.GetFullPath(NextValue()); break;
                case "--product": product = NextValue(); break;
                case "--region": region = NextValue(); break;
                case "--locale": locale = NextValue(); break;
                case "--output": output = Path.GetFullPath(NextValue()); break;
                case "--cache": cache = Path.GetFullPath(NextValue()); break;
                case "--phase":
                    phase = NextValue().ToLowerInvariant() switch
                    {
                        "all" => SnapshotPhase.All,
                        "raw" => SnapshotPhase.Raw,
                        "sqlite" => SnapshotPhase.Sqlite,
                        _ => throw new ArgumentException("--phase must be all, raw, or sqlite")
                    };
                    break;
                case "--table":
                    foreach (var table in NextValue().Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                        tables.Add(table);
                    break;
                case "--force": force = true; break;
                case "--refresh-metadata": refreshMetadata = true; break;
                case "--offline": offline = true; break;
                case "--verify-existing": verifyExisting = true; break;
                case "--hotfix": hotfix = Path.GetFullPath(NextValue()); break;
                case "--help":
                case "-h": return new CliOptions();
                default: throw new ArgumentException($"Unknown option: {arg}");
            }
        }

        if (command is CommandKind.Doctor or CommandKind.Snapshot && string.IsNullOrWhiteSpace(client))
            throw new ArgumentException("--client is required");

        return new CliOptions
        {
            Command = command,
            ClientPath = client,
            Product = product,
            Region = region,
            Locale = locale,
            OutputRoot = output,
            CacheRoot = cache,
            Phase = phase,
            Force = force,
            RefreshMetadata = refreshMetadata,
            Offline = offline,
            VerifyExisting = verifyExisting,
            HotfixPath = hotfix,
            Tables = tables
        };
    }

    public static void PrintHelp()
    {
        Console.WriteLine("""
            wow-db - resumable World of Warcraft client DB2 exporter

            Commands:
              wow-db doctor   --client <WoW root>
              wow-db snapshot --client <WoW root> [options]

            Snapshot options:
              --product <id>          Product from .build.info (default: wow)
              --region <id>           CDN region (default: cn)
              --locale <locale>       Data locale (default: zhCN)
              --output <dir>          Snapshot root (default: ./output)
              --cache <dir>           Download cache (default: ./cache)
              --phase <value>         all, raw, or sqlite (default: all)
              --table <a,b>           Export only named tables; repeatable
              --offline               Never fetch missing CASC or metadata files
              --verify-existing       Re-hash completed raw files before skipping
              --hotfix <file>         Apply a DBCache.bin/HTFX server hotfix cache
              --refresh-metadata      Replace pinned WoWDBDefs for this build
              --force                 Re-extract and re-export selected tables
            """);
    }
}
