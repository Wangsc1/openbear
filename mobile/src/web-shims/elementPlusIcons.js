// 替身：@element-plus/icons-vue
// web/src/views/consoleView/display.js 只在 toolIcon() 中把图标组件作为值返回，App 不渲染这些 Vue 组件。
// 用稳定的字符串标识代替，App 侧按名字映射到自己的图标（或忽略）。
const icon = (name) => Object.freeze({ openbearIcon: name });

export const CircleCheck = icon('CircleCheck');
export const Close = icon('Close');
export const Compass = icon('Compass');
export const DataAnalysis = icon('DataAnalysis');
export const Document = icon('Document');
export const EditPen = icon('EditPen');
export const Finished = icon('Finished');
export const Loading = icon('Loading');
export const Monitor = icon('Monitor');
export const Refresh = icon('Refresh');
export const SemiSelect = icon('SemiSelect');
export const Timer = icon('Timer');
export const Tools = icon('Tools');
export const TrendCharts = icon('TrendCharts');
export const User = icon('User');
export const Warning = icon('Warning');
