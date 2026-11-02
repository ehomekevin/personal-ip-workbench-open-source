# 构建创作有数 macOS Apple Silicon 版

使用干净的 Git checkout、Apple Silicon Mac、Xcode 命令行工具和 Python 3。准备两个输入：本次提交的 Windows CI 作业生成并验证的 ZIP，以及官方 Node.js v26.9.0 的 `node-v26.9.0-darwin-arm64.tar.gz`。从 CI 构建记录取 Windows ZIP 本身的 SHA-256。GitHub Actions 外层 artifact 有独立的校验值。

在仓库根目录运行以下命令，所有输入、暂存和输出目录都放在仓库外。

```sh
python3 scripts/release/macos/build.py \
  --windows "$WINDOWS_ZIP" --windows-sha256 "$WINDOWS_ZIP_SHA256" \
  --node "$NODE_TARBALL" --out "$BUILD_DIR"
```

构建器核对输入版本、提交、源码树和官方运行时哈希，复用同次 CI 的平台无关服务、网页和依赖许可证，编译原生应用入口。应用内的 `Contents/Resources/release.json` 保留这些输入的版本与校验值。开发者可用以下命令对新构建进行本地结构和运行测试。

```sh
scripts/release/macos/seal.sh prepare "$BUILD_DIR/创作有数.app" "$CHECK_DIR"
```

正式发行需要使用团队的 Developer ID Application 身份、已在本机钥匙串配置的 Apple 公证 profile 和另一个干净构建。输出目录必须尚未存在。

```sh
scripts/release/macos/seal.sh publish-candidate "$BUILD_DIR/创作有数.app" "$OUTPUT_DIR" \
  "$IDENTITY_SHA1" "$TEAM_ID" "$NOTARY_PROFILE"
```

Apple 分配的 request ID 保存在 `submit.json` 中。等待中断时可用 `xcrun notarytool info` 和同一 ID 查询记录。只有 Apple 接受、成功装订票据，并对重新解压的最终文件完成签名、公证和 Gatekeeper 评估后，才会生成 ZIP 对应的校验文件。
