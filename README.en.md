# SmartSell

[繁體中文](README.md)

SmartSell lets the AI assistant on your own computer (Codex, Claude Code or WorkBuddy) direct several of your computers to post on social media **inside your own, already signed-in Chrome**, and report the results back. A web dashboard shows what needs you today, every machine and account, the calendar and the outcome of every post.

**Who it is for:** solo sellers and creators (and small teams) with several social accounts spread over several computers, who want to say "post ~/Movies/video.mp4 tomorrow at 9:00 to X on Mac-B and TikTok on Win-C" instead of uploading by hand in each dashboard.

**Phase 1 does:** scheduled video posts to X and TikTok, published at the right time by the machine each account is bound to, with the post URL read back. Per account you choose "post when the agent says so" or "wait for my approval in the web app". Sign-in prompts, captchas and two-factor checks always stop and notify you; a post whose result is unknown is never re-posted automatically.

```
Laptop: Codex / Claude Code / WorkBuddy ──MCP──▶ Hub (an always-on computer at home, over Tailscale)
                                                  │ each account is bound to one machine
                                 ┌────────────────┴────────────────┐
                         SmartSell Worker on Mac-B          SmartSell Worker on Win-C
                         posts to X in your Chrome          posts to TikTok in your Chrome
```

> **Know the platform rules.** X's automation rules forbid scripting the website and TikTok's terms restrict automation; accounts can be limited or suspended. SmartSell never spoofs fingerprints, evades detection or solves captchas, and before the Worker may click "Post" for an account you confirm that risk for that account in the web app; otherwise the Worker prepares the post and waits for you to click. Whether and where to use it is your decision.

**License:** free for noncommercial use ([PolyForm Noncommercial 1.0.0](LICENSE.md)). Running accounts or a shop that make money, or operating accounts for clients, is commercial use and needs a separate commercial license; see [License](#license) below.

## Get the code

```sh
git clone https://github.com/dp0304/smartsell.git     # GitHub
git clone https://gitee.com/yueshutech/smartsell.git  # Gitee mirror (same content)
```

You need Node.js 24 and pnpm 10. The hub and the Worker installers are built from source; there are no prebuilt downloads yet.

## How to use phase 1

1. **Install the hub** on an always-on computer: `bash scripts/install-hub.sh` (see [docs/hub-setup.md](docs/hub-setup.md)); open the printed setup URL from a browser on your tailnet and create the owner account. The web app's setup wizard guides the rest.
2. **Build the Worker installer**: `pnpm worker:release` in the hub's checkout (macOS arm64 + x64; run `pnpm worker:release --win` on a Windows machine for win-x64) and place the output as described in docs/hub-setup.md §4. The installers are not code-signed yet.
3. **Pair each posting machine**: join the same tailnet, install and open the Worker, paste the hub address, name the machine and approve in the browser.
4. **Choose the browser**: "use my own Chrome" (recommended; install the SmartSell extension as the App shows, about a minute) or one separate Chrome profile per account. See [the Worker README](apps/connector-desktop/README.md).
5. **Add accounts** in the Worker (X or TikTok), then finish each account's checklist in the web app: approval mode, the click-Post risk confirmation, TikTok defaults, a dry run.
6. **Connect your AI assistant** with the laptop mode of the Worker App, or the Node relay (`curl -fsSL https://<hub>/agent/relay.mjs -o ~/.smartsell/relay.mjs`, then `codex mcp add smartsell -- node ~/.smartsell/relay.mjs --hub https://<hub> --token-file ~/.smartsell/token`, or `claude mcp add --scope user smartsell -- …` with the same arguments; WorkBuddy takes the same command as a stdio MCP entry).
7. **Ask** it to post. It reports each post's local time, machine, status and URL; approvals, risk confirmations, resuming and confirming results stay with you in the web app.

The agent sees 11 posting tools (`smartsell_overview`, `machines_list`, `channels_list`, `channel_check`, `media_upload`, `post_schedule`, `post_update`, `posts_list`, `post_get`, `task_get`, `publishing_pause`) and 3 remote-control tools (`browser_open`, `browser_act`, `phone_act`) that work only after you turn remote control on for a machine and list the allowed sites or apps: the agent then operates that machine's own Chrome or Android phone step by step (a store backend, say), and asks you before changing anything. Media never passes through the model: the relay uploads it in checked, resumable chunks, or a direct client runs one `curl` against a single-use upload URL.

## Develop

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm dev        # API on 127.0.0.1:3401, web on 127.0.0.1:5173
pnpm verify     # the same checks as CI
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and, for security reports, [SECURITY.md](SECURITY.md). The design of record is [docs/restructure/phase1-design.md](docs/restructure/phase1-design.md) (Traditional Chinese).

## License

SmartSell's source is public under the [PolyForm Noncommercial License 1.0.0](LICENSE.md); it is not an OSI open-source license. This summary is not the license; [the terms](LICENSE.md) govern.

- **Free:** any noncommercial purpose — personal study, research and testing, hobby projects with no commercial application, and use by charities, schools, public research organizations and government institutions. You may change and share it if you pass on the terms (or their URL) and the `Required Notice:` line.
- **Commercial license needed:** running accounts, a shop or a brand that make money, operating accounts for clients, or offering it (or a changed version) as a paid service. Open an issue on GitHub or Gitee titled "Commercial license" (no details needed) and we will contact you.
- Third-party packages keep their own licenses.
