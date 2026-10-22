"""Voice chats archived at call end come back once used (hermes-conduit#1124)."""
import importlib.util
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location("conduit_voice_archive", ROOT / "voice_archive.py")
voice_archive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(voice_archive)


def _home(tmp_path, rows, tags):
    conn = sqlite3.connect(tmp_path / "state.db")
    conn.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, archived INTEGER, auto_archived INTEGER)")
    conn.execute("CREATE TABLE state_meta (key TEXT PRIMARY KEY, value TEXT)")
    conn.executemany("INSERT INTO sessions VALUES (?, ?, ?)", rows)
    conn.execute("INSERT INTO state_meta VALUES (?, ?)", (voice_archive.VOICE_TAGS_KEY, json.dumps(tags)))
    conn.commit()
    conn.close()
    return tmp_path


class FakeSessionDB:
    """Hermes' write path: its reopen un-archives what the sweep stamped."""
    opened = 0

    def __init__(self, path):
        FakeSessionDB.opened += 1
        self.conn = sqlite3.connect(path)

    def _execute_write(self, fn):
        with self.conn:
            return fn(self.conn)

    @staticmethod
    def _unarchive_auto_archived_lineage(conn, session_id):
        return conn.execute("UPDATE sessions SET archived = 0, auto_archived = 0 "
                            "WHERE id = ? AND archived <> 0 AND auto_archived <> 0", (session_id,)).rowcount > 0

    def close(self):
        self.conn.close()


def _flags(home, session_id):
    conn = sqlite3.connect(home / "state.db")
    try:
        return conn.execute("SELECT archived, auto_archived FROM sessions WHERE id = ?", (session_id,)).fetchone()
    finally:
        conn.close()


def test_a_classic_chat_or_call_archived_at_call_end_comes_back(tmp_path):
    home = _home(tmp_path, [("classic", 1, 1), ("call", 1, 1)],
                 {"classic": {"kind": "classic"}, "call": {"kind": "call", "engine": "gpt-live"}})
    assert voice_archive.bring_back(home, "classic", open_db=FakeSessionDB)
    assert voice_archive.bring_back(home, "call", open_db=FakeSessionDB)
    assert _flags(home, "classic") == (0, 0) and _flags(home, "call") == (0, 0)


def test_other_rows_are_left_alone_without_opening_the_store_for_writes(tmp_path):
    home = _home(tmp_path, [
        ("live", 0, 0),          # most turns: not archived
        ("on-purpose", 1, 0),    # archived by someone
        ("swept", 1, 1),         # Hermes' idle sweep, not a voice chat
        ("job", 1, 1),           # a voice job keeps its own archive
    ], {"on-purpose": {"kind": "classic"}, "job": {"kind": "job"}})
    FakeSessionDB.opened = 0
    for session_id in ("live", "on-purpose", "swept", "job", "missing", ""):
        assert not voice_archive.bring_back(home, session_id, open_db=FakeSessionDB)
    assert FakeSessionDB.opened == 0
    assert _flags(home, "on-purpose") == (1, 0) and _flags(home, "swept") == (1, 1)


def test_a_missing_store_an_unreadable_tag_list_or_an_older_hermes_never_raise(tmp_path):
    assert not voice_archive.bring_back(tmp_path / "nowhere", "x", open_db=FakeSessionDB)
    home = _home(tmp_path, [("classic", 1, 1)], {})
    conn = sqlite3.connect(home / "state.db")
    conn.execute("UPDATE state_meta SET value = 'not json'")
    conn.commit()
    conn.close()
    assert not voice_archive.bring_back(home, "classic", open_db=FakeSessionDB)

    class OlderHermes:
        def __init__(self, path):
            pass

        def close(self):
            pass

    conn = sqlite3.connect(home / "state.db")
    conn.execute("UPDATE state_meta SET value = ?", (json.dumps({"classic": {"kind": "classic"}}),))
    conn.commit()
    conn.close()
    assert not voice_archive.bring_back(home, "classic", open_db=OlderHermes)
    assert _flags(home, "classic") == (1, 1)
