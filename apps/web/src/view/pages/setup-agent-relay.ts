// This source is embedded in the installer so the Agent machine needs only Python 3.
export const relay = String.raw`import json, os, re, stat, sys, threading
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_MESSAGE = 16 * 1024 * 1024

class RelayError(Exception):
    pass

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def parsed_url(url):
    parts = urlsplit(url)
    if (not parts.hostname or parts.username is not None or parts.password is not None
            or parts.query or parts.fragment or (parts.scheme != "https" and
            (parts.scheme != "http" or parts.hostname not in ("localhost", "127.0.0.1", "::1")))):
        raise RelayError("SmartSell 位址必須使用 HTTPS，或使用本機迴環 HTTP。")
    return parts

def private(path, mode, kind):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return kind(info.st_mode) and info.st_uid == os.getuid() and stat.S_IMODE(info.st_mode) == mode

def post(url, body, headers):
    opener = build_opener(ProxyHandler({}), NoRedirect())
    return opener.open(Request(url, json.dumps(body, allow_nan=False).encode(), headers), timeout=30)

def invalid_constant(_):
    raise ValueError("Invalid JSON number")

def object_json(raw):
    return json.loads(raw, parse_constant=invalid_constant)

def response_objects(response):
    media_type = response.headers.get_content_type()
    if media_type == "application/json":
        raw = response.read(MAX_MESSAGE + 1)
        if len(raw) > MAX_MESSAGE:
            raise RelayError("SmartSell 回應過大。")
        yield object_json(raw)
    elif media_type == "text/event-stream":
        data = []
        size = 0
        while True:
            raw = response.readline(MAX_MESSAGE + 1)
            if not raw:
                break
            if len(raw) > MAX_MESSAGE:
                raise RelayError("SmartSell SSE 回應過大。")
            line = raw.rstrip(b"\r\n")
            if not line:
                if data:
                    yield object_json(b"\n".join(data))
                    data = []
                    size = 0
            elif line.startswith(b"data:"):
                value = line[5:].removeprefix(b" ")
                size += len(value) + 1
                if size > MAX_MESSAGE:
                    raise RelayError("SmartSell SSE 回應過大。")
                data.append(value)
    else:
        raise RelayError("SmartSell 回應的 Content-Type 不符。請核對 MCP 位址與反向代理。")

def valid_id(value):
    return isinstance(value, str) or (type(value) is int and abs(value) < 2 ** 53)

def envelope(message):
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return False
    if "id" in message and not valid_id(message["id"]):
        return False
    if "method" in message:
        return (isinstance(message["method"], str) and bool(message["method"])
                and ("params" not in message or isinstance(message["params"], (dict, list)))
                and "result" not in message and "error" not in message)
    error = message.get("error")
    return ("id" in message and "params" not in message and
            (("result" in message and "error" not in message) or ("result" not in message and
            isinstance(error, dict) and type(error.get("code")) is int and isinstance(error.get("message"), str))))

def http_error(status):
    if status == 401:
        return "SmartSell 拒絕此連線（401）。請在 Web 確認連線是否到期或撤銷。"
    if status == 403:
        return "SmartSell 拒絕授權（403）。請在 Web 確認工作區與此連線的權限。"
    if status == 404:
        return "SmartSell MCP 位址或工作階段不存在（404）。請核對位址並重開客戶端。"
    if 300 <= status < 400:
        return "SmartSell MCP 位址回傳重新導向。請使用最終的 HTTPS MCP 位址。"
    return "SmartSell MCP 回傳 HTTP " + str(status) + "。請確認服務狀態並重試。"

class Connection:
    def __init__(self, url, token):
        self.url = url
        self.token = token
        self.session = None
        self.version = None

    def send(self, message, emit):
        call = "method" in message and "id" in message
        message_id = message.get("id")
        initialize = message.get("method") == "initialize"
        headers = {"Authorization": "Bearer " + self.token, "Content-Type": "application/json",
                   "Accept": "application/json, text/event-stream"}
        if not initialize:
            if self.session:
                headers["Mcp-Session-Id"] = self.session
            if self.version:
                headers["MCP-Protocol-Version"] = self.version
        try:
            with post(self.url, message, headers) as response:
                if not call:
                    if response.status not in (202, 204):
                        raise RelayError("SmartSell 未接受 MCP 通知。")
                    return
                for item in response_objects(response):
                    if not envelope(item):
                        raise RelayError("SmartSell 回傳無效的 JSON-RPC 訊息。")
                    if "method" in item:
                        emit(item)
                        continue
                    if type(item["id"]) is not type(message_id) or item["id"] != message_id:
                        raise RelayError("SmartSell 回應的 JSON-RPC ID 不符。")
                    if initialize and "result" in item:
                        result = item["result"]
                        if (not isinstance(result, dict) or not isinstance(result.get("serverInfo"), dict)
                                or result["serverInfo"].get("name") != "smartsell"
                                or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", result.get("protocolVersion", ""))):
                            raise RelayError("此 MCP 位址未回傳有效的 SmartSell 初始化結果。")
                        session = response.headers.get("Mcp-Session-Id")
                        if session and not re.fullmatch(r"[!-~]{1,512}", session):
                            raise RelayError("SmartSell 回傳無效的 MCP 工作階段。")
                        self.session, self.version = session, result["protocolVersion"]
                    emit(item)
                    return
                raise RelayError("SmartSell 未回傳此 MCP 請求的結果。")
        except HTTPError as error:
            error.close()
            raise RelayError(http_error(error.code)) from None
        except (HTTPException, OSError, ValueError, TypeError, RecursionError):
            raise RelayError("無法讀取 SmartSell MCP 回應。請檢查服務、網路及 TLS 憑證。") from None

def run_relay(url, secret, connection_dir):
    parts = parsed_url(url)
    if parts.path != "/mcp":
        raise RelayError("SmartSell MCP 路徑必須是 /mcp。")
    if not private(connection_dir, 0o700, stat.S_ISDIR) or not private(secret, 0o600, stat.S_ISREG):
        raise RelayError("此連線的本機憑證不存在，或檔案權限有誤（目錄 0700、檔案 0600）。")
    fd = os.open(secret, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, encoding="ascii") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
            raise RelayError("此連線的本機憑證檔案權限有誤。")
        token = file.read(512).strip()
    if not re.fullmatch(r"ss_command_[A-Za-z0-9_-]{60,500}", token):
        raise RelayError("此連線的本機憑證格式有誤。")
    connection = Connection(url, token)
    write_lock = threading.Lock()

    def emit(message):
        with write_lock:
            print(json.dumps(message, ensure_ascii=True), flush=True)

    def forward(message):
        try:
            connection.send(message, emit)
        except RelayError as error:
            if "method" in message and "id" in message:
                emit({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32000, "message": str(error)}})
            print("SmartSell relay: " + str(error), file=sys.stderr)

    with ThreadPoolExecutor(max_workers=4) as pool:
        while True:
            line = sys.stdin.buffer.readline(MAX_MESSAGE + 1)
            if not line:
                break
            try:
                message = object_json(line) if len(line) <= MAX_MESSAGE else None
            except (ValueError, RecursionError):
                message = None
            if not envelope(message):
                emit({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid MCP request"}})
                if len(line) > MAX_MESSAGE:
                    break
            elif message.get("method") in ("initialize", "notifications/initialized"):
                forward(message)
            else:
                pool.submit(forward, message)
`;
