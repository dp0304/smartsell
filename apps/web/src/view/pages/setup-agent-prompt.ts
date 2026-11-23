import type { AgentEnrollment } from '../data/types';
import { relay } from './setup-agent-relay';
import { codexRouting, previousCodexRouting } from './setup-codex-routing';

const install = String.raw`import getpass, shutil, subprocess, warnings


def client_command(args):
    return subprocess.run([executable, "mcp", *args], stdin=subprocess.DEVNULL, capture_output=True, timeout=30)


def existing_registration():
    result = client_command(["get", server, "--json"])
    if result.returncode:
        raise RelayError("找不到這筆 Codex 註冊。請在原先接入的機器與 Codex 設定環境執行。")
    registration = object_json(result.stdout)
    if registration.get("enabled") is not True:
        raise RelayError("這筆 Codex 註冊已停用。請先在 Codex 啟用該連線。")
    return registration


def legacy_secrets(home):
    env_name = "SMARTSELL_" + server.replace("-", "_").upper()
    return [directory / env_name for directory in home.glob(".smartsell-????????")
            if private(directory, 0o700, stat.S_ISDIR) and private(directory / env_name, 0o600, stat.S_ISREG)]


def repair_credential(home, registration):
    if any(registration.get(key) is not None for key in
           ("enabled_tools", "disabled_tools", "startup_timeout_sec", "tool_timeout_sec")):
        raise RelayError("這筆舊版註冊含有自訂設定。請先核對原註冊，避免覆寫這些設定。")
    env_name = "SMARTSELL_" + server.replace("-", "_").upper()
    transport = registration.get("transport", {})
    if (transport.get("type") != "streamable_http" or transport.get("url") != mcp_url
            or transport.get("bearer_token_env_var") != env_name
            or any(transport.get(field) for field in ("http_headers", "env_http_headers", "http_headers_helper"))):
        raise RelayError("這筆註冊與舊版 SmartSell 位址或設定不符，已停止。請先核對連線 ID 和位址。")
    matches = legacy_secrets(home)
    if len(matches) != 1:
        raise RelayError("找不到唯一且權限正確的舊版憑證。請在原機器修復，或在 Web 建立新連線。")
    return matches[0]


def redeem(endpoint):
    redeem_parts = parsed_url(redeem_url)
    if (redeem_parts.netloc != endpoint.netloc or redeem_parts.scheme != endpoint.scheme or not re.fullmatch(
            r"/api/v1/workspaces/[a-f0-9-]{36}/agent-connections/redeem", redeem_parts.path)):
        raise RelayError("接入碼兌換位址與 SmartSell MCP 不符。請從 Web 重新取得接入指令。")
    try:
        with open("/dev/tty", "w") as terminal, warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            code = getpass.getpass("貼上一次性接入碼（不會顯示）：", stream=terminal).strip()
    except (OSError, EOFError, getpass.GetPassWarning):
        raise RelayError("請在本機互動式終端機執行，並在隱藏輸入提示出現後貼上接入碼。") from None
    if not re.fullmatch(r"[A-Za-z0-9_-]{100,512}", code):
        raise RelayError("接入碼格式不符。請從 Web 複製完整的一次性接入碼。")
    try:
        with post(redeem_url, {"code": code}, {"Content-Type": "application/json", "Accept": "application/json"}) as response:
            if response.headers.get_content_type() != "application/json":
                raise RelayError("兌換回應的 Content-Type 不符。請核對 SmartSell 位址。")
            token = object_json(response.read(4096))["data"]["token"]
    except HTTPError as error:
        error.close()
        if error.code == 401:
            raise RelayError("接入碼無效、過期或已使用（401）。若尚未保存憑證，請從 Web 產生新指令與接入碼。") from None
        raise RelayError(http_error(error.code)) from None
    if not isinstance(token, str) or not re.fullmatch(r"ss_command_[A-Za-z0-9_-]{60,500}", token):
        raise RelayError("SmartSell 未回傳有效的接入憑證。請檢查服務後重新產生接入碼。")
    return token


def source_for(secret):
    return relay_source + "\ntry:\n    run_relay(" + repr(mcp_url) + ", Path(" + repr(str(secret)) + "), Path(" + repr(str(secret.parent)) + "))\nexcept (RelayError, OSError, ValueError) as error:\n    sys.exit('SmartSell relay: ' + (str(error) if isinstance(error, RelayError) else '本機憑證無法讀取。'))\n"


def verify_stdio(directory, registration):
    transport = registration.get("transport", {})
    script = directory / "relay.py"
    command = transport.get("command")
    if (not isinstance(command, str) or not Path(command).is_absolute() or not os.access(command, os.X_OK)
            or transport.get("args") != ["-I", str(script)]
            or any(transport.get(key) for key in ("env", "env_vars", "cwd"))
            or not private(directory, 0o700, stat.S_ISDIR) or not private(script, 0o600, stat.S_ISREG)):
        raise RelayError("這筆 stdio 註冊與 SmartSell relay 不符。請在原機器核對這筆連線。")
    # Compare the relay to the known source and exact URL. No credential is opened by this repair path.
    source = script.read_text(encoding="utf-8")
    candidates = [directory / "bearer", *legacy_secrets(directory.parent)]
    if not any(private(secret, 0o600, stat.S_ISREG) and source == source_for(secret) for secret in candidates):
        raise RelayError("這筆 relay 的來源、MCP 位址或私有憑證檔案權限不符。請核對原連線。")


def install_codex_routing():
    import fcntl, tempfile

    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex").expanduser()
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = home / "AGENTS.md"
    override = home / "AGENTS.override.md"
    flags = os.O_NOFOLLOW | os.O_NONBLOCK
    try:
        fd = os.open(override, os.O_RDONLY | flags)
    except FileNotFoundError:
        pass
    else:
        with os.fdopen(fd, "rb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                raise RelayError("CODEX_HOME 的 AGENTS.override.md 必須是一般檔案。")
            if file.read().strip():
                path = override
    block = codex_routing.encode("utf-8")
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND | flags, 0o600)
    except OSError:
        raise RelayError("無法更新 CODEX_HOME 的 Codex 規則。請檢查檔案權限或符號連結。") from None
    with os.fdopen(fd, "r+b") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RelayError("Codex 規則須為目前使用者擁有的一般檔案。")
        fcntl.flock(file.fileno(), fcntl.LOCK_EX)
        info = os.fstat(file.fileno())
        if not os.path.samestat(path.lstat(), info):
            raise RelayError("Codex 規則檔剛被更新，請重試同一指令。")
        content = file.read()
        begin, end = block.splitlines()[0], block.splitlines()[-1]
        marks = (content.count(begin), content.count(end))
        if marks == (0, 0):
            file.write((b"\n\n" if content else b"") + block + b"\n")
            return
        if marks == (1, 1):
            if re.search(b"^" + re.escape(block) + b"$", content, re.MULTILINE):
                return
            old = re.search(b"^" + re.escape(previous_codex_routing.encode("utf-8")) + b"$", content, re.MULTILINE)
            if old:
                updated = content[:old.start()] + block + content[old.end():]
                with tempfile.NamedTemporaryFile(dir=home, prefix=".smartsell-routing-", delete=False) as temp:
                    temporary = Path(temp.name)
                    try:
                        temp.write(updated)
                        temp.flush()
                        os.fchmod(temp.fileno(), stat.S_IMODE(info.st_mode))
                        os.fsync(temp.fileno())
                        current = path.lstat()
                        if (not os.path.samestat(current, info) or
                                (current.st_size, current.st_mtime_ns, current.st_ctime_ns) !=
                                (info.st_size, info.st_mtime_ns, info.st_ctime_ns)):
                            raise RelayError("Codex 規則檔剛被更新，請重試同一指令。")
                        os.replace(temporary, path)
                    finally:
                        temporary.unlink(missing_ok=True)
                return
        raise RelayError("SmartSell 路由標記已被編輯或重複，已保留原文。")


def prepare_relay(directory, secret, endpoint):
    script = directory / "relay.py"
    # The old bearer stays in its original private directory. Only the relay ever opens it.
    source = source_for(secret)
    directory.mkdir(mode=0o700, exist_ok=True)
    if not private(directory, 0o700, stat.S_ISDIR):
        raise RelayError("本機連線目錄權限不符（需 0700）。請檢查此連線的本機安裝。")
    if os.path.lexists(script):
        if not private(script, 0o600, stat.S_ISREG) or script.read_text(encoding="utf-8") != source:
            raise RelayError("同名 relay 已存在但內容不同。請核對此連線的本機安裝。")
    else:
        with script.open("x", encoding="utf-8") as file:
            file.write(source)
    if not repairing and not os.path.lexists(secret):
        # Reserve a private file before consuming the single-use code, and remove an empty reservation on failure.
        with secret.open("x", encoding="ascii") as file:
            try:
                file.write(redeem(endpoint))
            except BaseException:
                secret.unlink()
                raise
    return [sys.executable, "-I", str(script)]


def preflight(command):
    requests = [
        {"method": "initialize", "id": 1, "params": {"protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "SmartSell setup preflight", "version": "2"}}},
        {"method": "notifications/initialized"},
        {"method": "tools/list", "id": 2, "params": {}},
    ]
    result = subprocess.run(command, input="".join(json.dumps({"jsonrpc": "2.0", **m}) + "\n" for m in requests),
                            text=True, capture_output=True, timeout=100)
    for line in result.stderr.splitlines():
        if line.startswith("SmartSell relay: "):
            raise RelayError("MCP 預檢失敗。" + line.removeprefix("SmartSell relay: "))
    responses = {msg.get("id"): msg.get("result") for msg in map(object_json, result.stdout.splitlines()) if "method" not in msg}
    tools = (responses.get(2) or {}).get("tools", [])
    if (result.returncode or result.stderr or not responses.get(1) or not any(
            isinstance(tool, dict) and tool.get("name") == "smartsell_operations_describe" for tool in tools)):
        raise RelayError("MCP 預檢未通過。請確認服務位址、TLS、連線是否到期及工作區權限，再執行同一區塊重試。")


try:
    os.umask(0o077)
    if sys.version_info < (3, 9):
        raise RelayError("請安裝 Python 3.9 或更新版本後重試。")
    endpoint = parsed_url(mcp_url)
    if endpoint.path != "/mcp" or not re.fullmatch(r"smartsell-[a-f0-9]{32}", server):
        raise RelayError("SmartSell MCP 路徑或連線 ID 不符。請從 Web 重新複製指令。")
    executable = shutil.which(client)
    if not executable and client == "codex":
        bundled = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
        executable = bundled if os.access(bundled, os.X_OK) else None
    if not executable:
        raise RelayError("找不到 " + client + "。請安裝所選客戶端的 CLI，並從本機終端機重試。")
    directory = Path.home() / ("." + server)
    registration = existing_registration() if repairing else {}
    if registration.get("transport", {}).get("type") == "stdio":
        verify_stdio(directory, registration)
        print("已核對 " + server + " 的現有 stdio 註冊。")
    else:
        secret = repair_credential(directory.parent, registration) if repairing else directory / "bearer"
        command = prepare_relay(directory, secret, endpoint)
        preflight(command)
        args = (["add", server, "--"] if client == "codex"
                else ["add", "--transport", "stdio", "--scope", "user", server, "--"])
        if client_command(args + command).returncode:
            raise RelayError("本機 MCP 註冊失敗。請確認所選 CLI 支援使用者層級 stdio 註冊，並在原設定環境重試。")
        print("已註冊 " + server + "。MCP 預檢通過。")
    if client == "codex":
        install_codex_routing()
        print("Codex 的 SmartSell 社媒路由規則已就緒。")
    print("請完整退出並重開客戶端，從此註冊呼叫 smartsell_operations_describe，再回 Web 重新檢查狀態。")
except RelayError as error:
    sys.exit(str(error))
except (HTTPException, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
    sys.exit("無法完成本機接入。請確認本機檔案權限、SmartSell 網路及 TLS 憑證後重試。")`;

function commandBlock(id: string, mcpUrl: string, client: 'codex' | 'claude_code', redeemUrl?: string) {
  return ["python3 -I - <<'SMARTSELL_SETUP'", '# -*- coding: utf-8 -*-', `client = ${JSON.stringify(client === 'codex' ? 'codex' : 'claude')}`,
    `server = ${JSON.stringify(`smartsell-${id.replaceAll('-', '')}`)}`, `mcp_url = ${JSON.stringify(mcpUrl)}`,
    `redeem_url = ${JSON.stringify(redeemUrl ?? '')}`, `repairing = ${redeemUrl ? 'False' : 'True'}`,
    `codex_routing = ${JSON.stringify(codexRouting)}`, `previous_codex_routing = ${JSON.stringify(previousCodexRouting)}`,
    `relay_source = ${JSON.stringify(relay)}`,
    'exec(compile(relay_source, "<SmartSell relay>", "exec"))', install, 'SMARTSELL_SETUP'].join('\n');
}

export function agentEnrollmentPrompt(data: AgentEnrollment) {
  return commandBlock(data.id, data.mcp_url, data.client, data.redeem_url);
}

export function agentRepairCommand(id: string, mcpUrl: string) {
  return commandBlock(id, mcpUrl, 'codex');
}

export function agentCheckPrompt(english: boolean, id?: string) {
  const registration = id ? `smartsell-${id.replaceAll('-', '')}` : 'SmartSell';
  return english
    ? `Find the ${registration} MCP tools in this client’s tool search and call smartsell_operations_describe with empty arguments. Use the client’s native MCP tools only. If discovery fails, report the exact error and ask me to fully quit and reopen the client. If permission is denied or the connection is expired or revoked, report the exact blocker. After a successful native call, ask me to return to SmartSell and select “Check status again.”`
    : `請在此客戶端的工具搜尋中找到 ${registration} 的 MCP 工具，並用空參數呼叫 smartsell_operations_describe。只使用此客戶端原生載入的 MCP 工具。若找不到工具，請回報具體錯誤，並請我完整退出後重開客戶端。若授權不足、連線到期或被撤銷，請明確回報原因。原生工具呼叫成功後，請我回 SmartSell 按「重新檢查狀態」。`;
}
