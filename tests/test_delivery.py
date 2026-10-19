"""The delivery worker: transient relay failures are retried with the same
event id, and a relay 401 is recorded on the pairing for `status`."""

import http.server
import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import types
import urllib.error

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]

if "hermes_constants" not in sys.modules:
    _hermes_constants = types.ModuleType("hermes_constants")
    _hermes_constants.get_hermes_home = lambda: pathlib.Path(tempfile.gettempdir())
    sys.modules["hermes_constants"] = _hermes_constants
if "conduit_push" not in sys.modules:
    _pkg = types.ModuleType("conduit_push")
    _pkg.__path__ = [str(ROOT)]
    sys.modules["conduit_push"] = _pkg


def _private_copy(name, path):
    # A private copy: other test files replace functions on the shared modules.
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client = _private_copy("conduit_push._client_delivery_under_test", ROOT / "client.py")
cli = _private_copy("conduit_push._cli_delivery_under_test", ROOT / "cli.py")
api = _private_copy("conduit_plugin_api_delivery", ROOT / "dashboard" / "plugin_api.py")
e2e = client.e2e

KID = "0123456789abcdef0123456789abcdef"
SECRET = bytes(range(32))


class _Relay:
    """A local relay that answers /v1/events with the given statuses in turn
    (200 once they run out) and records the event ids it was sent."""

    def __init__(self, statuses):
        self.statuses = list(statuses)
        self.event_ids = []
        relay = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                relay.event_ids.append(body.get("event_id"))
                status = relay.statuses.pop(0) if relay.statuses else 200
                answer = json.dumps({"accepted": True} if status < 300 else {"error": "nope"}).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(answer)))
                self.end_headers()
                self.wfile.write(answer)

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def paired(tmp_path, monkeypatch):
    path = tmp_path / "conduit-push.json"
    monkeypatch.setattr(client, "state_path", lambda: path)
    monkeypatch.setattr(cli, "load_state", client.load_state)
    monkeypatch.setattr(api, "_pairing_state_path", lambda: path)
    # Retries without the real waits.
    monkeypatch.setattr(client, "RETRY_DELAYS", (0.01, 0.01, 0.01), raising=False)
    relays = []

    def pair(statuses, **extra):
        relay = _Relay(statuses)
        relays.append(relay)
        state = {"credential": "inst.gw.secret", "installation_id": "inst", "gateway_id": "gw",
                 "gateway_name": "box", "relay_url": relay.url}
        state.update(extra)
        client.save_state(state)
        return relay

    yield pair
    for relay in relays:
        relay.close()


def _deliver(event):
    assert client.enqueue(event)
    client._events.join()


def _event():
    return {"event_id": "response:0123456789abcdef", "type": "response.ready", "title": "Hermes", "body": "Done."}


@pytest.mark.parametrize("encrypted", [False, True], ids=["plain", "encrypted"])
@pytest.mark.parametrize("failures", [[503, 503], [429], [408, 502, 504]])
def test_a_transient_relay_failure_is_sent_again_with_the_same_event_id(paired, failures, encrypted):
    extra = {"e2e": {"kid": KID, "secret": e2e.b64u(SECRET)}} if encrypted else {}
    relay = paired(failures, **extra)

    _deliver(_event())

    assert len(relay.event_ids) == len(failures) + 1
    assert len(set(relay.event_ids)) == 1  # the relay dedupes the repeats


@pytest.mark.parametrize("status", [400, 403, 404, 413])
def test_a_definitive_refusal_is_not_sent_again(paired, status):
    relay = paired([status, status])

    _deliver(_event())

    assert len(relay.event_ids) == 1
    assert "relay_rejected_at" not in client.load_state()


def test_no_connection_is_retried_like_a_relay_failure(paired, monkeypatch):
    relay = paired([])
    real_request = client._request
    failures = [urllib.error.URLError(ConnectionRefusedError(61, "refused")), TimeoutError("timed out")]

    def flaky(url, **kwargs):
        if failures:
            raise failures.pop(0)
        return real_request(url, **kwargs)

    monkeypatch.setattr(client, "_request", flaky)
    _deliver(_event())

    assert len(relay.event_ids) == 1 and not failures


def test_retries_give_up_after_the_budget(paired, monkeypatch):
    relay = paired([503] * 10)
    monkeypatch.setattr(client, "RETRY_DELAYS", (1.0, 2.0, 4.0))
    monkeypatch.setattr(client, "RETRY_BUDGET", 2.5)
    now = [0.0]

    assert client._deliver(_event(), sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
                           clock=lambda: now[0]) is False

    # 1 s and then 2 s would go past 2.5 s: the first send and one retry.
    assert len(relay.event_ids) == 2


def test_a_relay_401_is_recorded_for_status_and_keeps_the_pairing(paired, capsys):
    relay = paired([401], redact_content=True, redact_key="k" * 64)

    _deliver(_event())

    assert len(relay.event_ids) == 1  # a 401 is not retried
    state = client.load_state()
    assert state["relay_rejected_at"]
    assert state["credential"] == "inst.gw.secret" and state["redact_key"] == "k" * 64
    assert api.e2e_status()["relay_rejected"] is True
    assert cli.dispatch(types.SimpleNamespace(conduit_push_action="status")) == 0
    assert "relay refused this pairing's credential" in capsys.readouterr().out

    # The relay knows the gateway again (restored data): the mark goes.
    _deliver(_event())

    assert "relay_rejected_at" not in client.load_state()
    assert api.e2e_status()["relay_rejected"] is False
    assert cli.dispatch(types.SimpleNamespace(conduit_push_action="status")) == 0
    assert "relay refused" not in capsys.readouterr().out


def test_a_401_does_not_mark_a_pairing_made_meanwhile(paired, monkeypatch):
    paired([401])
    real_request = client._request

    def re_paired_during_the_send(url, **kwargs):
        # The phone pairs this profile again while the old credential's
        # delivery is on its way and gets refused.
        state = client.load_state()
        client.save_state({**state, "credential": "inst.gw2.new", "gateway_id": "gw2"})
        return real_request(url, **kwargs)

    monkeypatch.setattr(client, "_request", re_paired_during_the_send)
    _deliver(_event())

    state = client.load_state()
    assert state["credential"] == "inst.gw2.new"
    assert "relay_rejected_at" not in state


def test_a_profile_unpaired_between_retries_stops_retrying(paired, monkeypatch):
    relay = paired([503, 503])
    real_request = client._request

    def unpair_after_first(url, **kwargs):
        try:
            return real_request(url, **kwargs)
        finally:
            client.remove_state()

    monkeypatch.setattr(client, "_request", unpair_after_first)
    _deliver(_event())

    assert len(relay.event_ids) == 1
