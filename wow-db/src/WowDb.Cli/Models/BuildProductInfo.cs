namespace WowDb.Models;

internal sealed record BuildProductInfo(
    string Branch,
    bool Active,
    string BuildConfig,
    string CdnConfig,
    string CdnPath,
    IReadOnlyList<string> CdnHosts,
    string Version,
    string Product,
    string Folder);

