import importlib.util
import json
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import Mock, patch

source = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("worker", source / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
base = Path.home() / ".local/cache/pi-web-research" / ("linux-arm64" if __import__("platform").machine() == "aarch64" else "linux-x64")
sys.path.insert(0, json.loads((base / "runtime.json").read_text())["dependencies"])


class WorkerTests(unittest.TestCase):
    def address(self, ip):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))]

    def test_private_urls_and_credentials_are_rejected(self):
        for url in ["file:///etc/passwd", "https://user:secret@example.com", "http://example.com/\nheader"]:
            with self.assertRaises(ValueError):
                worker.public_url(url)
        for ip in ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1"]:
            with patch.object(socket, "getaddrinfo", return_value=self.address(ip)):
                with self.assertRaises(ValueError):
                    worker.public_url("https://example.com")

    def test_mixed_dns_answer_is_rejected(self):
        with patch.object(socket, "getaddrinfo", return_value=self.address("1.1.1.1") + self.address("127.0.0.1")):
            with self.assertRaises(ValueError):
                worker.public_url("https://example.com")

    def test_html_becomes_text_without_navigation_scripts_or_tags(self):
        page = '<html><head><style>secret-css</style></head><body><nav>Unwanted menu</nav><main><h1>Useful heading</h1><p>Readable &amp; useful content.</p><pre>print("hello")</pre></main><script>evil()</script><footer>Unwanted footer</footer></body></html>'
        result = worker.clean_html(page)
        self.assertIn("Readable & useful content.", result)
        self.assertIn('print("hello")', result)
        for excluded in ["Unwanted", "evil()", "secret-css", "<main>", "<p>"]:
            self.assertNotIn(excluded, result)

    def test_pagination_and_plain_text_encoding(self):
        with patch.object(worker, "download", return_value=(b"abcdefghij", "utf-8", "text/plain", "https://example.com/final")):
            result = worker.fetch_page({"url": "https://example.com", "offset": 3, "maxChars": 4})
            self.assertEqual(result["text"], "defg")
            self.assertEqual(result["details"]["nextOffset"], 7)
            self.assertTrue(result["details"]["hasMore"])
            with self.assertRaises(ValueError):
                worker.fetch_page({"url": "https://example.com", "offset": 20})

    def test_redirect_to_local_network_never_connects(self):
        response = Mock(status=302)
        response.getheader.return_value = "http://127.0.0.1/admin"
        connection = Mock()
        connection.getresponse.return_value = response
        answers = [self.address("1.1.1.1"), self.address("127.0.0.1")]
        with patch.object(socket, "getaddrinfo", side_effect=answers), patch.object(socket, "create_connection") as connect, patch.object(worker.http.client, "HTTPConnection", return_value=connection):
            with self.assertRaises(ValueError):
                worker.download("http://example.com")
            connect.assert_called_once_with(("1.1.1.1", 443), timeout=20)
            connection.close.assert_called_once()

    def test_download_limit_and_binary_response_fail_explicitly(self):
        response = Mock(status=200)
        response.getheader.return_value = "identity"
        response.headers.get_content_type.return_value = "application/pdf"
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(socket, "getaddrinfo", return_value=self.address("1.1.1.1")), patch.object(socket, "create_connection"), patch.object(worker.http.client, "HTTPConnection", return_value=connection):
            with self.assertRaisesRegex(ValueError, "Unsupported page type"):
                worker.download("http://example.com")
            response.headers.get_content_type.return_value = "text/plain"
            response.read.return_value = b"a" * (worker.MAX_BYTES + 1)
            with self.assertRaisesRegex(ValueError, "2 MB"):
                worker.download("http://example.com")

    def test_https_uses_bundled_ca_with_verified_hostname(self):
        import certifi

        response = Mock(status=200)
        response.getheader.return_value = "identity"
        response.headers.get_content_type.return_value = "text/plain"
        response.headers.get_content_charset.return_value = "utf-8"
        response.read.return_value = b"public text"
        connection = Mock()
        connection.getresponse.return_value = response
        with patch.object(socket, "getaddrinfo", return_value=self.address("1.1.1.1")), patch.object(socket, "create_connection") as connect, patch.object(worker.http.client, "HTTPConnection", return_value=connection), patch.object(worker.ssl, "create_default_context") as context:
            self.assertEqual(worker.download("https://example.com")[0], b"public text")
            context.assert_called_once_with(cafile=certifi.where())
            context.return_value.wrap_socket.assert_called_once_with(connect.return_value, server_hostname="example.com")


if __name__ == "__main__":
    unittest.main()
