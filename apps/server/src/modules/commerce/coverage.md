# 匯入覆蓋確認

財務報表匯入後，管理員可按店鋪確認報表覆蓋的訂單日期區間。區間採 `[window_start, window_end)`，`as_of` 是來源報表已核對到的時間。退款覆蓋以原訂單日期歸屬區間。只有實際核對完整報表或來源帳務時才標記 `complete`，未完成核對可標記 `partial`。

| action | kind | 欄位 |
|---|---|---|
| `attest_import_coverage` | `coverage_segment` | `batch_id`, `window_start`, `window_end`, `as_of`, `status` |
| `import_coverage_list` | `coverage_segment` | `store_id`。結果 `items[].data.effective` 表示本版仍有效且來源批次仍已提交。 |

```json
{
  "batch_id": "<已提交的 order_list 或 refund_list 批次 ID>",
  "window_start": "2026-10-01T00:00:00Z",
  "window_end": "2026-11-01T00:00:00Z",
  "as_of": "2026-11-19T12:00:00Z",
  "status": "complete"
}
```

來源仍可能回補退款時，保留實際已核對到的時間。財務查詢或報告可傳 `data_cutoff_at`，使用已完成覆蓋的截點。若查詢截點晚於退款確認的 `as_of`，仍會顯示已觀測金額，完整退款與淨銷售會標示未知。

同區間的新確認會留下前版及其失效時間。回滾匯入後，來源已回滾的確認不再有效。報告版本保留產生時所使用的確認及結果。
