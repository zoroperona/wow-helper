using WowDb.Models;

namespace WowDb.Services;

internal static class BuildInfoReader
{
    public static string ResolveClientRoot(string path)
    {
        var current = new DirectoryInfo(Path.GetFullPath(path));
        for (var i = 0; i < 4 && current is not null; i++, current = current.Parent)
        {
            if (File.Exists(Path.Combine(current.FullName, ".build.info")))
                return current.FullName;
        }

        throw new DirectoryNotFoundException($"Could not find .build.info in {path} or its parents.");
    }

    public static IReadOnlyList<BuildProductInfo> Read(string clientRoot)
    {
        var path = Path.Combine(clientRoot, ".build.info");
        var lines = File.ReadAllLines(path);
        if (lines.Length < 2)
            throw new InvalidDataException($"Invalid or empty {path}");

        var headers = lines[0].Split('|')
            .Select((value, index) => (Name: value.Split('!')[0], Index: index))
            .ToDictionary(item => item.Name, item => item.Index, StringComparer.OrdinalIgnoreCase);
        var flavorFolders = ReadFlavorFolders(clientRoot);
        var results = new List<BuildProductInfo>();

        foreach (var line in lines.Skip(1).Where(line => !string.IsNullOrWhiteSpace(line)))
        {
            var values = line.Split('|');
            string Get(string name) => headers.TryGetValue(name, out var index) && index < values.Length ? values[index] : string.Empty;

            var product = Get("Product");
            if (string.IsNullOrWhiteSpace(product))
                continue;

            var hosts = Get("CDN Hosts").Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            results.Add(new BuildProductInfo(
                Get("Branch"),
                Get("Active") is "1" or "true" or "True",
                Get("Build Key"),
                Get("CDN Key"),
                Get("CDN Path"),
                hosts,
                Get("Version"),
                product,
                flavorFolders.GetValueOrDefault(product, string.Empty)));
        }

        if (results.Count == 0)
            throw new InvalidDataException($"No products found in {path}");
        return results;
    }

    private static Dictionary<string, string> ReadFlavorFolders(string clientRoot)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var flavorPath in Directory.EnumerateFiles(clientRoot, ".flavor.info", SearchOption.AllDirectories))
        {
            var lines = File.ReadAllLines(flavorPath);
            if (lines.Length < 2 || string.IsNullOrWhiteSpace(lines[1]))
                continue;
            result[lines[1].Trim()] = Path.GetFileName(Path.GetDirectoryName(flavorPath)) ?? string.Empty;
        }
        return result;
    }
}

