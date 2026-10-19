"""Helpers for developer smoke tests of the browser account-selection flow."""
import os
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse


class Forms(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.forms = []
        self.current = None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.current = {"action": attrs.get("action", ""), "data": {}}
            self.forms.append(self.current)
        elif tag == "input" and self.current is not None and attrs.get("name"):
            self.current["data"][attrs["name"]] = attrs.get("value", "")

    def handle_endtag(self, tag):
        if tag == "form":
            self.current = None


def complete_selection(session, base, location, password):
    """Select an already-connected account; never create apps or grant permissions.

    With multiple accounts FEISHU_ACCOUNT_ID must select the intended test account.
    Normal end users use the browser; this helper is only for automated smoke tests.
    """
    base_origin = urlparse(base)
    for _ in range(6):
        url = urljoin(base, location)
        parsed = urlparse(url)
        if (parsed.scheme, parsed.netloc) != (base_origin.scheme, base_origin.netloc):
            raise RuntimeError("Unexpected redirect outside the test server before account selection")
        response = session.get(url, allow_redirects=False, timeout=30)
        if response.status_code in (302, 303):
            location = response.headers["Location"]
            continue
        response.raise_for_status()
        forms = Forms(response.text).forms
        login = next((form for form in forms if form["action"] == "/login/demo"), None)
        if login:
            data = {**login["data"], "password": password}
            response = session.post(urljoin(base, login["action"]), data=data, allow_redirects=False, timeout=30)
            response.raise_for_status()
            location = response.headers["Location"]
            continue
        choices = [form for form in forms if form["action"].endswith("/select")]
        target = os.environ.get("FEISHU_ACCOUNT_ID")
        if target:
            choices = [form for form in choices if form["data"].get("account_id") == target]
        if len(choices) != 1:
            raise RuntimeError("先在浏览器连接飞书账号；多个账号时用 FEISHU_ACCOUNT_ID 指定本次测试身份。")
        selected = choices[0]
        response = session.post(urljoin(base, selected["action"]), data=selected["data"], allow_redirects=False, timeout=40)
        response.raise_for_status()
        if response.status_code != 303:
            raise RuntimeError("Account confirmation did not finish OAuth")
        return response.headers["Location"]
    raise RuntimeError("Too many redirects in browser login flow")
