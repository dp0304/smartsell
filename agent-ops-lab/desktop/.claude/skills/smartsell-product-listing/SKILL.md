---
name: smartsell-product-listing
description: Record an unsupported request to list an existing product on a marketplace, or look up that request. This never lists a product. 商品上架目前不支持，可记录请求。
argument-hint: "[request PRODUCT_ID [VARIANT_ID] [STORE_ID] | status REQUEST_ID]"
disable-model-invocation: true
---

# Product listing request (unsupported)

Requested action: $ARGUMENTS

SmartSell Desktop does not support actual marketplace product listing. Say so before making any call. Only record a request when the user explicitly asks to record it (including the `request` subcommand), not when they only ask whether listing is possible or ask to list a product. Do not create or edit a product, announce a listing, or imply an approval, queue, execution, or platform write.

Use only `desktop_request_capability` and `desktop_get_capability_request` from the connected SmartSell MCP server. Resolve names through the client if they are namespaced. If unavailable, report that request recording is unavailable here; do not fall back to another operation, direct HTTP, shell, or browser. Use already-known Workspace IDs; ask for missing or ambiguous IDs and omit optional fields the user did not supply.

- `/smartsell-product-listing request PRODUCT_ID [VARIANT_ID] [STORE_ID]`: call `desktop_request_capability` with flat `{ "capability": "product_listing", "product_id": "PRODUCT_ID", "idempotency_key": "UNIQUE_KEY" }`, plus `variant_id` and/or `store_id` if supplied. Reuse the idempotency key only for retries of the same request. To specify a store without a variant, the user can give `store_id=STORE_ID` explicitly.
- `/smartsell-product-listing status REQUEST_ID`: call `desktop_get_capability_request` with flat `{ "id": "REQUEST_ID" }`.

If the server records the request, report its ID, `status: unsupported`, `reason: product_listing_not_supported`, and `requested_at` if returned. Explain that nothing was queued or published. If a call fails, report the error without claiming a request was recorded.
