---
name: smartsell-product-listing
description: Use when the owner asks SmartSell to list, import or check products, SKUs or stores, or to tie a post to a product (商品上架、匯入店鋪商品、核對 SKU；商品上架、导入店铺商品、核对 SKU; list a product, import a store catalog, check a SKU). In phase 1 SmartSell does not manage products or stores, and this skill keeps the answer honest.
argument-hint: "[product, SKU or store]"
---

# 商品與店鋪（第 1 階段不提供）

The SmartSell hub's phase-1 tools schedule social posts only: `smartsell_overview`, `machines_list`, `channels_list`, `channel_check`, `media_upload`, `post_schedule`, `post_update`, `posts_list`, `post_get`, `task_get`, `publishing_pause`. None of them reads or writes products, SKUs, stores or listings, and a post is not linked to a product. Product and store management comes in a later phase.

1. Tell the owner plainly that SmartSell cannot list, import or check products or stores yet, and that nothing was created or changed.
2. Do not try another way: no tool name outside that list, no browser or marketplace seller center, no shell, curl or scraping. Do not put product data in a caption or `plan_tag` as if it were a listing.
3. A post about the product does work: follow the posting flow (`smartsell_overview`, `media_upload`, `post_schedule`) with the caption the owner gives. Never invent product claims, prices or stock.
