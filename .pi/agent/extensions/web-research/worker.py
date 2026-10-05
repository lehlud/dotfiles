"""Trusted read-only web operations, executed only inside the approved sandbox."""
import http.client
import ipaddress
import json
import re
import socket
import ssl
import sys
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

sys.path.insert(0, "/opt/pi-web/dependencies")
MAX_BYTES = 2_000_000


def public_url(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ValueError("Only public HTTP(S) URLs without credentials are supported")
    if any(ord(char) < 33 for char in url):
        raise ValueError("Invalid URL")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    addresses = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError("Local and private network URLs are not supported")
    return parts, port, addresses


def download(url):
    for _ in range(6):
        parts, port, addresses = public_url(url)
        connection = http.client.HTTPConnection(parts.hostname, port, timeout=20)
        try:
            # Pin the validated address, including redirects, to prevent DNS rebinding.
            connection.sock = socket.create_connection(addresses[0][4][:2], timeout=20)
            if parts.scheme == "https":
                import certifi

                connection.sock = ssl.create_default_context(cafile=certifi.where()).wrap_socket(connection.sock, server_hostname=parts.hostname)
            path = urlunsplit(("", "", quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~"), quote(parts.query, safe="%:@!$&'()*+,;=/?-._~"), ""))
            connection.request("GET", path, headers={"User-Agent": "Pi-Web-Research/0.1", "Accept-Encoding": "identity", "Accept": "text/html,text/plain,application/xhtml+xml"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise ValueError("Redirect has no destination")
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise ValueError(f"HTTP {response.status}")
            media = response.headers.get_content_type()
            if media not in ("text/html", "text/plain", "application/xhtml+xml"):
                raise ValueError(f"Unsupported page type: {media}; HTML and plain text only")
            if response.getheader("Content-Encoding", "identity") != "identity":
                raise ValueError("Unsupported compressed response")
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("Page exceeds the 2 MB download limit")
            return body, response.headers.get_content_charset(), media, url
        finally:
            connection.close()
    raise ValueError("Too many redirects")


def clean_html(body):
    import trafilatura
    from lxml import html

    tree = html.fromstring(body)
    for node in tree.xpath("//script|//style|//nav|//footer|//aside|//form|//noscript|//svg"):
        node.drop_tree()
    text = trafilatura.extract(tree, output_format="txt", include_comments=False, include_links=False, include_images=False, include_tables=True)
    return (text or trafilatura.html2txt(tree)).strip()


def fetch_page(args):
    body, charset, media, final_url = download(args["url"])
    if media == "text/plain":
        text = body.decode(charset or "utf-8", errors="replace").strip()
    else:
        text = clean_html(body.decode(charset, errors="replace") if charset else body)
    if not text:
        raise ValueError("No readable page text found; JavaScript is not executed")
    offset, limit = args.get("offset", 0), args.get("maxChars", 20000)
    if offset >= len(text):
        raise ValueError("Offset is beyond the extracted page text")
    end = min(len(text), offset + limit)
    return {"text": text[offset:end], "details": {"finalUrl": final_url, "totalChars": len(text), "hasMore": end < len(text), "nextOffset": end if end < len(text) else None}}


def search(args):
    from ddgs import DDGS

    results = DDGS(timeout=15).text(args["query"], max_results=args.get("maxResults", 5), region=args.get("region", "wt-wt"), timelimit=args.get("timeLimit"), backend="auto")
    lines = []
    for item in results[:args.get("maxResults", 5)]:
        if not item.get("href", "").startswith(("https://", "http://")):
            continue
        compact = lambda text: re.sub(r"\s+", " ", str(text)).strip()
        lines.append(f"{compact(item.get('title', ''))[:300]}\n{item['href'][:8000]}\n{compact(item.get('body', ''))[:600]}")
    return {"text": "\n\n".join(lines) or "No search results.", "details": {"count": len(lines), "engine": "ddgs"}}


def main():
    try:
        raw = sys.stdin.buffer.read(100001)
        if len(raw) > 100000:
            raise ValueError("Web request exceeds input limit")
        request = json.loads(raw)
        operation = {"websearch": search, "webfetch": fetch_page}[request["tool"]]
        result = operation(request["arguments"])
    except Exception as error:
        result = {"text": str(error)[:2000], "details": {}, "error": True}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
