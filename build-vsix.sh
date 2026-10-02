#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NAME="codex-session-tracker"
# Git Bash on Windows passes POSIX paths to the native Node executable. Use a
# Windows path only for these metadata reads; filesystem operations below stay
# in the shell's native path form.
if command -v cygpath >/dev/null 2>&1; then
  NODE_ROOT="$(cygpath -w "$ROOT")"
else
  NODE_ROOT="$ROOT"
fi
export CODEX_TRACKER_PACKAGE="$NODE_ROOT/package.json"
VERSION="$(node -p "require(process.env.CODEX_TRACKER_PACKAGE).version")"
ENGINE="$(node -p "require(process.env.CODEX_TRACKER_PACKAGE).engines.vscode")"
DISPLAY="$(node -p "require(process.env.CODEX_TRACKER_PACKAGE).displayName")"
DESCRIPTION="$(node -p "require(process.env.CODEX_TRACKER_PACKAGE).description")"
VSIX="$ROOT/${NAME}-${VERSION}.vsix"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/extension"
cp "$ROOT/package.json" "$STAGE/extension/package.json"
cp "$ROOT/extension.js" "$STAGE/extension/extension.js"
cp "$ROOT/tracker.js" "$STAGE/extension/tracker.js"
cp "$ROOT/codex_queue.js" "$STAGE/extension/codex_queue.js"
cp "$ROOT/codex_steer.js" "$STAGE/extension/codex_steer.js"
cp "$ROOT/codex_delete.js" "$STAGE/extension/codex_delete.js"
mkdir -p "$STAGE/extension/gateway"
cp "$ROOT"/gateway/*.js "$STAGE/extension/gateway/"
cp "$ROOT/dashboard.html" "$STAGE/extension/dashboard.html"
cp "$ROOT/traffic_monitor.html" "$STAGE/extension/traffic_monitor.html"\ncp -R "$ROOT/codex-hook" "$STAGE/extension/codex-hook"
mkdir -p "$STAGE/extension/media"
cp "$ROOT/media/tracker.svg" "$STAGE/extension/media/tracker.svg"
cp "$ROOT/README.md" "$STAGE/extension/README.md"
cp "$ROOT/LICENSE" "$STAGE/extension/LICENSE.txt"

cat > "$STAGE/extension.vsixmanifest" <<XML
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="codex-session-tracker" Version="${VERSION}" Publisher="local" />
    <DisplayName>${DISPLAY}</DisplayName>
    <Description xml:space="preserve">${DESCRIPTION}</Description>
    <Tags>codex,openai,status,session,tracker</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${ENGINE}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
XML

cat > "$STAGE/[Content_Types].xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="svg" ContentType="image/svg+xml" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
</Types>
XML

rm -f "$VSIX"
(cd "$STAGE" && zip -q -r "$VSIX" '[Content_Types].xml' extension.vsixmanifest extension)
echo "$VSIX"
