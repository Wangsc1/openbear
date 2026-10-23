// node --test 的解析钩子：与 Metro 使用同一份 web-reuse 规则，并解析 mobile/src 的无扩展名 .ts 导入与 @/ 别名。
// 用法：node --import ./tests/support/register.mjs --test tests/
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
