# 每日店鋪對帳

管理員在工作台輸入已獲授權對帳報表的原幣合計。訂單和退款按原訂單日歸屬，退款只計已成功的金額。`source_report_ref` 填來源報表的識別碼。

| action | kind | 欄位 |
|---|---|---|
| `reconcile_revenue_day` | `analytics.reconciliation_check` | `store_id`, `day`, `tz`, `currency`, `source_report_ref`, `order_count`, `order_total_minor`, `refunds_succeeded_minor` |
| `revenue_reconciliation_list` | `analytics.reconciliation_check` | `store_id`, `from`, `to`，日期區間不含 `to` |

```json
{
  "store_id": "<commerce.store.id>",
  "day": "2026-10-12",
  "tz": "America/Los_Angeles",
  "currency": "USD",
  "source_report_ref": "statement-2026-10-12-v2",
  "order_count": 12,
  "order_total_minor": 38400,
  "refunds_succeeded_minor": 249
}
```

檢查紀錄含 `source`、`observed`、`delta`、`status`、`coverage` 與證據。`delta` = 本地觀測 − 來源值。差異會建立 `ingest.quality_issue`，同店鋪、日期、幣別與時區重用問題紀錄。後續核對相符時結案。覆蓋仍依 `commerce.coverage_segment` 判定，對帳相符不會更新覆蓋。
