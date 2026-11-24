# X and TikTok Studio publish drivers: page structure and selectors as of Nov 2026

Nothing was changed in any repo. All research used Exa. Dates in brackets are publication or last-verified dates; "(uncertain)" marks claims I could only partly confirm.

## Biggest risk: both sites now detect automated posting

- **TikTok.** One 2026 report says TikTok's security script (webmssdk) answers the publish request with `{code: 7, Permission Denied}` when a debugger (CDP) is attached. The video stays uploaded, and a manual click on Post succeeds [anton-abyzov skill, about Sep 2026; one source only]. A separate issue shows "Something went wrong. You can try again or replace it with a different video." after Post from Playwright Chromium, while manual posting in real Chrome worked on the same account [wkaisertexas/tiktok-uploader #238, 2026-04-28]. Since the rules forbid stealth, treat code 7 or "Something went wrong" as a hard stop: the video is already uploaded, so tell the user to click Post themselves.
- **X.** In an automation-launched Chrome, `/home` and `/compose/post` sometimes never finish loading. When they do, the editor can refuse text inserted by `Input.insertText` or `execCommand` (the text shows, but the counter stays at 0 and the button stays disabled). In one run only the last of three paragraphs was registered, and that truncated text was actually posted [jackwener/OpenCLI #2024, 2026-06-24, comment 2026-07-26]. That issue concludes that using the user's real logged-in Chrome is one of the only workable routes, which matches your design. Separately, four accounts posting with headless Playwright and saved cookies were all suspended within about three weeks [note.com, 2026-05-15].
- **Chrome 136 and later** ignores `--remote-debugging-port` on the default profile. You need `--user-data-dir` pointing at a separate folder, which your dedicated profile already does [developer.chrome.com/blog/remote-debugging-port, 2025-03-17].
- **Never retry a post automatically.** Both sites can publish while the UI reports a failure or times out. Before any retry, check the profile or content page for the post [OpenCLI PR #1511, 2026-05-13; libi; anton].

---

## X (x.com)

**1. URLs.** Use `https://x.com/compose/post`. It opens as a dialog on top of the home page (`[role="dialog"]` / `[aria-modal="true"]`). The older `/compose/tweet` redirects to it. The fallback is the inline composer on `https://x.com/home`. Don't rely on `x.com/intent/post?text=`: the text was dropped in automation [OpenCLI #2024, 2026-07].

**2. Flow and selectors.** `data-testid` attributes are the most stable and don't depend on UI language [hive x-automation, verified 2026-04-11; XActions selector reference, Feb 2026].

| Step | Selector / method |
|---|---|
| Ready / logged in | `[data-testid="tweetTextarea_0"]` visible; `a[data-testid="AppTabBar_Home_Link"]` present |
| Scope | Look inside the dialog: the home composer behind it also has `tweetTextarea_0` and a `fileInput`. Pick the visible one. |
| Video file | `input[type="file"][data-testid="fileInput"]` (hidden; accepts images and video; exact accept list uncertain). Call `setInputFiles` on it directly. Never click the media button: it opens the OS file picker, which CDP can't control. |
| Order | Attach media **before** typing text. Attaching afterwards can reset the editor and post media with no text [OpenCLI PR #1180, 2026-04-25]. |
| Text | Click the textarea first (needed to put the editor in edit mode). Then `keyboard.insertText` (CDP `Input.insertText`), one line at a time with `Enter` between lines. Never use `fill()`: it drops CJK characters [markus SOP, 2026-04]. Read back `innerText` and compare with the intended text. If the button stays disabled, click the textarea, then End, Space, Backspace [hive]. One report says insertText corrupted text in X [anton, single source]; the read-back covers this. |
| Post button | `[data-testid="tweetButton"]` in the dialog, `[data-testid="tweetButtonInline"]` on home. It is enabled when `aria-disabled` is not `"true"`. Never force-click a disabled button: it goes to /home without posting [pi-braid skill, 2026]. |

**3. Detecting that upload and processing are finished.** The button being enabled is **not** enough, because text alone enables it [OpenCLI PR #666, 2026-04]. Require all three:
- (a) `[data-testid="attachments"]` contains a `video` or a `blob:` preview.
- (b) Read-only network check: the latest response from `upload.x.com/.../media/upload.json` (FINALIZE or `command=STATUS`) has `processing_info.state == "succeeded"`, or no `processing_info` at all. On `failed`, stop and show `error.message`. Allow minutes, not seconds [kaitox protocol notes; unrager source, 2026].
- (c) The Post button is enabled.

Typical processing is 30–60 s [baoyu-skills]. I couldn't confirm the exact on-screen progress bar or "Uploading %" text (uncertain).

**4. Confirmation and post ID.** In order of preference:
- **Toast:** `[data-testid="toast"]` or `[role="alert"]` reading "Your post was sent." with a "View" link `a[href*="/status/"]`. Parse `/status/(\d+)`. Mark toasts already on screen before clicking so you only read new ones [OpenCLI post.js, current main].
- **Network:** the `/i/api/graphql/<id>/CreateTweet` response, at `data.create_tweet.tweet_results.result.rest_id`. Its `errors[]` array means failure [sinoon/x-ops; public-clis/twitter-cli].
- **Fallback:** the profile's first non-pinned `article[data-testid="tweet"]` whose `[data-testid="tweetText"]` matches.
- Landing back on /home is not proof the post went out.

**5. Labels** (prefer testids).

| | English | 简体 | 繁體 |
|---|---|---|---|
| Post button | Post | 发帖 [markus SOP 2026-04] | 發佈 / 發文 (uncertain) |
| Placeholder | What's happening? | 有什么新鲜事？ | 有什麼新鮮事？ (uncertain) |
| Textbox label | Post text | 帖子文本 | (uncertain) |
| Add to thread | Add post | 添加帖子 | (uncertain) |
| Success toast | Your post was sent. / View | 你的帖子已发送 / 查看 | 你的貼文已傳送 (uncertain) |

OpenCLI's toast patterns: success `/your post was sent|已发送|已发布|发布成功|发送成功/`; failure `/failed|not sent|try again|发送失败|发布失败|请重试|出错/`.

**6. Signals to stop on.**
- **Login:** URL contains `/i/flow/login` or `/login`, or `[data-testid="loginButton"]` is present. Login and 2FA happen inside `/i/flow/`, so stop on any `/i/flow/` URL.
- **Locked account / anti-bot check:** redirect to `/account/access` [hive].
- **Arkose challenge:** any `iframe` whose `src` contains `arkoselabs.com` or `funcaptcha`, or whose id contains "arkose" [Exocortex captcha detector].
- **Page failed to load:** "Something went wrong, but don't fret — let's give it another shot." [OpenCLI #2024].
- **Message strings found in X's own JS bundle** [urlscan captures, date unknown]:
  - "You are over the daily limit for sending posts."
  - "Whoops! You already said that." (duplicate post)
  - "Something went wrong. Try sending your post again in a minute."
  - "…this account is temporarily blocked from sending posts…"
  - "You have reached your daily limit for this action. Please add a phone…"
  - "Your account is suspended and is not permitted to send posts."
  - Error 226: "This request looks like it might be automated."
- **Error codes:** the legacy codes 185 (daily limit), 187 (duplicate), 226 (automated), 326 (locked) likely appear in CreateTweet `errors[]` (uncertain; check against a real response).
- **Limits:** X's limits page currently says 50 original posts and 200 replies per day for unverified accounts, split into half-hour windows. The same page also still mentions 2,400 per day [twitterapi.io, 2026].

**7. Preflight.**
- **Video, free account:** up to 140 s and 512 MB; 32×32 up to 1920×1200 (or 1200×1900); aspect ratio between 1:2.39 and 2.39:1; at most 40 fps and 25 Mbps; one video per post. X lists no file types for web uploads. Media Studio and ads accept MP4/MOV; use H.264 + AAC in MP4, since MOV fails more often [help.x.com/en/using-x/x-videos via hubstudio 2026-10-14, clapr 2026-09-18].
- **Video, Premium:** under 4 h and 16 GB on web/iOS (720p between 2 and 4 h). The Premium page says about 3 h and 8 GB instead.
- **Text:** 280 weighted characters for non-Premium; a CJK character counts as 2 and a URL as 23 [haowenji 2026-10-23; anton].

**8. Known breakages in 2025–2026.**
- Editor reset when media is attached after the text: fixed by attaching first [OpenCLI #1180].
- Treating the button-enabled state as "upload done" [OpenCLI #666].
- Toast found but the CDP call failed, leading to a false failure and a retry. Treat the toast as authoritative [OpenCLI #1511].
- Pages not loading and synthetic text rejected in automation browsers [OpenCLI #2024].
- The Grok side panel can open over the composer [browser-use skill, 2026-05].

---

## TikTok Studio

**1. URLs.** Use `https://www.tiktok.com/tiktokstudio/upload`. Many tools add `?from=upload&lang=en`. The older `creator-center/upload` still works and redirects. Older layouts loaded the form inside `iframe[data-tt="Upload_index_iframe"]`; the current page has no iframe, but keep that as a fallback [social-auto-upload].

The `lang=en` parameter is widely used to force the English UI [tiktokautouploader; catui skill; chenchen1010]. It's a URL parameter, not an account setting; whether it persists is uncertain. Avoid social-auto-upload's approach of changing the account's language.

**2. Flow and selectors.** The most complete live-tested recipe is Nagellabs/libi `mcp/skills/browser-posting/references/tiktok-studio.md`, measured on a real account on 2026-10-02.

| Step | Selector / method |
|---|---|
| Ready / logged in | `.upload-text-container` or the button "Select video" visible. A redirect to `/login` means logged out. |
| File | `input[type="file"][accept="video/*"]` with `setInputFiles` [tiktokautouploader]. Fallback: `input[type="file"]`, searched in the page and any frames. If an upload error happens, `button[aria-label="Select file"]` reappears. Keep the source file in place until the page shows "Uploaded": deleting a temp file stalled one upload at 86% [ChatOverflow 2026-11-12]. |
| First-time popups (before typing) | "Turn on automatic content checks?" → **Cancel** (`div.common-modal-footer > button[data-type='neutral']`); accepting would change an account setting. "New editing features" and the react-joyride tour → **Got it** (these overlays block clicks; root cause of #237/#239). Split window → "Not now". Cookie banner `tiktok-cookie-banner`. Stale draft banner "A video you were editing wasn't saved" → Discard (be careful with this one). Note that Playwright's `isVisible(timeout)` does not wait, which is why these popups were missed [PR #242, 2026-11-04]. |
| Caption | Draft.js editor, prefilled with the file name. Selectors: `div[contenteditable="true"][role="combobox"]`, then `.public-DraftEditor-content`, then `div[data-contents="true"]`. To clear: click it, `ControlOrMeta+A`, `Backspace`, then **wait about 600 ms** (text inserted right away is dropped). Insert body text with `keyboard.insertText` line by line, with `Enter` between lines. `keyboard.type` scrambles text after an emoji [ChatOverflow 2026-11]. Paste is ignored [anton]. Setting innerHTML is never saved. |
| Hashtags | Add them last and slowly: `keyboard.type('#tag', {delay: 60})`, wait about 1.5 s, then click the suggestion (`span.hash-tag-topic`, inside `.mention-list-popover`) or press Space. Pressing Enter inserts a line break [PR #242]. A real linked tag appears as a `mentionText` node [chenchen1010]. Finally read back `innerText` and compare. |
| Upload done | The text "Uploaded" (or a full MB counter), or `div.resolution-label-text`. Plus the Post button enabled: `button[data-e2e="post_video_button"]` with `aria-disabled="false"` / `data-disabled="false"`. A "no progress text yet" check right after selecting the file gives a false "done" [ChatOverflow]. |
| Who can watch | `div[data-e2e="video_visibility_container"] button[role="combobox"]`, then `div[role="option"]` with Everyone / Friends / "Only you" (some code says "Only me") [wkaisertexas main]. **Always set it explicitly**: a new post inherits the previous post's privacy [TikTok Help via Superdirector, 2026-11-18]. If this step fails, fail the whole upload [PR #242]. |
| Allow users to | `label.Checkbox__root`; read `aria-checked` and `aria-disabled`. Click the label, not the text or icon. Duet and Stitch are now one checkbox, "Reuse of content", which is disabled for videos over 60 s ("Duet and Stitch not available for videos over 60s") [libi; PR #242]. Legacy fallback: `//label[.='Comment']/following-sibling::div/input`. |
| Disclosure | Click "Show more". "Disclose post content" is a `[role="switch"]` that reveals the "Your brand" / "Branded content" checkboxes. "AI-generated content" is a switch that opens a dialog (Not now / **Turn on**). Copyright check: `div[data-e2e="copyright_container"] span[data-part="thumb"]`, then "No issues found." or "Copyright issues detected". |
| Post | Scroll the button into view (it sits below the fold), then click `button[data-e2e="post_video_button"]` (text "Post", or "Schedule" when Schedule is selected). Fallbacks: `getByRole('button', {name: 'Post', exact: true})`, `.TUXButton--primary`. If music editor overlays (`AudioClip__root`, `Timeline__movArea`) block the click, one project falls back to `dispatchEvent` [chenchen1010]. |

**3. Dialogs after clicking Post.**
- **"Continue to post?"** (Cancel / **Post now**: `button:has-text("Post now")`). It appears when the background "Content check lite" (about 10 min, checks For You eligibility) hasn't finished. The music copyright check takes about 30 s [ChatOverflow 2026-11-05]. Either wait the checks out or click Post now.
- **Schedule only:** "Allow your video to be saved for scheduled posting?" → Allow.
- **"Something went wrong…":** fail immediately [PR #242].

**4. Confirmation and video ID.**
- **Success:** the URL becomes `/tiktokstudio/content` [all projects]. Older UI text: "Leaving the page does not interrupt…", "Your video has been uploaded", "视频已发布".
- **Publish response** (read-only network check): `POST /tiktok/web/project/post/v1/`. `status_code` 0 means success. Seen failures: 4 "Server is currently unavailable", 5 "Invalid parameters", 3013046 "Post not created due to a potential violation of our Community Guidelines" [makiisthenes issues #102/#123]. Code 7 is probably the CDP block above (uncertain). Whether the success response includes the new video ID is uncertain.
- **Getting the ID:** on the content page, the first row's `a[href*="/video/"]` under `div[data-tt="components_PostTable_Container"] div[data-tt="components_PostInfoCell_Container"]` gives `video/(\d+)` [social-auto-upload; freshness uncertain]. Alternatively, read the `POST /tiktok/creator/manage/item_list/v1/` response [cv-cat/tiktokapis]. Or check the profile `tiktok.com/@user` (skip pinned videos and match the caption).
- A new post shows "Content under review" and "Only me" for a few minutes before switching to Everyone [libi 2026-10-02]. Changing privacy afterwards sends it back to review [ChatOverflow].

**5. Labels.** EN labels are confirmed in sources. Chinese labels are mostly **unverified**, so match by `data-e2e` / role and use regex alternatives.

| English | 简体 | 繁體 |
|---|---|---|
| Select video | 选择视频 | 選擇影片 |
| Uploaded | 已上传 | 已上傳 |
| Post | 发布 | 發佈 |
| Post now | 立即发布 | 立即發佈 |
| Continue to post? | 继续发布？ | 繼續發佈？ |
| Cancel / Got it | 取消 / 知道了 | 取消 / 知道了 |
| Everyone / Friends / Only you | 所有人 / 好友 / 仅自己 | 所有人 / 朋友 / 只有你 |
| Comment | 评论 | 留言 |
| Duet / Stitch | 合拍 / 拼接 | 合拍 / 畫面拼貼 (confirmed on TikTok zh_Hant help) |
| Show more / Schedule | 显示更多 / 定时发布 | 顯示更多 / 排程 |
| Video published | 视频已发布 (confirmed, wkaisertexas config) | — |

**6. Signals to stop on.**
- **Login:** URL contains `/login`, or the upload container never appears. A `select` element with class matching `tiktok-.*-SelectFormContainer` also means logged out [social-auto-upload].
- **Captcha, any of:** `#captcha_container`, `#captcha-verify-image`, `.captcha-verify-container`, `.captcha_verify_container`, `.secsdk-captcha-drag-icon`, `#secsdk-captcha-drag-wrapper`, `.captcha_verify_img_slide`, `.captcha_verify_img--wrapper`, `.verify-captcha-submit-button`, `#verify-bar-close`, `span.secsdk_captcha_refresh--text` [gbiz123 #29 2025-05; scrapecreators 2025-08-31; eulerstream; tiktokautouploader]. The Douyin-style `iframe[src*="verifycenter/captcha"]` / `.vc-captcha-verify` may also apply (uncertain). Captcha texts include "Select 2 objects that are the same shape" and the slider "drag to fit the puzzle" prompt.
- **Failures:** "Something went wrong. You can try again or replace it with a different video.", the project/post `status_code` values above, and `{code: 7, Permission Denied}`.
- **Account restrictions:** TikTok exposes account status only through "Account check" in the app. Treat publish errors as a stop.
- **Region blocks:** the region-unavailable page (for example the Hong Kong discontinued notice).

**7. Preflight.** Sources disagree. The upload page itself says max 30 GB, 60 min, .mp4 recommended, 1080p/1440p/4K and 9:16 or 16:9 recommended [NoLang, checked 2026-11-18; flaghand 2026-10-28]. TikTok's help page says MP4 or WebM, 720×1280 or higher, up to 30 min, under 10 GB [speedrunsocial, checked 2026-11-12].

- **Video:** use the conservative limits: MP4 with H.264/AAC, under 10 GB, at most 30 min, at least 720×1280. Warn when the video is over 60 s, because Duet/Stitch get disabled.
- **Caption:** 2,200 characters. wkaisertexas still enforces 150, which is outdated.
- **Scheduling:** 15–20 minutes to 10 days ahead, in 5-minute steps, and it uses the *browser's* time zone [chenchen1010; README].

**8. Known breakages in 2025–2026.**
- Upload-page selectors changed in 2025; Post moved to `post_video_button` [#192, 2025-04].
- The schedule switch `#tux-1` disappeared [#224, 2025-09/10].
- "Continue to post?" was not handled [#225, 2025-10].
- New modals and the tour intercept clicks [#235/#237/#239, 2026-03–05].
- "Something went wrong" from Playwright Chromium [#238, 2026-04].
- Duet and Stitch merged into "Reuse of content", Enter on a hashtag inserts a line break, cover upload is silently discarded (bake the cover into a frame instead) [PR #242 and tiktokautouploader 2026].

PR #242 [2026-11-04, open, only partly live-tested] is the best current fix list. tiktokautouploader 6.x [master, "working as of Feb 2026"] has useful selectors, but it uses stealth and solves captchas, so don't copy those parts.

## Main sources
- github.com/wkaisertexas/tiktok-uploader (config.toml; issues #192, #224, #225, #237, #238, #239; PR #242)
- github.com/haziq-exe/TikTokAutoUploader `tiktokautouploader/function.py`
- github.com/Nagellabs/libi `mcp/skills/browser-posting/references/tiktok-studio.md`
- github.com/dreammis/social-auto-upload `uploader/tk_uploader/main_chrome.py`
- github.com/chenchen1010/tiktok-studio-scheduled-publish `tool/patches/README.md`
- github.com/jackwener/OpenCLI `clis/twitter/post.js`; issue #2024; PRs #666, #1180, #1511
- github.com/aden-hive/hive x-automation SKILL.md
- github.com/anton-abyzov/social-media-posting-skill SKILL.md
- chatoverflow.dev (2026-11-05, 2026-11-12)
- developer.chrome.com/blog/remote-debugging-port
- help.x.com/en/using-x/x-videos (via hubstudio and clapr)
- support.tiktok.com creator-tools pages (via speedrunsocial and superdirector)
- urlscan captures of X's JS bundle
- github.com/cv-cat/tiktokapis `api/tiktok_web.py`