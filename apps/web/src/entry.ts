import { compatibilityPath, sharedWorkspacePath } from './workspace-entry-paths';
import './aurora-theme.css';

const path = window.location.pathname;
const within = (base: string) => path === base || path.startsWith(`${base}/`);
const shared = within(sharedWorkspacePath);

if (within(compatibilityPath) && !shared) {
  void import('./workbench-entry').then(({ mountWorkbench }) => {
    mountWorkbench(document.getElementById('root')!, compatibilityPath);
  });
} else {
  void import('./main').then(({ mountPrimary }) => {
    mountPrimary(document.getElementById('root')!, shared ? sharedWorkspacePath : undefined);
  });
}
