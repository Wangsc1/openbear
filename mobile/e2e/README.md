# Maestro 流程（P0）

运行前提：模拟后端（`node scripts/mock-server/server.mjs`，端口 18787）与 Metro（`npx expo start --dev-client`）已启动，
dev build 已安装，App 已连接模拟后端（启动时 `OPENBEAR_DEV_MOCK_BASE_URL=http://10.0.2.2:18787`）。

```sh
export MAESTRO_CLI_NO_ANALYTICS=1
maestro --device emulator-5554 test e2e/phone-core.yaml
```

截图输出到 `--test-output-dir`（报告用的截图拷贝在 workspace/artifacts/openbear-mobile/p0/screenshots/）。
