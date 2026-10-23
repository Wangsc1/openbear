import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * OpenBear 原生客户端构建配置。
 *
 * 设计约束（见 openbear-native-app-design.md 6.1/6.2）：
 * - 通用客户端：不内置任何服务器地址；服务器在 App 内添加。
 * - 包名、应用名、热更新地址/公钥等都走环境变量，自行构建的人改环境变量即可，不需要 fork。
 * - Android 默认构建不引入 Firebase / 谷歌移动服务。
 * - Expo SDK 57 起 Android edge-to-edge 是强制行为（prebuild-config 的 withEdgeToEdge
 *   已移除 edgeToEdgeEnabled 开关），这里只需打开预测性返回。
 */

const env = (key: string, fallback = ''): string => {
  const value = process.env[key];
  return value === undefined || value === '' ? fallback : value;
};

const APP_NAME = env('OPENBEAR_APP_NAME', 'OpenBear');
const APP_SLUG = env('OPENBEAR_APP_SLUG', 'openbear');
const APP_SCHEME = env('OPENBEAR_APP_SCHEME', 'openbear');
const ANDROID_PACKAGE = env('OPENBEAR_ANDROID_PACKAGE', 'dev.openbear.app');
const IOS_BUNDLE_ID = env('OPENBEAR_IOS_BUNDLE_ID', 'dev.openbear.app');
const APP_VERSION = env('OPENBEAR_APP_VERSION', '0.1.0');
const ANDROID_VERSION_CODE = Number(env('OPENBEAR_ANDROID_VERSION_CODE', '1')) || 1;

// 热更新：默认关闭。只有显式提供项目自己的更新地址时才启用（不使用 EAS 云服务）。
const UPDATES_URL = env('OPENBEAR_UPDATES_URL');
const UPDATES_CODE_SIGNING_CERT = env('OPENBEAR_UPDATES_CODE_SIGNING_CERT');

// 仅用于开发期的基准/模拟后端开关，默认不启用；不会把任何生产服务器地址写入构建。
const DEV_SERVER_URL = env('OPENBEAR_DEV_SERVER_URL');

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: APP_NAME,
  slug: APP_SLUG,
  scheme: APP_SCHEME,
  version: APP_VERSION,
  orientation: 'default',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: IOS_BUNDLE_ID,
    userInterfaceStyle: 'automatic',
  },
  android: {
    package: ANDROID_PACKAGE,
    versionCode: ANDROID_VERSION_CODE,
    userInterfaceStyle: 'automatic',
    adaptiveIcon: {
      backgroundColor: '#F7F7F5',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: true,
    // 键盘由 react-native-keyboard-controller 接管；resize 由它统一处理。
    softwareKeyboardLayoutMode: 'resize',
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    'expo-status-bar',
    'expo-system-ui',
    [
      'expo-navigation-bar',
      {
        // 让手势条/导航栏区域由页面背景接管（透明），不强制系统加半透明遮罩。
        enforceContrast: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission: '允许 $(PRODUCT_NAME) 访问相册，以便在对话中发送图片。',
        cameraPermission: '允许 $(PRODUCT_NAME) 使用相机，以便拍照发送到对话。',
        microphonePermission: false,
      },
    ],
    'expo-document-picker',
    'expo-secure-store',
    'expo-sqlite',
    'expo-sharing',
    [
      'expo-local-authentication',
      { faceIDPermission: '允许 $(PRODUCT_NAME) 使用面容 ID 解锁凭证查看。' },
    ],
    [
      'expo-build-properties',
      {
        android: {
          // 开发期模拟后端走 http://10.0.2.2；正式连接的服务器应为 https。
          usesCleartextTraffic: true,
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: false,
  },
  ...(UPDATES_URL
    ? {
        updates: {
          url: UPDATES_URL,
          enabled: true,
          checkAutomatically: 'ON_LOAD',
          ...(UPDATES_CODE_SIGNING_CERT
            ? {
                codeSigningCertificate: UPDATES_CODE_SIGNING_CERT,
                codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
              }
            : {}),
        },
        runtimeVersion: { policy: 'fingerprint' },
      }
    : {}),
  extra: {
    ...(config.extra ?? {}),
    devServerUrl: DEV_SERVER_URL,
  },
});
