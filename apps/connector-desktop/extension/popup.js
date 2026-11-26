chrome.runtime.sendMessage({ type: 'status' }, status => {
  const state = document.getElementById('state');
  if (!status) { state.textContent = '無法讀取狀態。'; return; }
  if (status.connected) {
    state.className = 'ok';
    state.textContent = status.tabs ? `已連上這台電腦的 SmartSell Worker，正在操作 ${status.tabs} 個分頁。` : '已連上這台電腦的 SmartSell Worker。';
  } else {
    state.className = 'warn';
    state.textContent = /not found/i.test(status.error ?? '')
      ? '這台電腦還沒裝 SmartSell Worker，或 Worker 還沒在 Chrome 登記。請先安裝並開啟 Worker App。'
      : '連不上 SmartSell Worker。請確認 Worker App 正在執行；連上後會自動恢復。';
  }
  document.getElementById('files').hidden = status.file_access !== false;
});
