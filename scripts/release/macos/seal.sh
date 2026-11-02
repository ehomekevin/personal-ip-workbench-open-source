#!/bin/bash
set -euo pipefail
# Arguments are public identifiers. Authentication stays in the Keychain.
mode=${1:?prepare or publish-candidate}
app=${2:?fresh app path}
out=${3:?fresh evidence directory}
src=$(cd "$(dirname "$0")" && pwd)
case "$mode" in
 prepare) signer=-; timestamp=--timestamp=none ;;
 publish-candidate)
   signer=${4:?Developer ID Application SHA1}; team=${5:?owner confirmed team}; profile=${6:?notarytool keychain profile}
   [[ "$signer" =~ ^[0-9A-F]{40}$ && "$team" =~ ^[A-Z0-9]{10}$ ]]
   security find-identity -v -p codesigning | awk -v id="$signer" -v t="($team)\"" '$2==id && /"Developer ID Application: / && substr($0,length($0)-length(t)+1)==t {found=1} END{exit !found}' || { echo 'Required Developer ID Application identity/team unavailable' >&2; exit 2; }
   timestamp=--timestamp ;;
 *) exit 2 ;;
esac
mkdir "$out"
codesign -f -s "$signer" "$timestamp" --options runtime --entitlements "$src/node-entitlements.plist" "$app/Contents/Helpers/node"
codesign -f -s "$signer" "$timestamp" --options runtime "$app"
codesign --verify --deep --strict "$app"
[[ "$mode" == prepare ]] && exit 0
codesign -dv --verbose=4 "$app" 2>"$out/app-signature.txt"
codesign -dv --verbose=4 "$app/Contents/Helpers/node" 2>"$out/runtime-signature.txt"
ditto -c -k --keepParent --norsrc --noextattr "$app" "$out/submission.zip"
xcrun notarytool submit "$out/submission.zip" --keychain-profile "$profile" --no-wait --output-format json > "$out/submit.json"
request=$(plutil -extract id raw "$out/submit.json")
echo "Submitted: $request"
xcrun notarytool wait "$request" --keychain-profile "$profile" --output-format json > "$out/notary.json"
xcrun notarytool log "$request" --keychain-profile "$profile" "$out/apple-log.json"
[[ "$(plutil -extract status raw "$out/notary.json")" == Accepted ]]
plutil -extract id raw "$out/notary.json"
xcrun stapler staple "$app"
xcrun stapler validate "$app"
codesign --verify --deep --strict "$app"
spctl --assess --type execute -vv "$app"
version=$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")
zipname="chuangzuoyoushu-${version}-macos-arm64.zip"
ditto -c -k --keepParent "$app" "$out/$zipname"
mkdir "$out/check"
ditto -x -k "$out/$zipname" "$out/check"
copy="$out/check/$(basename "$app")"
codesign --verify --deep --strict "$copy"
xcrun stapler validate "$copy"
spctl --assess --type execute -vv "$copy"
(cd "$out" && shasum -a 256 "$zipname" > "$zipname.sha256")
