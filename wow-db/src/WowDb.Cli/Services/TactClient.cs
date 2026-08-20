using System.Globalization;
using TACTSharp;
using WowDb.Models;

namespace WowDb.Services;

internal sealed class TactClient
{
    private readonly BuildInstance build = new();

    public TactClient(
        string clientRoot,
        BuildProductInfo product,
        string region,
        string locale,
        string cacheRoot,
        bool offline,
        string? tactKeysPath)
    {
        LoadKeys(tactKeysPath);

        build.Settings.BaseDir = clientRoot;
        build.Settings.Product = product.Product;
        build.Settings.Region = region;
        build.Settings.Locale = ParseLocale(locale);
        build.Settings.RootMode = RootInstance.LoadMode.Normal;
        build.Settings.CacheDir = Path.Combine(cacheRoot, "tact");
        build.Settings.TryCDN = !offline;
        build.Settings.ListfileFallback = false;
        Settings.LogLevel = TSLogLevel.Warn;

        if (product.CdnHosts.Count > 0)
            build.cdn.SetCDNs(product.CdnHosts.ToArray());
        build.cdn.ProductDirectory = product.CdnPath;

        Console.WriteLine($"Loading CASC metadata for {product.Product} {product.Version} ({locale})...");
        build.LoadConfigs(product.BuildConfig.ToLowerInvariant(), product.CdnConfig.ToLowerInvariant());
        build.Load();
    }

    public byte[] ReadFile(uint fileDataId) => build.OpenFileByFDID(fileDataId);

    public bool FileExists(uint fileDataId) =>
        build.Root?.FileExists(fileDataId) ?? throw new InvalidOperationException("CASC root is not loaded.");

    private static void LoadKeys(string? path)
    {
        if (path is null || !File.Exists(path))
            return;
        var loaded = 0;
        foreach (var line in File.ReadLines(path))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length < 2 || parts[0].Length != 16 || parts[1].Length != 32)
                continue;
            if (!ulong.TryParse(parts[0], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var keyName))
                continue;
            try
            {
                KeyService.SetKey(keyName, Convert.FromHexString(parts[1]));
                loaded++;
            }
            catch (FormatException)
            {
                // A malformed community entry should not block unencrypted files.
            }
        }
        Console.WriteLine($"Loaded {loaded} TACT keys.");
    }

    internal static RootInstance.LocaleFlags ParseLocale(string locale) => locale.ToLowerInvariant() switch
    {
        "enus" => RootInstance.LocaleFlags.enUS,
        "engb" => RootInstance.LocaleFlags.enGB,
        "kokr" => RootInstance.LocaleFlags.koKR,
        "frfr" => RootInstance.LocaleFlags.frFR,
        "dede" => RootInstance.LocaleFlags.deDE,
        "zhcn" => RootInstance.LocaleFlags.zhCN,
        "eses" => RootInstance.LocaleFlags.esES,
        "zhtw" => RootInstance.LocaleFlags.zhTW,
        "esmx" => RootInstance.LocaleFlags.esMX,
        "ruru" => RootInstance.LocaleFlags.ruRU,
        "ptbr" => RootInstance.LocaleFlags.ptBR,
        "itit" => RootInstance.LocaleFlags.itIT,
        "ptpt" => RootInstance.LocaleFlags.ptPT,
        _ => throw new ArgumentException($"Unsupported locale: {locale}")
    };
}
