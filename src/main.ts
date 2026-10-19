// Neon Blocks — 唯一装配入口（S02）。
// T007：导入设计 Token；T035：挂载静态页面骨架（一次性构建，不逐帧重建）；
// 引擎、渲染器、HUD、覆盖层与输入的装配在 T053 完成。
import './styles/tokens.css';
import { mountLayout } from './ui/layout';

const appRoot = document.getElementById('app');
if (appRoot === null) {
  throw new Error('index.html 缺少 #app 挂载点');
}
mountLayout(appRoot);
