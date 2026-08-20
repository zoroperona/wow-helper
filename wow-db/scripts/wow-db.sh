#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <WoW client root> [wow-db options]" >&2
  exit 64
fi

client_path="$1"
shift

dotnet run \
  --project "$repo_dir/src/WowDb.Cli/WowDb.Cli.csproj" \
  --configuration Release \
  -- \
  snapshot \
  --client "$client_path" \
  --output "$repo_dir/output" \
  --cache "$repo_dir/cache" \
  "$@"

